import type { HyperTransport, TransportRequest, TransportResponse } from "@hyperttp/types";
import { abortError, decodeWireBody, encodeWireBody } from "./utils/helper.js";

export type WebRtcTransportRequest = TransportRequest & {
  peerUrl?: string;
  iceServers?: RTCIceServer[];
  localStream?: MediaStream;
  receiveAudio?: boolean;
  receiveVideo?: boolean;
  channelLabel?: string;
  timeout?: number;
};

export interface WebRtcTransportOptions {
  readonly iceServers?: RTCIceServer[];
  readonly iceGatheringTimeoutMs?: number;
  readonly signalingTimeoutMs?: number;
  readonly connectionTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly createPeerConnection?: (configuration: RTCConfiguration) => RTCPeerConnection;
  readonly createMediaStream?: () => MediaStream;
}

export interface WebRtcTrackEvent {
  readonly side: "client";
  readonly sessionId: string;
  readonly peerUrl: string;
  readonly peerConnection: RTCPeerConnection;
  readonly track: MediaStreamTrack;
  readonly stream: MediaStream;
  readonly streams: readonly MediaStream[];
}

export interface WebRtcSessionView {
  readonly id: string;
  readonly peerUrl: string;
  readonly peerConnection: RTCPeerConnection;
  readonly dataChannel: RTCDataChannel;
  readonly remoteStream: MediaStream;
  readonly localStream?: MediaStream;
}

interface Session extends WebRtcSessionView {
  localStream?: MediaStream;
  signalingUrl: string;
  controller: AbortController;
  pending: Map<string, (error?: unknown, response?: TransportResponse) => void>;
  cleanup: (() => void)[];
  signaled: boolean;
  disposal?: Promise<void>;
}

/** Browser client transport. Caller-owned local media tracks are never stopped. */
export class WebRtcTransport implements HyperTransport {
  private readonly sessions = new Map<string, Session>();
  private readonly queues = new Map<string, Promise<Session>>();
  private readonly trackListeners = new Set<(event: WebRtcTrackEvent) => void>();
  private readonly disposals = new Set<Promise<void>>();
  private closed = false;
  private closing: Promise<void> | undefined;
  private sequence = 0;

  constructor(private readonly options: WebRtcTransportOptions = {}) {}

  onTrack(listener: (event: WebRtcTrackEvent) => void): () => void {
    this.trackListeners.add(listener);
    return () => {
      this.trackListeners.delete(listener);
    };
  }

  getSession(peerUrl: string): WebRtcSessionView | undefined {
    const session = this.sessions.get(peerUrl);
    if (!session || session.controller.signal.aborted) return undefined;
    return {
      id: session.id,
      peerUrl: session.peerUrl,
      peerConnection: session.peerConnection,
      dataChannel: session.dataChannel,
      remoteStream: session.remoteStream,
      ...(session.localStream ? { localStream: session.localStream } : {}),
    };
  }

