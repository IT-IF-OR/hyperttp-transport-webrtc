import type {
  HyperTransport,
  LogLevel,
  TransportListenOptions,
  TransportRequest,
  TransportResponse,
  TransportServer,
} from "@hyperttp/types";
import {
  MAX_SIGNALING_BODY_BYTES,
  type ClientSession,
  type PendingResponse,
  type ServerSession,
  type WebRtcSessionView,
  type WebRtcTrackEvent,
  type WebRtcTransportOptions as InternalWebRtcTransportOptions,
  type WebRtcTransportRequest,
} from "./types/types.js";
import { abortError, decodeWireBody, encodeWireBody, errorFromUnknown } from "./utils/helper.js";
import { createServer, type Server as HttpServer } from "node:http";
import {
  MediaStream as WeriftMediaStream,
  RTCPeerConnection as WeriftPeerConnection,
  RTCDataChannel as WeriftDataChannel,
  type MediaStreamTrack as WeriftMediaStreamTrack,
} from "werift";

declare module "@hyperttp/types" {
  interface TransportServer {
    readonly webrtc?: Pick<WebRtcTransport, "getSession" | "getServerSession" | "onTrack">;
  }
}

type WeriftPeerConfig = NonNullable<ConstructorParameters<typeof WeriftPeerConnection>[0]>;
type WeriftIceServers = WeriftPeerConfig["iceServers"];

function normalizeIceServers(servers: RTCIceServer[] | undefined): WeriftIceServers {
  const normalized = (servers ?? []).flatMap((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    if (server.credential !== undefined && typeof server.credential !== "string") {
      throw new TypeError("Werift currently requires ICE server credentials to be strings.");
    }
    return urls.map((url) => ({
      urls: url,
      ...(server.username !== undefined ? { username: server.username } : {}),
      ...(server.credential !== undefined ? { credential: server.credential } : {}),
    }));
  });
  return normalized as unknown as WeriftIceServers;
}

function createWeriftPeerConnection(configuration: RTCConfiguration): WeriftPeerConnection {
  const config = {
    iceServers: normalizeIceServers(configuration.iceServers),
    ...(configuration.iceTransportPolicy !== undefined
      ? { iceTransportPolicy: configuration.iceTransportPolicy }
      : {}),
  } as unknown as WeriftPeerConfig;
  return new WeriftPeerConnection(config);
}

function createWeriftMediaStream(): WeriftMediaStream {
  return new WeriftMediaStream();
}

export type WebRtcTransportOptions = Omit<
  InternalWebRtcTransportOptions,
  "localStream" | "disposeLocalStream" | "createMediaStream"
> & {
  readonly localStream?: WeriftMediaStream | ((sessionId: string) => WeriftMediaStream | undefined);
  readonly disposeLocalStream?: (sessionId: string, stream: WeriftMediaStream) => void;
  readonly createMediaStream?: () => WeriftMediaStream;
  readonly logger?: (level: LogLevel, message: string, meta?: unknown) => void;
};

export interface WebRtcServerSessionView {
  readonly id: string;
  readonly peerConnection: WeriftPeerConnection;
  readonly remoteStream: WeriftMediaStream;
  readonly localStream?: WeriftMediaStream;
}

export interface WebRtcTransportServer extends TransportServer {
  readonly webrtc: Pick<WebRtcTransport, "getSession" | "getServerSession" | "onTrack">;
}

export class WebRtcTransport implements HyperTransport {
  private readonly sessions = new Map<string, ClientSession>();
  private readonly connecting = new Map<string, Promise<ClientSession>>();
  private readonly serverSessions = new Map<string, ServerSession>();
  private readonly trackListeners = new Set<(event: WebRtcTrackEvent) => void>();
  private readonly serverClosers = new Set<() => Promise<void>>();
  private requestSequence = 0;
  private closing = false;
  private readonly pendingPeers = new Set<WeriftPeerConnection>();
  private readonly iceServers: RTCIceServer[];
  private readonly iceGatheringTimeoutMs: number;
  private readonly signalingTimeoutMs: number;
  private readonly connectionTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  readonly createMediaStream: () => WeriftMediaStream;
  private readonly createPeerConnection: (configuration: RTCConfiguration) => WeriftPeerConnection;
  private readonly options: InternalWebRtcTransportOptions;