  async execute(request: WebRtcTransportRequest): Promise<TransportResponse> {
    if (this.closed) throw new Error("WebRTC transport is closed");
    if (request.signal?.aborted) throw abortError(request.signal);
    const peerUrl = request.peerUrl ?? request.url;
    // Queue before awaiting anything, including disposal of an unusable session.
    const previous = this.queues.get(peerUrl);
    const operation = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        if (this.closed) throw new Error("WebRTC transport is closed");
        if (request.signal?.aborted) throw abortError(request.signal);
        let session = this.sessions.get(peerUrl);
        if (
          session &&
          (session.controller.signal.aborted ||
            session.dataChannel.readyState !== "open" ||
            ["failed", "closed"].includes(session.peerConnection.connectionState))
        ) {
          await this.dispose(session);
          session = undefined;
        }
        if (this.closed) throw new Error("WebRTC transport is closed");
        session ??= this.createSession(peerUrl, request);
        try {
          const changed = this.configureMedia(session, request);
          if (!session.signaled || changed) await this.negotiate(session, request.signal);
          await this.run(
            session,
            request.signal,
            this.options.connectionTimeoutMs ?? 15_000,
            "DataChannel open",
            (signal) =>
              this.waitFor(
                session!.dataChannel,
                ["open", "close", "error"],
                signal,
                () => session!.dataChannel.readyState === "open",
                () => ["closing", "closed"].includes(session!.dataChannel.readyState),
              ),
          );
          return session;
        } catch (error) {
          void this.dispose(session);
          throw error;
        }
      });
    this.queues.set(peerUrl, operation);
    const remove = () => {
      if (this.queues.get(peerUrl) === operation) this.queues.delete(peerUrl);
    };
    void operation.then(remove, remove);
    // A queued caller can abort immediately without interrupting another caller's setup.
    const session = await this.abortable(operation, request.signal);
    return this.sendRequest(session, request);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const connections = [...this.queues.values()];
    const sessions = [...this.sessions.values()];
    this.closing = (async () => {
      await Promise.all(sessions.map((session) => this.dispose(session)));
      await Promise.allSettled(connections);
      await Promise.all(this.disposals);
      this.trackListeners.clear();
    })();
    return this.closing;
  }

  destroy(): Promise<void> {
    return this.close();
  }

  private createSession(peerUrl: string, request: WebRtcTransportRequest): Session {
    const url = new URL(peerUrl.replace(/^webrtc:/i, "http:").replace(/^webrtcs:/i, "https:"));
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`Unsupported WebRTC signaling protocol: ${url.protocol}`);
    }
    if (url.pathname === "/") url.pathname = "/signal";
    url.search = "";
    url.hash = "";
    const pc = (this.options.createPeerConnection ?? ((config) => new RTCPeerConnection(config)))({
      iceServers: request.iceServers ??
        this.options.iceServers ?? [{ urls: "stun:stun.l.google.com:19302" }],
    });
    let session: Session;
    try {
      session = {
        id: `session-${crypto.randomUUID()}`,
        peerUrl,
        signalingUrl: url.toString(),
        peerConnection: pc,
        dataChannel: pc.createDataChannel(request.channelLabel ?? "hyperttp-webrtc-transport", {
          ordered: true,
        }),
        remoteStream: (this.options.createMediaStream ?? (() => new MediaStream()))(),
        controller: new AbortController(),
        pending: new Map(),
        cleanup: [],
        signaled: false,
      };
    } catch (error) {
      pc.close();
      throw error;
    }
    this.sessions.set(peerUrl, session);
    const onTrack = (event: RTCTrackEvent) => {
      if (!session.remoteStream.getTracks().includes(event.track))
        session.remoteStream.addTrack(event.track);
      const trackEvent: WebRtcTrackEvent = {
        side: "client",
        sessionId: session.id,
        peerUrl,
        peerConnection: pc,
        track: event.track,
        stream: session.remoteStream,
        streams: event.streams,
      };
      for (const listener of this.trackListeners) {
        try {
          listener(trackEvent);
        } catch {
          /* Consumers must not interrupt transport events. */
        }
      }
    };
    const onState = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed")
        void this.dispose(session);
    };
    const onClose = () => {
      void this.dispose(session);
    };
    const onMessage = (event: MessageEvent) => this.receive(session, event);
    pc.addEventListener("track", onTrack);
    pc.addEventListener("connectionstatechange", onState);
    session.dataChannel.addEventListener("message", onMessage);
    session.dataChannel.addEventListener("close", onClose);
    session.dataChannel.addEventListener("error", onClose);
    session.cleanup.push(() => {
      pc.removeEventListener("track", onTrack);
      pc.removeEventListener("connectionstatechange", onState);
      session.dataChannel.removeEventListener("message", onMessage);
      session.dataChannel.removeEventListener("close", onClose);
      session.dataChannel.removeEventListener("error", onClose);
    });
    return session;
  }

  private configureMedia(session: Session, request: WebRtcTransportRequest): boolean {
    const pc = session.peerConnection;
    let changed = false;
    if (request.localStream) {
      for (const track of request.localStream.getTracks()) {
        if (
          track.readyState === "live" &&
          !pc.getSenders().some((sender) => sender.track === track)
        ) {
          pc.addTrack(track, request.localStream);
          changed = true;
        }
      }
      session.localStream = request.localStream;
    }
    for (const kind of ["audio", "video"] as const) {
      if (!(kind === "audio" ? request.receiveAudio : request.receiveVideo)) continue;
      const transceiver = pc.getTransceivers().find((item) => item.receiver.track.kind === kind);
      if (!transceiver) {
        pc.addTransceiver(kind, { direction: "recvonly" });
        changed = true;
      } else if (transceiver.direction === "sendonly" || transceiver.direction === "inactive") {
        transceiver.direction = transceiver.direction === "sendonly" ? "sendrecv" : "recvonly";
        changed = true;
      }
    }
    return changed;
  }

  private async negotiate(session: Session, signal?: AbortSignal): Promise<void> {
    const pc = session.peerConnection;
    await this.run(
      session,
      signal,
      this.options.signalingTimeoutMs ?? 10_000,
      "SDP offer",
      async (active) => {
        const offer = await pc.createOffer();
        if (active.aborted) throw abortError(active);
        await pc.setLocalDescription(offer);
      },
    );
    await this.run(
      session,
      signal,
      this.options.iceGatheringTimeoutMs ?? 10_000,
      "ICE gathering",
      (active) =>
        this.waitFor(
          pc,
          ["icegatheringstatechange"],
          active,
          () => pc.iceGatheringState === "complete",
        ),
    );
    await this.run(
      session,
      signal,
      this.options.signalingTimeoutMs ?? 10_000,
      "Signaling",
      async (active) => {
        if (!pc.localDescription?.sdp) throw new Error("Local SDP offer was not generated");
        session.signaled = true;
        const response = await fetch(session.signalingUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: session.id, sdp: pc.localDescription }),
          signal: active,
        });
        if (!response.ok)
          throw new Error(`Signaling HTTP error: ${response.status} ${response.statusText}`);
        const answer: unknown = await response.json();
        if (
          !answer ||
          typeof answer !== "object" ||
          !("type" in answer) ||
          answer.type !== "answer" ||
          !("sdp" in answer) ||
          typeof answer.sdp !== "string"
        ) {
          throw new Error("Signaling server returned an invalid SDP answer");
        }
        if (active.aborted) throw abortError(active);
        await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      },
    );
  }

  private receive(session: Session, event: MessageEvent): void {
    if (typeof event.data !== "string") return;
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(event.data);
      if (!parsed || typeof parsed !== "object") return;
      message = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof message.requestId !== "string") return;
    const finish = session.pending.get(message.requestId);
    if (!finish) return;
    try {
      finish(undefined, {
        status: typeof message.status === "number" ? message.status : 200,
        statusText: typeof message.statusText === "string" ? message.statusText : "OK",
        headers:
          message.headers && typeof message.headers === "object"
            ? (message.headers as TransportResponse["headers"])
            : {},
        body: decodeWireBody(message.body),
        url: session.peerUrl,
      });
    } catch (error) {
      finish(error);
    }
  }

  private sendRequest(
    session: Session,
    request: WebRtcTransportRequest,
  ): Promise<TransportResponse> {
    const timeout =
      request.timeout && request.timeout > 0
        ? request.timeout
        : (this.options.requestTimeoutMs ?? 15_000);
    return this.run(
      session,
      request.signal,
      timeout,
      "WebRTC request",
      (signal) =>
        new Promise<TransportResponse>((resolve, reject) => {
          if (session.dataChannel.readyState !== "open") {
            reject(new Error("WebRTC DataChannel is not open"));
            return;
          }
          const requestId = `request-${++this.sequence}`;
          const finish = (error?: unknown, response?: TransportResponse) => {
            session.pending.delete(requestId);
            signal.removeEventListener("abort", onAbort);
            if (response) resolve(response);
            else reject(error ?? new Error("WebRTC session closed"));
          };
          const onAbort = () => finish(abortError(signal));
          session.pending.set(requestId, finish);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) {
            onAbort();
            return;
          }
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
            finish(error);
          }
        }),
    );
  }

  private dispose(session: Session): Promise<void> {
    if (session.disposal) return session.disposal;
    const disposal = Promise.resolve().then(async () => {
      session.controller.abort(new Error("WebRTC session closed"));
      if (this.sessions.get(session.peerUrl) === session) this.sessions.delete(session.peerUrl);
      for (const cleanup of session.cleanup) cleanup();
      session.cleanup.length = 0;
      for (const finish of session.pending.values()) finish(new Error("WebRTC session closed"));
      try {
        session.dataChannel.close();
      } catch {}
      try {
        session.peerConnection.close();
      } catch {}
      if (!session.signaled) return;
      const url = new URL(session.signalingUrl);
      url.searchParams.set("sessionId", session.id);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2_000);
      try {
        await this.abortable(
          fetch(url, { method: "DELETE", signal: controller.signal }),
          controller.signal,
        );
      } catch {
        /* Remote cleanup is best effort. */
      } finally {
        clearTimeout(timer);
      }
    });
    session.disposal = disposal;
    this.disposals.add(disposal);
    void disposal.then(() => this.disposals.delete(disposal));
    return disposal;
  }

  private async run<T>(
    session: Session,
    signal: AbortSignal | undefined,
    timeout: number,
    label: string,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const sources = [session.controller.signal, ...(signal ? [signal] : [])];
    const onAbort = () => {
      const source = sources.find((item) => item.aborted);
      if (source) controller.abort(abortError(source));
    };
    for (const source of sources) source.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error(`${label} timed out after ${timeout} ms`)),
      timeout,
    );
    try {
      onAbort();
      if (controller.signal.aborted) throw abortError(controller.signal);
      return await this.abortable(task(controller.signal), controller.signal);
    } finally {
      clearTimeout(timer);
      for (const source of sources) source.removeEventListener("abort", onAbort);
    }
  }

  private abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      const onAbort = () => {
        cleanup();
        reject(abortError(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      void promise.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
    });
  }

  private waitFor(
    target: EventTarget,
    events: string[],
    signal: AbortSignal,
    ready: () => boolean,
    failed: () => boolean = () => false,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        for (const event of events) target.removeEventListener(event, check);
        signal.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => finish(abortError(signal));
      const check = (event?: Event) => {
        if (signal.aborted) onAbort();
        else if (failed() || event?.type === "error") finish(new Error("WebRTC connection failed"));
        else if (ready()) finish();
      };
      for (const event of events) target.addEventListener(event, check);
      signal.addEventListener("abort", onAbort, { once: true });
      check();
    });
  }
}