  constructor(options: WebRtcTransportOptions = {}) {
    this.options = options as unknown as InternalWebRtcTransportOptions;
    this.createPeerConnection = options.createPeerConnection ?? createWeriftPeerConnection;
    this.createMediaStream =
      (options.createMediaStream as unknown as (() => WeriftMediaStream) | undefined) ??
      createWeriftMediaStream;
    this.iceServers = options.iceServers ?? [{ urls: "stun:stun.l.google.com:19302" }];
    this.iceGatheringTimeoutMs = options.iceGatheringTimeoutMs ?? 10_000;
    this.signalingTimeoutMs = options.signalingTimeoutMs ?? 10_000;
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? 15_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  private log(level: "debug" | "info" | "warn" | "error", message: string, meta?: unknown): void {
    if (this.options.logger) {
      this.options.logger(level, message, meta);
      return;
    }
    if (!this.options.verbose && level !== "error") return;
    const output = level === "debug" ? console.debug : console[level];
    if (meta === undefined) output(message);
    else output(message, meta);
  }

  onTrack(listener: (event: WebRtcTrackEvent) => void): () => void {
    this.trackListeners.add(listener);
    return () => this.trackListeners.delete(listener);
  }

  getServerSession(sessionId: string): WebRtcServerSessionView | undefined {
    const session = this.serverSessions.get(sessionId);
    if (!session || session.closed) return undefined;
    return {
      id: session.id,
      peerConnection: session.peerConnection,
      remoteStream: session.remoteStream,
      ...(session.localStream ? { localStream: session.localStream } : {}),
    };
  }

  getSession(peerUrl: string): WebRtcSessionView | undefined {
    const session = this.sessions.get(peerUrl);
    if (!session || session.closed) return undefined;

    return {
      id: session.id,
      peerUrl: session.peerUrl,
      peerConnection: session.peerConnection,
      dataChannel: session.dataChannel,
      remoteStream: session.remoteStream,
      media: session.mediaController,
      ...(session.localStream ? { localStream: session.localStream } : {}),
    };
  }

  async execute(request: TransportRequest): Promise<TransportResponse> {
    if (this.closing) throw new Error("WebRTC transport is closed");
    const rtcRequest = request as WebRtcTransportRequest;
    const peerUrl = rtcRequest.peerUrl ?? request.url;

    if (request.signal?.aborted) throw abortError(request.signal);

    const session = await this.getOrCreateSession(peerUrl, rtcRequest);
    await this.ensureMedia(session, rtcRequest);

    if (request.signal?.aborted) throw abortError(request.signal);

    return this.sendRequest(session, request, rtcRequest.timeout);
  }

  public async listen(options: TransportListenOptions): Promise<WebRtcTransportServer> {
    if (this.closing) throw new Error("WebRTC transport is closed");
    const ownedSessions = new Set<string>();
    const port = options.port ?? 3000;
    const host = options.host ?? "127.0.0.1";
    const signalingPath = "/signal";

    if (options.signal?.aborted) {
      throw new Error("WebRtcTransport: server startup aborted");
    }

    let closed = false;
    let closePromise: Promise<void> | undefined;

    const httpServer: HttpServer = createServer((req, res) => {
      void (async () => {
        const sendJson = (status: number, body: unknown) => {
          if (res.headersSent || res.destroyed) return;
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        };

        if (closed || this.closing) {
          sendJson(503, { error: "WebRTC server is closing" });
          return;
        }

        let parsedUrl: URL;
        try {
          parsedUrl = new URL(req.url ?? "/", "http://localhost");
        } catch {
          sendJson(400, { error: "Invalid request URL" });
          return;
        }

        if (parsedUrl.pathname !== signalingPath) {
          sendJson(404, { error: "Signaling endpoint not found" });
          return;
        }

        if (req.method === "DELETE") {
          const sessionId = parsedUrl.searchParams.get("sessionId");
          if (sessionId && ownedSessions.has(sessionId)) {
            await this.closeServerSession(sessionId);
            ownedSessions.delete(sessionId);
          }
          res.writeHead(204).end();
          return;
        }

        if (req.method !== "POST") {
          sendJson(405, { error: "Method not allowed" });
          return;
        }

        let raw = "";
        try {
          for await (const chunk of req) {
            raw += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
            if (Buffer.byteLength(raw, "utf8") > MAX_SIGNALING_BODY_BYTES) {
              sendJson(413, { error: "Signaling payload too large" });
              return;
            }
          }
        } catch (error) {
          sendJson(400, { error: errorFromUnknown(error, "Failed to read body").message });
          return;
        }

        let pc: WeriftPeerConnection | undefined;
        let session: ServerSession | undefined;

        try {
          const payload = JSON.parse(raw) as {
            sessionId?: unknown;
            sdp?: RTCSessionDescriptionInit;
          };

          if (
            typeof payload.sessionId !== "string" ||
            payload.sessionId.length < 1 ||
            payload.sessionId.length > 200 ||
            payload.sdp?.type !== "offer" ||
            typeof payload.sdp.sdp !== "string"
          ) {
            sendJson(400, { error: "Expected sessionId and a valid SDP offer" });
            return;
          }

          if (closed || this.closing) throw new Error("WebRTC server is closing");
          const sessionId = payload.sessionId;
          session = this.serverSessions.get(sessionId);
          if (session && !ownedSessions.has(sessionId)) {
            sendJson(409, { error: "Session belongs to another listener" });
            return;
          }
          if (session?.negotiating) {
            sendJson(409, { error: "Session negotiation already in progress" });
            return;
          }

          if (!session || session.closed) {
            pc = this.createPeerConnection({ iceServers: this.iceServers });
            session = {
              id: sessionId,
              peerConnection: pc,
              remoteStream: this.createMediaStream(),
              localTrackIds: new Set<string>(),
              localStreamResolved: false,
              ownsLocalStream: false,
              closed: false,
            };
            ownedSessions.add(sessionId);
            this.serverSessions.set(sessionId, session);
            this.attachServerPeerEvents(session, options.onRequest);
          } else {
            pc = session.peerConnection;
          }

          session.negotiating = true;
          await this.setRemoteDescription(pc, payload.sdp);
          await this.attachConfiguredServerStream(session);

          const answer = await pc.createAnswer();
          await this.withDeadline(pc.setLocalDescription(answer), this.iceGatheringTimeoutMs);
          await this.waitForIceGatheringComplete(pc, this.iceGatheringTimeoutMs);

          const localDescription = pc.localDescription;
          if (!localDescription?.sdp || localDescription.type !== "answer") {
            throw new Error("Local SDP answer was not generated");
          }

          if (closed || session.closed) throw new Error("WebRTC session closed");
          session.negotiating = false;
          sendJson(200, localDescription);
        } catch (error) {
          this.log("error", "[WebRtcTransport Server] Ошибка сигнализации:", error);
          if (session) {
            await this.closeServerSession(session.id);
          } else if (pc) {
            try {
              await pc.close();
            } catch {}
          }
          sendJson(400, { error: errorFromUnknown(error, "Signaling failed").message });
        }
      })();
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        httpServer.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        httpServer.off("error", onError);
        resolve();
      };
      httpServer.once("error", onError);
      httpServer.once("listening", onListening);
      httpServer.listen(port, host);
    });

    this.log("info", `[WebRtcTransport] Listening on http://${host}:${port}${signalingPath}`);

    const onAbort = () => {
      void closeServer().catch((error) => {
        this.log("error", "[WebRtcTransport] Server shutdown failed:", error);
      });
    };

    const closeServer = (): Promise<void> => {
      if (closePromise) return closePromise;
      closed = true;
      options.signal?.removeEventListener("abort", onAbort);
      closePromise = (async () => {
        const stopped = httpServer.listening
          ? new Promise<void>((resolve, reject) => {
              httpServer.close((error) => (error ? reject(error) : resolve()));
            })
          : Promise.resolve();
        await Promise.all([...ownedSessions].map((id) => this.closeServerSession(id)));
        ownedSessions.clear();
        await stopped;
        this.serverClosers.delete(closeServer);
      })();
      return closePromise;
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });
    this.serverClosers.add(closeServer);
    if (options.signal?.aborted && !closed) await closeServer();

    return {
      close: closeServer,
      webrtc: {
        getSession: this.getSession.bind(this),
        getServerSession: this.getServerSession.bind(this),
        onTrack: this.onTrack.bind(this),
      },
    };
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.pendingPeers].map((pc) => pc.close().catch(() => {})));
    await Promise.allSettled(this.connecting.values());
    await Promise.all(
      [...this.sessions.values()].map((session) => this.disposeClientSession(session, true)),
    );
    await Promise.all([...this.serverClosers].map((closeServer) => closeServer()));
  }

  async destroy(): Promise<void> {
    await this.close();
  }

  private async getOrCreateSession(
    peerUrl: string,
    request: WebRtcTransportRequest,
  ): Promise<ClientSession> {
    const existing = this.sessions.get(peerUrl);
    if (
      existing &&
      !existing.closed &&
      existing.dataChannel.readyState === "open" &&
      existing.peerConnection.connectionState !== "failed" &&
      existing.peerConnection.connectionState !== "closed"
    ) {
      return existing;
    }

    if (existing) {
      await this.disposeClientSession(existing, true);
    }

    const inFlight = this.connecting.get(peerUrl);
    if (inFlight) return inFlight;

    const connectionPromise = this.createClientSession(peerUrl, request);
    this.connecting.set(peerUrl, connectionPromise);

    try {
      const session = await connectionPromise;
      if (this.closing || session.closed) {
        await this.disposeClientSession(session, true);
        throw new Error("WebRTC transport is closed");
      }
      this.sessions.set(peerUrl, session);
      return session;
    } finally {
      if (this.connecting.get(peerUrl) === connectionPromise) {
        this.connecting.delete(peerUrl);
      }
    }
  }

  private async createClientSession(
    peerUrl: string,
    request: WebRtcTransportRequest,
  ): Promise<ClientSession> {
    const signalingUrl = this.toSignalingUrl(peerUrl);
    const id = this.createId("session");
    const pc = this.createPeerConnection({
      iceServers: request.iceServers ?? this.iceServers,
    });
    this.pendingPeers.add(pc);
    const channel = pc.createDataChannel(request.channelLabel ?? "hyperttp-webrtc-transport", {
      ordered: true,
    });

    const session: ClientSession = {
      id,
      peerUrl,
      signalingUrl,
      peerConnection: pc,
      dataChannel: channel,
      remoteStream: this.createMediaStream(),
      ...(request.localStream ? { localStream: request.localStream } : {}),
      localTrackIds: new Set<string>(),
      pending: new Map<string, PendingResponse>(),
      negotiation: Promise.resolve(),
      closed: false,
      mediaController: {} as any,
    };

    const trackListeners = new Set<
      (e: { track: WeriftMediaStreamTrack; stream: WeriftMediaStream }) => void
    >();
    const trackEndedListeners = new Set<(e: { track: WeriftMediaStreamTrack }) => void>();
    const streamListeners = new Set<(e: { stream: WeriftMediaStream }) => void>();

    pc.addEventListener("track", (event: WebRtcTrackEvent) => {
      const { track } = event;
      if (!session.remoteStream.getTracks().includes(track)) session.remoteStream.addTrack(track);
      for (const listener of trackListeners) listener({ track, stream: session.remoteStream });
      for (const listener of streamListeners) listener({ stream: session.remoteStream });
      track.addEventListener("ended", () => {
        for (const listener of trackEndedListeners) listener({ track });
      });
    });

    session.mediaController = {
      localStream: session.localStream,
      remoteStream: session.remoteStream,
      addTrack: (track, stream) =>
        this.queueNegotiation(session, async () => {
          pc.addTrack(track, stream ?? session.localStream ?? this.createMediaStream());
          if (track.id) session.localTrackIds.add(track.id);
          await this.negotiate(session);
        }),
      replaceTrack: async (kind: "audio" | "video", track: any | null) => {
        const sender = pc.getSenders().find((s: any) => s.track && s.track.kind === kind);
        if (sender) {
          await sender.replaceTrack(track);
        }
      },
      removeTrack: (track) =>
        this.queueNegotiation(session, async () => {
          const sender = pc.getSenders().find((item) => item.track === track);
          if (sender) {
            pc.removeTrack(sender);
            if (track.id) session.localTrackIds.delete(track.id);
            await this.negotiate(session);
          }
        }),
      close: async () => {
        await this.disposeClientSession(session, true);
      },
      on(event: string, listener: any) {
        if (event === "track") trackListeners.add(listener);
        if (event === "trackEnded") trackEndedListeners.add(listener);
        if (event === "stream") streamListeners.add(listener);
        return () => {
          trackListeners.delete(listener);
          trackEndedListeners.delete(listener);
          streamListeners.delete(listener);
        };
      },
    };

    try {
      this.attachClientPeerEvents(session);
      this.addLocalTracks(session, request.localStream);
      this.addReceiveTransceivers(session, request.receiveAudio, request.receiveVideo);
      await this.negotiate(session, request.signal);
      await this.waitForChannelOpen(channel, this.connectionTimeoutMs, request.signal);
      return session;
    } catch (error) {
      await this.disposeClientSession(session, true);
      throw error;
    } finally {
      this.pendingPeers.delete(pc);
    }
  }

  private attachClientPeerEvents(session: ClientSession): void {
    const { peerConnection: pc, dataChannel: channel } = session;

    pc.addEventListener("track", (event: any) => {
      const track = event.track;
      if (!session.remoteStream.getTracks().some((item: any) => item.id === track.id)) {
        session.remoteStream.addTrack(track);
      }

      this.emitTrack({
        side: "client",
        sessionId: session.id,
        peerUrl: session.peerUrl,
        peerConnection: pc,
        track,
        stream: session.remoteStream,
        streams: event.streams,
      });
    });

    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        void this.disposeClientSession(session, true);
      }
    });

    channel.addEventListener("message", (event: MessageEvent) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }

      if (!message || typeof message !== "object" || typeof message.requestId !== "string") return;
      const pending = session.pending.get(message.requestId);
      if (!pending) return;

      try {
        const body = decodeWireBody(message.body);
        this.finishPending(session, message.requestId);
        pending.resolve({
          status: typeof message.status === "number" ? message.status : 200,
          statusText: typeof message.statusText === "string" ? message.statusText : "OK",
          headers:
            message.headers && typeof message.headers === "object"
              ? (message.headers as TransportResponse["headers"])
              : {},
          body,
          url: typeof message.url === "string" ? message.url : session.peerUrl,
        });
      } catch (error) {
        this.finishPending(session, message.requestId);
        pending.reject(errorFromUnknown(error, "Invalid WebRTC response"));
      }
    });

    channel.addEventListener("close", () => {
      this.rejectAllPending(session, new Error("WebRTC DataChannel closed"));
      void this.disposeClientSession(session, true);
    });

    channel.addEventListener("error", () => {
      this.rejectAllPending(session, new Error("WebRTC DataChannel error"));
    });
  }

  private queueNegotiation(session: ClientSession, operation: () => Promise<void>): Promise<void> {
    const pending = session.negotiation
      .catch(() => undefined)
      .then(async () => {
        if (session.closed) throw new Error("WebRTC session closed");
        try {
          await operation();
        } catch (error) {
          await this.disposeClientSession(session, true);
          throw error;
        }
      });
    session.negotiation = pending;
    return pending;
  }

  private async ensureMedia(
    session: ClientSession,
    request: WebRtcTransportRequest,
  ): Promise<void> {
    const needsPotentialChanges =
      Boolean(request.localStream) ||
      Boolean(request.receiveAudio) ||
      Boolean(request.receiveVideo);
    if (!needsPotentialChanges || session.closed) return;

    await this.queueNegotiation(session, async () => {
      let changed = this.addLocalTracks(session, request.localStream);
      changed =
        this.addReceiveTransceivers(session, request.receiveAudio, request.receiveVideo) || changed;

      if (request.localStream) {
        session.localStream = request.localStream;
        (session.mediaController as { localStream?: WeriftMediaStream }).localStream =
          request.localStream;
      }
      if (changed) await this.negotiate(session, request.signal);
    });
  }

  private addLocalTracks(session: ClientSession, stream?: WeriftMediaStream): boolean {
    if (!stream) return false;
    let changed = false;

    for (const track of stream.getTracks()) {
      if (track.readyState !== "live" || session.localTrackIds.has(track.id!)) continue;
      session.peerConnection.addTrack(track, stream);
      session.localTrackIds.add(track.id!);
      changed = true;
    }

    return changed;
  }

  private addReceiveTransceivers(
    session: ClientSession,
    receiveAudio?: boolean,
    receiveVideo?: boolean,
  ): boolean {
    const pc = session.peerConnection;
    let changed = false;

    const ensureReceive = (kind: "audio" | "video", enabled: boolean | undefined) => {
      if (!enabled) return;
      const transceivers = pc
        .getTransceivers()
        .find(
          (item: any) =>
            item.receiver.track.kind === kind &&
            (item.direction === "recvonly" || item.direction === "sendrecv"),
        );
      if (!transceivers) {
        pc.addTransceiver(kind, { direction: "recvonly" });
        changed = true;
      }
    };

    ensureReceive("audio", receiveAudio);
    ensureReceive("video", receiveVideo);

    return changed;
  }

  private async negotiate(session: ClientSession, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError(signal);

    const pc = session.peerConnection;
    if (pc.signalingState !== "stable") {
      throw new Error(`Cannot negotiate WebRTC session in state ${pc.signalingState}`);
    }

    const offer = await pc.createOffer();
    await this.withDeadline(pc.setLocalDescription(offer), this.iceGatheringTimeoutMs, signal);
    await this.waitForIceGatheringComplete(pc, this.iceGatheringTimeoutMs);

    const localDescription = pc.localDescription;
    if (!localDescription?.sdp || localDescription.type !== "offer") {
      throw new Error("Local SDP offer was not generated");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.signalingTimeoutMs);
    const abortListener = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abortListener, { once: true });
    if (signal?.aborted) abortListener();

    try {
      const response = await fetch(session.signalingUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, sdp: localDescription }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `Signaling HTTP error: ${response.status} ${response.statusText}${text ? ` — ${text}` : ""}`,
        );
      }

      const answer = (await response.json()) as RTCSessionDescriptionInit;
      if (answer.type !== "answer" || typeof answer.sdp !== "string") {
        throw new Error("Signaling server returned an invalid SDP answer");
      }

      await this.setRemoteDescription(pc, answer);
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      if (controller.signal.aborted) {
        throw new Error(`Signaling timed out after ${this.signalingTimeoutMs} ms`);
      }
      throw errorFromUnknown(error, "WebRTC signaling failed");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortListener);
    }
  }

  private async setRemoteDescription(
    pc: WeriftPeerConnection,
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    const previous = new Set(pc.dtlsTransports);
    try {
      await pc.setRemoteDescription(description);
    } finally {
      // Werift can replace transports while applying BUNDLE without stopping the
      // displaced ICE sockets. They are no longer reachable by pc.close().
      const active = new Set(pc.dtlsTransports);
      await Promise.all(
        [...previous]
          .filter((transport) => !active.has(transport))
          .map((transport) => transport.stop()),
      );
    }
  }

  private async withDeadline<T>(
    operation: Promise<T>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`WebRTC operation timed out after ${timeoutMs} ms`)),
            timeoutMs,
          );
          onAbort = () => reject(abortError(signal));
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted) onAbort();
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  private async waitForIceGatheringComplete(
    pc: WeriftPeerConnection,
    timeoutMs: number,
  ): Promise<boolean> {
    if (pc.iceGatheringState === "complete") return true;

    const completed = await new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;

      const cleanup = () => {
        clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", onStateChange);
      };

      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      const onStateChange = () => {
        if (pc.iceGatheringState === "complete") finish(true);
      };

      timer = setTimeout(() => finish(false), timeoutMs);
      pc.addEventListener("icegatheringstatechange", onStateChange);
      onStateChange();
    });

    if (!completed) throw new Error(`ICE gathering timed out after ${timeoutMs} ms`);
    return true;
  }

  private async waitForChannelOpen(
    channel: WeriftDataChannel,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (channel.readyState === "open") return;
    if (signal?.aborted) throw abortError(signal);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        channel.removeEventListener("open", onOpen);
        channel.removeEventListener("error", onError);
        channel.removeEventListener("close", onClose);
        signal?.removeEventListener("abort", onAbort);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onOpen = () => finish();
      const onError = () => finish(new Error("WebRTC DataChannel failed to open"));
      const onClose = () => finish(new Error("WebRTC DataChannel closed before opening"));
      const onAbort = () => finish(abortError(signal));
      const timer = setTimeout(
        () => finish(new Error(`DataChannel open timeout after ${timeoutMs} ms`)),
        timeoutMs,
      );

      channel.addEventListener("open", onOpen);
      channel.addEventListener("error", onError);
      channel.addEventListener("close", onClose);
      signal?.addEventListener("abort", onAbort, { once: true });

      if (channel.readyState === "open") finish();
      else if (channel.readyState === "closed") finish(new Error("WebRTC DataChannel is closed"));
    });
  }

  private sendRequest(
    session: ClientSession,
    request: TransportRequest,
    requestedTimeout?: number,
  ): Promise<TransportResponse> {
    if (request.signal?.aborted) return Promise.reject(abortError(request.signal));
    if (session.dataChannel.readyState !== "open") {
      return Promise.reject(new Error("WebRTC DataChannel is not open"));
    }

    const requestId = this.createId(`request${++this.requestSequence}`);
    const timeoutMs =
      requestedTimeout && requestedTimeout > 0 ? requestedTimeout : this.requestTimeoutMs;

    return new Promise<TransportResponse>((resolve, reject) => {
      const pending: PendingResponse = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.finishPending(session, requestId);
          reject(new Error(`WebRTC request timed out after ${timeoutMs} ms`));
        }, timeoutMs),
        ...(request.signal ? { signal: request.signal } : {}),
      };

      if (request.signal) {
        pending.abortListener = () => {
          this.finishPending(session, requestId);
          reject(abortError(request.signal));
        };
        request.signal.addEventListener("abort", pending.abortListener, { once: true });
      }

      session.pending.set(requestId, pending);

      try {
        session.dataChannel.send(
          JSON.stringify({
            requestId,
            method: request.method,
            url: request.url,
            headers: request.headers,
            body: encodeWireBody(request.body),
            protocol: request.protocol,
          }),
        );
      } catch (error) {
        this.finishPending(session, requestId);
        reject(errorFromUnknown(error, "Failed to send WebRTC request"));
      }
    });
  }

  private finishPending(session: ClientSession, requestId: string): void {
    const pending = session.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
    session.pending.delete(requestId);
  }

  private rejectAllPending(session: ClientSession, error: Error): void {
    for (const [requestId, pending] of session.pending) {
      this.finishPending(session, requestId);
      pending.reject(error);
    }
  }

  private async disposeClientSession(session: ClientSession, notifyRemote: boolean): Promise<void> {
    if (session.closed) return;
    session.closed = true;

    if (this.sessions.get(session.peerUrl) === session) {
      this.sessions.delete(session.peerUrl);
    }
    this.rejectAllPending(session, new Error("WebRTC session closed"));

    try {
      session.dataChannel.close();
    } catch {}
    try {
      await session.peerConnection.close();
    } catch {}

    if (notifyRemote) {
      try {
        const url = new URL(session.signalingUrl);
        url.searchParams.set("sessionId", session.id);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2_000);
        try {
          await fetch(url, { method: "DELETE", signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
      } catch {}
    }
  }

  private attachServerPeerEvents(
    session: ServerSession,
    onRequest: TransportListenOptions["onRequest"],
  ): void {
    const pc = session.peerConnection;

    pc.addEventListener("datachannel", (event: any) => {
      const channel = event.channel;
      channel.addEventListener("message", (messageEvent: MessageEvent) => {
        void (async () => {
          let requestId: string | undefined;
          try {
            const message = JSON.parse(String(messageEvent.data)) as {
              requestId?: unknown;
              method?: unknown;
              url?: unknown;
              headers?: unknown;
              body?: unknown;
              protocol?: unknown;
            };

            requestId = typeof message.requestId === "string" ? message.requestId : undefined;
            if (
              !requestId ||
              typeof message.method !== "string" ||
              typeof message.url !== "string"
            ) {
              throw new Error("Invalid WebRTC transport request");
            }

            const request: TransportRequest = {
              method: message.method,
              url: message.url,
              headers:
                message.headers && typeof message.headers === "object"
                  ? {
                      ...(message.headers as TransportRequest["headers"]),
                      "x-webrtc-session-id": session.id,
                    }
                  : { "x-webrtc-session-id": session.id },
              body: decodeWireBody(message.body),
              protocol:
                typeof message.protocol === "string"
                  ? (message.protocol as TransportRequest["protocol"])
                  : "webrtc",
            };

            let response: TransportResponse;
            if (!onRequest) {
              response = {
                status: 501,
                statusText: "Not Implemented",
                headers: { "content-type": "application/json" },
                body: { error: "No server request handler configured" },
                url: request.url,
              };
            } else {
              response = await onRequest(request);
            }

            if (channel.readyState !== "open") return;
            channel.send(
              JSON.stringify({
                requestId,
                status: response.status,
                statusText: response.statusText ?? "",
                headers: response.headers,
                body: encodeWireBody(response.body),
                url: response.url ?? request.url,
              }),
            );
          } catch (error) {
            this.log("error", "[WebRtcTransport Server] Request failed:", error);
            if (requestId && channel.readyState === "open") {
              try {
                channel.send(
                  JSON.stringify({
                    requestId,
                    status: 500,
                    statusText: "Internal Server Error",
                    headers: { "content-type": "application/json" },
                    body: { error: errorFromUnknown(error, "Request handler failed").message },
                  }),
                );
              } catch {}
            }
          }
        })();
      });
    });

    pc.addEventListener("track", (event: any) => {
      const track = event.track;
      if (!session.remoteStream.getTracks().some((item: any) => item.id === track.id)) {
        session.remoteStream.addTrack(track);
      }
      this.emitTrack({
        side: "server",
        sessionId: session.id,
        peerConnection: pc,
        track,
        stream: session.remoteStream,
        streams: event.streams,
      });
    });

    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        void this.closeServerSession(session.id);
      }
    });
  }

  private async attachConfiguredServerStream(session: ServerSession): Promise<void> {
    if (session.closed) return;

    if (!session.localStreamResolved) {
      const configured = this.options.localStream;
      const isFactory = typeof configured === "function";
      const stream = isFactory ? configured(session.id) : configured;
      session.localStreamResolved = true;

      if (stream) {
        session.localStream = stream;
        session.ownsLocalStream = isFactory;
      }
    }

    const stream = session.localStream;
    if (!stream) return;

    const pc = session.peerConnection;
    for (const track of stream.getTracks()) {
      if (session.closed || track.readyState !== "live" || session.localTrackIds.has(track.id!)) {
        continue;
      }
      pc.addTrack(track, stream);
      session.localTrackIds.add(track.id!);
    }
  }

  private disposeServerLocalStream(session: ServerSession): void {
    const stream = session.localStream;
    const ownsStream = session.ownsLocalStream;

    delete session.localStream;
    session.ownsLocalStream = false;

    if (!stream || !ownsStream) return;

    try {
      this.options.disposeLocalStream?.(session.id, stream);
    } catch {
    } finally {
      for (const track of stream.getTracks()) {
        if (track.readyState !== "ended") track.stop();
      }
    }
  }

  private async closeServerSession(sessionId: string): Promise<void> {
    const session = this.serverSessions.get(sessionId);
    if (!session || session.closed) return;

    session.closed = true;
    this.serverSessions.delete(sessionId);

    try {
      await session.peerConnection.close();
    } catch {
    } finally {
      this.disposeServerLocalStream(session);
    }
  }

  private emitTrack(event: WebRtcTrackEvent): void {
    for (const listener of this.trackListeners) {
      try {
        listener(event);
      } catch (error) {
        this.log("error", "[WebRtcTransport] onTrack listener failed:", error);
      }
    }
  }

  private toSignalingUrl(peerUrl: string): string {
    if (peerUrl.startsWith("webrtcs://")) return peerUrl.replace(/^webrtcs:\/\//, "https://");
    if (peerUrl.startsWith("webrtc://")) return peerUrl.replace(/^webrtc:\/\//, "http://");
    throw new Error(`Unsupported WebRTC signaling URL: ${peerUrl}`);
  }

  private createId(prefix: string): string {
    return `${prefix}-${crypto.randomUUID()}`;
  }
}
