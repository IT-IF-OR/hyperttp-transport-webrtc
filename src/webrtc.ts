import type {
  HyperTransport,
  TransportListenOptions,
  TransportRequest,
  TransportResponse,
  TransportServer,
} from "@hyperttp/types";
import {
  MAX_SIGNALING_BODY_BYTES,
  type ClientSession,
  type WebRtcServerSessionContext,
  type WebRtcServerSessionEvent,
  type PendingResponse,
  type ServerSession,
  type ServerTrickleState,
  type WebRtcSessionView,
  type WebRtcTrackEvent,
  type WebRtcTransportOptions as InternalWebRtcTransportOptions,
  type WebRtcTransportRequest,
} from "./types/types.js";
import { abortError, decodeWireBody, encodeWireBody, errorFromUnknown } from "./utils/helper.js";
import { createServer, type Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import {
  MediaStream as WeriftMediaStream,
  RTCPeerConnection as WeriftPeerConnection,
  RTCDataChannel as WeriftDataChannel,
  type MediaStreamTrack as WeriftMediaStreamTrack,
} from "werift";

declare module "@hyperttp/types" {
  interface TransportServer {
    readonly webrtc?: Pick<
      WebRtcTransport,
      "getSession" | "getServerSession" | "onTrack" | "closeServerSession" | "onServerSession"
    >;
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

function cancelResponseBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => {});
  } catch {}
}

function waitForLocalDescription(
  pc: WeriftPeerConnection,
  applying: Promise<unknown>,
  state: "stable" | "have-local-offer",
  type: "answer" | "offer",
  timeoutMs: number,
  signals: (AbortSignal | undefined)[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      pc.removeEventListener("signalingstatechange", check);
      for (const signal of signals) signal?.removeEventListener("abort", onAbort);
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error !== undefined) reject(error);
      else resolve();
    };
    const check = () => {
      if (
        pc.signalingState === state &&
        pc.localDescription?.type === type &&
        pc.localDescription.sdp
      )
        finish();
    };
    const onAbort = () => {
      const signal = signals.find((item) => item?.aborted);
      finish(signal ? abortError(signal) : new Error("WebRTC session closed"));
    };
    const timer = setTimeout(() => finish(new Error("Local SDP timed out")), timeoutMs);
    pc.addEventListener("signalingstatechange", check);
    for (const signal of signals) signal?.addEventListener("abort", onAbort, { once: true });
    void applying.then(
      () => {
        check();
        if (!settled) finish(new Error("Local SDP was not generated"));
      },
      (error: unknown) => finish(error ?? new Error("Local SDP failed")),
    );
    if (signals.some((signal) => signal?.aborted)) onAbort();
    else check();
  });
}

function createWeriftMediaStream(): WeriftMediaStream {
  return new WeriftMediaStream();
}

export type WebRtcTransportOptions = InternalWebRtcTransportOptions;

export interface WebRtcServerSessionView {
  readonly id: string;
  readonly context: WebRtcServerSessionContext;
  readonly peerConnection: WeriftPeerConnection;
  readonly remoteStream: WeriftMediaStream;
  readonly localStream?: WeriftMediaStream;
}

export interface WebRtcTransportServer extends TransportServer {
  readonly webrtc: Pick<
    WebRtcTransport,
    "getSession" | "getServerSession" | "onTrack" | "closeServerSession" | "onServerSession"
  >;
}

export interface WebRtcSignalingHandler {
  handle(request: TransportRequest): Promise<TransportResponse>;
  close(): Promise<void>;
  closeServerSession(sessionId: string): Promise<void>;
}

type SignalingTransport = {
  readonly closing: boolean;
  readonly serverSessions: Map<string, ServerSession>;
  readonly closingServerSessions: Map<string, Promise<void>>;
  readonly iceServers: RTCIceServer[];
  readonly iceGatheringTimeoutMs: number;
  readonly signalingTimeoutMs: number;
  createPeerConnection(configuration: RTCConfiguration): WeriftPeerConnection;
  createMediaStream(): WeriftMediaStream;
  attachServerPeerEvents(
    session: ServerSession,
    onRequest: TransportListenOptions["onRequest"],
  ): void;
  emitServerSession(session: ServerSession, type: WebRtcServerSessionEvent["type"]): void;
  attachConfiguredServerStream(session: ServerSession): Promise<void>;
  setRemoteDescription(
    pc: WeriftPeerConnection,
    description: RTCSessionDescriptionInit,
  ): Promise<void>;
  withDeadline<T>(operation: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T>;
  waitForIceGatheringComplete(
    pc: WeriftPeerConnection,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<boolean>;
  closeServerSession(sessionId: string): Promise<void>;
  log(level: "error" | "warn", message: string, meta?: unknown): void;
};

function isSignalingPath(path: string): boolean {
  return (
    path.startsWith("/") &&
    !path.startsWith("//") &&
    !/[?#\\\s]/u.test(path) &&
    Array.from(path).every((char) => {
      const code = char.codePointAt(0)!;
      return code > 0x1f && (code < 0x7f || code > 0x9f);
    }) &&
    new URL(path, "http://localhost").pathname === path
  );
}

class WebRtcSignalingHandlerImpl implements WebRtcSignalingHandler {
  private readonly ownedSessions = new Set<string>();
  private readonly active = new Set<AbortController>();
  private closed = false;
  private closePromise?: Promise<void>;
  constructor(
    private readonly transport: WebRtcTransport,
    private readonly options: TransportListenOptions,
    private readonly onClose: () => void,
  ) {}

  private response(status: number, body?: unknown): TransportResponse {
    return {
      status,
      headers:
        body === undefined
          ? {}
          : { "content-type": "application/json", "cache-control": "no-store" },
      body: body === undefined ? "" : JSON.stringify(body),
    };
  }
  private async body(body: unknown, signal?: AbortSignal): Promise<string> {
    const chunks: Uint8Array[] = [];
    let size = 0;
    const add = (value: unknown) => {
      const bytes =
        typeof value === "string"
          ? new TextEncoder().encode(value)
          : value instanceof Uint8Array
            ? value
            : new Uint8Array(value as ArrayBuffer);
      size += bytes.byteLength;
      if (size > MAX_SIGNALING_BODY_BYTES) throw new RangeError("body too large");
      chunks.push(bytes);
    };
    if (body == null) return "";
    if (typeof body === "string" || body instanceof Uint8Array || body instanceof ArrayBuffer)
      add(body);
    else if (Symbol.asyncIterator in Object(body)) {
      for await (const chunk of body as AsyncIterable<unknown>) {
        if (signal?.aborted) throw abortError(signal);
        add(chunk);
      }
    } else add(JSON.stringify(body));
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(result);
  }
  async handle(request: TransportRequest): Promise<TransportResponse> {
    const controller = new AbortController();
    const abort = () => controller.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) abort();
    this.active.add(controller);
    if (this.closed) controller.abort();
    try {
      return await this.dispatch({ ...request, signal: controller.signal });
    } finally {
      this.active.delete(controller);
      request.signal?.removeEventListener("abort", abort);
    }
  }

  private async dispatch(request: TransportRequest): Promise<TransportResponse> {
    if (this.closed || (this.transport as unknown as SignalingTransport).closing)
      return this.response(503, { error: "WebRTC server is closing" });
    if (request.signal?.aborted)
      return this.response(503, { error: "WebRTC signaling request aborted" });
    let url: URL;
    try {
      url = new URL(request.url, "http://localhost");
    } catch {
      return this.response(400, { error: "Invalid request URL" });
    }
    const path = this.options.signaling?.path ?? "/signal";
    if (url.pathname !== path) return this.response(404, { error: "Signaling endpoint not found" });
    let ownerId: string | undefined;
    let authorization: unknown;
    if (
      ["POST", "DELETE", "GET", "PATCH"].includes(request.method) &&
      this.options.signaling?.authorize
    ) {
      const controller = new AbortController();
      const abort = () => controller.abort(request.signal?.reason);
      request.signal?.addEventListener("abort", abort, { once: true });
      this.active.add(controller);
      try {
        const allowed = await this.options.signaling.authorize({
          protocol: "webrtc",
          method: request.method,
          url: request.url,
          headers: request.headers,
          signal: controller.signal,
        });
        if (controller.signal.aborted || this.closed)
          return this.response(503, { error: "WebRTC signaling request aborted" });
        if (typeof allowed === "object" && allowed !== null) {
          if (typeof allowed.ownerId !== "string" || !allowed.ownerId.trim())
            return this.response(403, { error: "Invalid signaling identity" });
          ownerId = allowed.ownerId;
          authorization = allowed.context;
        } else if (allowed !== true) return this.response(403, { error: "Signaling forbidden" });
      } catch {
        if (controller.signal.aborted || this.closed)
          return this.response(503, { error: "WebRTC signaling request aborted" });
        return this.response(403, { error: "Signaling forbidden" });
      } finally {
        this.active.delete(controller);
        request.signal?.removeEventListener("abort", abort);
      }
    }
    const transport = this.transport as unknown as SignalingTransport;
    if (request.method === "DELETE") {
      const id = url.searchParams.get("sessionId");
      const session = id ? transport.serverSessions.get(id) : undefined;
      if (session && (!this.ownedSessions.has(id!) || session.context.ownerId !== ownerId))
        return this.response(403, { error: "Signaling forbidden" });
      if (id && this.ownedSessions.has(id)) await transport.closeServerSession(id);
      this.ownedSessions.delete(id!);
      return this.response(204);
    }
    if (request.method === "GET") {
      const id = url.searchParams.get("sessionId");
      const session = id ? transport.serverSessions.get(id) : undefined;
      if (!id || !session || !this.ownedSessions.has(id))
        return this.response(404, { error: "Session not found" });
      if (session.context.ownerId !== ownerId)
        return this.response(403, { error: "Signaling forbidden" });
      const state = session.trickle;
      if (!state || url.searchParams.get("generation") !== state.generation)
        return this.response(409, { error: "ICE generation mismatch" });
      const cursor = url.searchParams.get("cursor") ?? "0";
      if (
        !/^(0|[1-9][0-9]*)$/.test(cursor) ||
        !Number.isSafeInteger(Number(cursor)) ||
        Number(cursor) > state.candidates.length
      )
        return this.response(400, { error: "Invalid ICE cursor" });
      return this.response(200, {
        generation: state.generation,
        candidates: state.candidates.slice(Number(cursor)),
        next: state.candidates.length,
      });
    }
    if (request.method !== "POST" && request.method !== "PATCH")
      return this.response(405, { error: "Method not allowed" });
    let payload: unknown;
    try {
      payload = JSON.parse(await this.body(request.body, request.signal));
    } catch (error) {
      return error instanceof RangeError
        ? this.response(413, { error: "Signaling payload too large" })
        : this.response(400, { error: "Invalid JSON" });
    }
    if (request.signal?.aborted || this.closed)
      return this.response(503, { error: "WebRTC signaling request aborted" });
    if (request.method === "PATCH") return this.patch(payload, ownerId, request.signal);
    return this.offer(payload, ownerId, authorization, request.signal);
  }
  private async patch(
    payload: unknown,
    ownerId: string | undefined,
    signal?: AbortSignal,
  ): Promise<TransportResponse> {
    const transport = this.transport as unknown as SignalingTransport;
    const rawPayload = payload as {
      sessionId?: unknown;
      generation?: unknown;
      candidate?: unknown;
    };
    if (
      typeof rawPayload.sessionId !== "string" ||
      typeof rawPayload.generation !== "string" ||
      !("candidate" in rawPayload)
    )
      return this.response(400, { error: "Expected sessionId, generation and candidate" });
    const candidatePayload = payload as {
      sessionId: string;
      generation: string;
      candidate: unknown;
    };
    const session = transport.serverSessions.get(candidatePayload.sessionId);
    if (!session || !this.ownedSessions.has(candidatePayload.sessionId))
      return this.response(404, { error: "Session not found" });
    if (session.context.ownerId !== ownerId)
      return this.response(403, { error: "Signaling forbidden" });
    const state = session.trickle;
    if (!state || state.generation !== candidatePayload.generation)
      return this.response(409, { error: "ICE generation mismatch" });
    const candidate = candidatePayload.candidate as {
      candidate?: unknown;
      sdpMid?: unknown;
      sdpMLineIndex?: unknown;
      usernameFragment?: unknown;
    } | null;
    if (
      candidate !== null &&
      (typeof candidate !== "object" ||
        typeof candidate.candidate !== "string" ||
        candidate.candidate.length < 1 ||
        candidate.candidate.length > 4096 ||
        (candidate.sdpMid != null &&
          (typeof candidate.sdpMid !== "string" || candidate.sdpMid.length > 256)) ||
        (candidate.sdpMLineIndex != null &&
          (!Number.isInteger(candidate.sdpMLineIndex) ||
            (candidate.sdpMLineIndex as number) < 0 ||
            (candidate.sdpMLineIndex as number) > 65535)) ||
        (candidate.sdpMid == null && candidate.sdpMLineIndex == null) ||
        (candidate.usernameFragment != null &&
          (typeof candidate.usernameFragment !== "string" ||
            candidate.usernameFragment.length > 256)))
    )
      return this.response(400, { error: "Invalid ICE candidate" });
    if (state.remoteEnded || state.remoteCount >= 256)
      return this.response(429, { error: "ICE candidate limit reached or gathering ended" });
    state.remoteCount++;
    if (candidate === null) state.remoteEnded = true;
    const iceCandidate = candidate as RTCIceCandidateInit | null;
    const operationSignal = signal
      ? AbortSignal.any([signal, session.controller.signal])
      : session.controller.signal;
    if (operationSignal.aborted)
      return this.response(503, { error: "WebRTC signaling request aborted" });
    const apply = state.remoteQueue.then(async () => {
      if (session.closed || session.trickle !== state) throw new Error("ICE generation expired");
      await transport.withDeadline(
        session.peerConnection.addIceCandidate(iceCandidate),
        transport.iceGatheringTimeoutMs,
        operationSignal,
      );
      if (operationSignal.aborted || session.closed || session.trickle !== state)
        throw new Error("ICE generation expired");
    });
    state.remoteQueue = apply.catch(() => {});
    try {
      await apply;
      return operationSignal.aborted || session.closed || session.trickle !== state
        ? this.response(503, { error: "WebRTC signaling request aborted" })
        : this.response(204);
    } catch {
      return operationSignal.aborted || session.closed
        ? this.response(503, { error: "WebRTC signaling request aborted" })
        : this.response(400, { error: "Failed to apply ICE candidate" });
    }
  }
  private async offer(
    payload: unknown,
    ownerId: string | undefined,
    authorization: unknown,
    signal?: AbortSignal,
  ): Promise<TransportResponse> {
    const t = this.transport as unknown as SignalingTransport;
    if (
      !payload ||
      typeof payload !== "object" ||
      ("trickle" in payload &&
        payload.trickle !== undefined &&
        typeof payload.trickle !== "boolean")
    )
      return this.response(400, { error: "Invalid trickle flag" });
    const offerPayload = payload as {
      trickle?: boolean;
      sessionId: unknown;
      sdp?: { type?: unknown; sdp?: unknown };
    };
    if (
      typeof offerPayload.sessionId !== "string" ||
      offerPayload.sessionId.length < 1 ||
      offerPayload.sessionId.length > 200 ||
      offerPayload.sdp?.type !== "offer" ||
      typeof offerPayload.sdp.sdp !== "string"
    )
      return this.response(400, { error: "Expected sessionId and a valid SDP offer" });
    const id = offerPayload.sessionId;
    let session = t.serverSessions.get(id);
    let pc: any;
    try {
      if (session && !this.ownedSessions.has(id))
        return this.response(409, { error: "Session belongs to another listener" });
      if (session && session.context.ownerId !== ownerId)
        return this.response(403, { error: "Signaling forbidden" });
      if (t.closingServerSessions.has(id))
        return this.response(409, { error: "Session is closing" });
      if (session?.negotiating || session?.trickle?.gathering)
        return this.response(409, { error: "Session negotiation already in progress" });
      if (!session || session.closed) {
        pc = t.createPeerConnection({ iceServers: t.iceServers });
        const controller = new AbortController();
        session = {
          controller,
          context: Object.freeze({
            sessionId: id,
            ownerId,
            authorization,
            signal: controller.signal,
          }),
          release: () => this.ownedSessions.delete(id),
          id,
          peerConnection: pc,
          remoteStream: t.createMediaStream(),
          localTrackIds: new Set<string>(),
          localStreamResolved: false,
          ownsLocalStream: false,
          closed: false,
          peerListenerCleanup: new Set<() => void>(),
        };
        this.ownedSessions.add(id);
        t.serverSessions.set(id, session);
        t.attachServerPeerEvents(session, this.options.onRequest);
        t.emitServerSession(session, "created");
      } else pc = session.peerConnection;
      session.trickle?.detach();
      delete session.trickle;
      session.negotiating = true;
      const operationSignal = signal
        ? AbortSignal.any([signal, session.controller.signal])
        : session.controller.signal;
      await t.withDeadline(
        t.setRemoteDescription(pc, offerPayload.sdp as RTCSessionDescriptionInit),
        t.signalingTimeoutMs,
        operationSignal,
      );
      await t.withDeadline(
        t.attachConfiguredServerStream(session),
        t.signalingTimeoutMs,
        operationSignal,
      );
      if (operationSignal.aborted || this.closed || session.closed)
        throw new Error("WebRTC session closed");
      const answer = await t.withDeadline(pc.createAnswer(), t.signalingTimeoutMs, operationSignal);
      const activeSession = session;
      if (offerPayload.trickle === true) {
        let state: ServerTrickleState | undefined;
        const onCandidate = (event: { candidate?: { toJSON(): RTCIceCandidateInit } }) => {
          if (
            !state ||
            activeSession.closed ||
            activeSession.trickle !== state ||
            t.serverSessions.get(id) !== activeSession
          )
            return;
          if (state.candidates.length >= 256) {
            void t.closeServerSession(id);
            return;
          }
          state.candidates.push(event.candidate ? event.candidate.toJSON() : null);
        };
        pc.addEventListener("icecandidate", onCandidate);
        state = {
          generation: crypto.randomUUID(),
          candidates: [],
          gathering: true,
          remoteCount: 0,
          remoteEnded: false,
          remoteQueue: Promise.resolve(),
          detach: () => pc.removeEventListener("icecandidate", onCandidate),
        };
        activeSession.trickle = state;
        const applying = t.withDeadline(
          pc.setLocalDescription(answer),
          t.iceGatheringTimeoutMs,
          operationSignal,
        );
        void applying.then(
          () => {
            if (activeSession.trickle === state) {
              state.gathering = false;
              if (!state.candidates.includes(null)) state.candidates.push(null);
            }
          },
          () => {
            if (activeSession.trickle === state && t.serverSessions.get(id) === activeSession)
              void t.closeServerSession(id);
          },
        );
        await waitForLocalDescription(pc, applying, "stable", "answer", t.iceGatheringTimeoutMs, [
          operationSignal,
        ]);
        if (operationSignal.aborted || this.closed || activeSession.closed)
          throw new Error("WebRTC session closed");
        activeSession.negotiating = false;
        return this.response(200, { sdp: pc.localDescription, generation: state.generation });
      }
      await t.withDeadline(
        pc.setLocalDescription(answer),
        t.iceGatheringTimeoutMs,
        operationSignal,
      );
      if (!(await t.waitForIceGatheringComplete(pc, t.iceGatheringTimeoutMs, operationSignal)))
        throw new Error("Full ICE gathering timed out; trickle ICE is not supported");
      if (operationSignal.aborted || this.closed || session.closed)
        throw new Error("WebRTC session closed");
      if (!pc.localDescription?.sdp || pc.localDescription.type !== "answer")
        throw new Error("Local SDP answer was not generated");
      session.negotiating = false;
      return this.response(200, pc.localDescription);
    } catch (error) {
      const cancelled = signal?.aborted || this.closed || session?.closed;
      t.log("error", "[WebRtcTransport Server] Signaling failed", error);
      if (session && t.serverSessions.get(session.id) === session)
        await t.closeServerSession(session.id);
      else if (!session && pc) await pc.close().catch(() => {});
      return cancelled
        ? this.response(503, { error: "WebRTC session closed" })
        : this.response(500, { error: "Signaling failed" });
    }
  }
  async closeServerSession(id: string): Promise<void> {
    if (this.ownedSessions.has(id)) {
      await (this.transport as any).closeServerSession(id);
      this.ownedSessions.delete(id);
    }
  }
  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    for (const controller of this.active) controller.abort();
    this.closePromise = Promise.all(
      [...this.ownedSessions].map((id) => this.closeServerSession(id)),
    )
      .then(() => undefined)
      .finally(this.onClose);
    return this.closePromise;
  }
}

export function createWebRtcSignalingHandler(
  transport: WebRtcTransport,
  options: TransportListenOptions,
): WebRtcSignalingHandler {
  return transport.createSignalingHandler(options);
}

export class WebRtcTransport implements HyperTransport {
  private readonly sessions = new Map<string, ClientSession>();
  private readonly connecting = new Map<string, Promise<ClientSession>>();
  private readonly serverSessions = new Map<string, ServerSession>();
  private readonly sessionListeners = new Set<(event: WebRtcServerSessionEvent) => void>();
  private readonly closingServerSessions = new Map<string, Promise<void>>();
  private readonly trackListeners = new Set<(event: WebRtcTrackEvent) => void>();
  private readonly serverClosers = new Set<() => Promise<void>>();
  private readonly pendingServerStarts = new Set<Promise<void>>();
  private readonly signalingHandlers = new Set<WebRtcSignalingHandler>();
  private requestSequence = 0;
  private closing = false;
  private readonly pendingPeers = new Set<WeriftPeerConnection>();
  private readonly pendingClientControllers = new Map<WeriftPeerConnection, AbortController>();
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

  onServerSession(listener: (event: WebRtcServerSessionEvent) => void): () => void {
    this.sessionListeners.add(listener);
    return () => this.sessionListeners.delete(listener);
  }

  private emitServerSession(session: ServerSession, type: "created" | "closed") {
    for (const listener of this.sessionListeners) {
      try {
        listener({ ...session.context, type });
      } catch (error) {
        this.log("error", "WebRTC session listener failed", error);
      }
    }
  }

  getServerSession(sessionId: string): WebRtcServerSessionView | undefined {
    const session = this.serverSessions.get(sessionId);
    if (!session || session.closed) return undefined;
    return {
      id: session.id,
      context: session.context,
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

  public createSignalingHandler(options: TransportListenOptions): WebRtcSignalingHandler {
    if (this.closing) throw new Error("WebRTC transport is closed");
    if (options.signal?.aborted) throw new Error("WebRtcTransport: server startup aborted");
    if (!isSignalingPath(options.signaling?.path ?? "/signal")) {
      throw new TypeError(
        "WebRTC signaling path must be an absolute literal pathname without query or fragment",
      );
    }
    let handler!: WebRtcSignalingHandler;
    handler = new WebRtcSignalingHandlerImpl(this, options, () =>
      this.signalingHandlers.delete(handler),
    );
    this.signalingHandlers.add(handler);
    return handler;
  }

  public async listen(options: TransportListenOptions): Promise<WebRtcTransportServer> {
    let finishStarting!: () => void;
    const starting = new Promise<void>((resolve) => {
      finishStarting = resolve;
    });
    this.pendingServerStarts.add(starting);
    try {
      if (options.signal?.aborted) throw new Error("WebRtcTransport: server startup aborted");
      const signalingPath = options.signaling?.path ?? "/signal";
      if (!isSignalingPath(signalingPath)) {
        throw new TypeError(
          "WebRTC signaling path must be an absolute literal pathname without query or fragment",
        );
      }
      const handler = this.createSignalingHandler(options);
      const port = options.port ?? 3000;
      const host = options.host ?? "127.0.0.1";
      let closePromise: Promise<void> | undefined;
      const sockets = new Set<Socket>();
      const httpServer: HttpServer = createServer((req, res) => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        req.once("aborted", abort);
        res.once("close", abort);
        void handler
          .handle({
            protocol: "webrtc",
            method: req.method ?? "GET",
            url: req.url ?? "/",
            headers: Object.fromEntries(
              Object.entries(req.headers).filter(
                (entry): entry is [string, string | string[]] => entry[1] !== undefined,
              ),
            ),
            body: req,
            signal: controller.signal,
          })
          .then((response) => {
            if (!res.headersSent && !res.destroyed) {
              res.writeHead(response.status, response.headers);
              res.end(response.body as string | Uint8Array | undefined);
            }
          })
          .catch((error) => {
            this.log("error", "[WebRtcTransport Server] Signaling handler failed:", error);
            if (!res.headersSent && !res.destroyed) {
              res.writeHead(500, {
                "content-type": "application/json",
                "cache-control": "no-store",
              });
              res.end(JSON.stringify({ error: "Signaling failed" }));
            }
          })
          .finally(() => {
            req.off("aborted", abort);
            res.off("close", abort);
          });
      });
      httpServer.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });
      try {
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
      } catch (error) {
        await handler.close();
        throw error;
      }
      if (this.closing) {
        await new Promise<void>((resolve, reject) =>
          httpServer.close((error) => (error ? reject(error) : resolve())),
        );
        await handler.close();
        throw new Error("WebRTC transport is closed");
      }
      this.log("info", `[WebRtcTransport] Listening on http://${host}:${port}${signalingPath}`);
      const onAbort = () => {
        void closeServer().catch((error) =>
          this.log("error", "[WebRtcTransport] Server shutdown failed:", error),
        );
      };
      const closeServer = (): Promise<void> => {
        if (closePromise) return closePromise;
        options.signal?.removeEventListener("abort", onAbort);
        closePromise = (async () => {
          const stopped = httpServer.listening
            ? new Promise<void>((resolve, reject) =>
                httpServer.close((error) => (error ? reject(error) : resolve())),
              )
            : Promise.resolve();
          await handler.close();
          // Let aborted authorization handlers serialize their 503 before forcing stalled bodies closed.
          await new Promise<void>((resolve) => setImmediate(resolve));
          for (const socket of sockets) socket.destroy();
          await stopped;
          this.serverClosers.delete(closeServer);
        })();
        return closePromise;
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.serverClosers.add(closeServer);
      if (options.signal?.aborted) await closeServer();
      return {
        close: closeServer,
        webrtc: {
          getSession: this.getSession.bind(this),
          getServerSession: this.getServerSession.bind(this),
          onTrack: this.onTrack.bind(this),
          closeServerSession: (id: string) => handler.closeServerSession(id),
          onServerSession: this.onServerSession.bind(this),
        },
      };
    } finally {
      this.pendingServerStarts.delete(starting);
      finishStarting();
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const controller of this.pendingClientControllers.values()) {
      controller.abort(new Error("WebRTC transport is closed"));
    }
    await Promise.all([...this.pendingPeers].map((pc) => pc.close().catch(() => {})));
    await Promise.all([...this.signalingHandlers].map((handler) => handler.close()));
    await Promise.allSettled(this.connecting.values());
    await Promise.all(
      [...this.sessions.values()].map((session) => this.disposeClientSession(session, true)),
    );
    await Promise.all([...this.serverClosers].map((closeServer) => closeServer()));
    await Promise.all(this.pendingServerStarts);
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
      if (this.closing) throw new Error("WebRTC transport is closed");
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
    let channel: ClientSession["dataChannel"] | undefined;
    let session: ClientSession | undefined;
    this.pendingPeers.add(pc);

    try {
      channel = pc.createDataChannel(request.channelLabel ?? "hyperttp-webrtc-transport", {
        ordered: true,
      }) as unknown as ClientSession["dataChannel"];

      const currentSession: ClientSession = {
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
        controller: new AbortController(),
        closed: false,
        trackEndedListenerCleanup: new Set(),
        mediaController: {} as any,
      };

      session = currentSession;
      this.pendingClientControllers.set(pc, currentSession.controller!);

      const trackListeners = new Set<
        (e: { track: WeriftMediaStreamTrack; stream: WeriftMediaStream }) => void
      >();
      const trackEndedListeners = new Set<(e: { track: WeriftMediaStreamTrack }) => void>();
      const streamListeners = new Set<(e: { stream: WeriftMediaStream }) => void>();

      const onMediaTrack = (event: WebRtcTrackEvent) => {
        const { track } = event;
        if (!currentSession.remoteStream.getTracks().includes(track))
          currentSession.remoteStream.addTrack(track);
        for (const listener of trackListeners)
          listener({ track, stream: currentSession.remoteStream });
        for (const listener of streamListeners) listener({ stream: currentSession.remoteStream });
        const onTrackEnded = () => {
          for (const listener of trackEndedListeners) listener({ track });
        };
        track.addEventListener("ended", onTrackEnded);
        currentSession.trackEndedListenerCleanup.add(() =>
          track.removeEventListener("ended", onTrackEnded),
        );
      };
      pc.addEventListener("track", onMediaTrack);
      currentSession.trackEndedListenerCleanup.add(() =>
        pc.removeEventListener("track", onMediaTrack),
      );
      currentSession.trackEndedListenerCleanup.add(() => {
        trackListeners.clear();
        trackEndedListeners.clear();
        streamListeners.clear();
      });

      currentSession.mediaController = {
        localStream: currentSession.localStream,
        remoteStream: currentSession.remoteStream,
        addTrack: (track, stream) =>
          this.queueNegotiation(currentSession, async () => {
            pc.addTrack(track, stream ?? currentSession.localStream ?? this.createMediaStream());
            if (track.id) currentSession.localTrackIds.add(track.id);
            await this.negotiate(currentSession);
          }),
        replaceTrack: async (kind: "audio" | "video", track: any | null) => {
          const sender = pc.getSenders().find((s: any) => s.track && s.track.kind === kind);
          if (sender) {
            await sender.replaceTrack(track);
          }
        },
        removeTrack: (track) =>
          this.queueNegotiation(currentSession, async () => {
            const sender = pc.getSenders().find((item) => item.track === track);
            if (sender) {
              pc.removeTrack(sender);
              if (track.id) currentSession.localTrackIds.delete(track.id);
              await this.negotiate(currentSession);
            }
          }),
        close: async () => {
          await this.disposeClientSession(currentSession, true);
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

      this.attachClientPeerEvents(currentSession);
      this.addLocalTracks(currentSession, request.localStream);
      this.addReceiveTransceivers(currentSession, request.receiveAudio, request.receiveVideo);
      await this.negotiate(currentSession, request.signal);
      const channelController = new AbortController();
      const abortChannel = (source: AbortSignal) => channelController.abort(source.reason);
      const abortChannelFromRequest = () => abortChannel(request.signal!);
      const abortChannelFromSession = () => abortChannel(currentSession.controller!.signal);
      request.signal?.addEventListener("abort", abortChannelFromRequest, { once: true });
      currentSession.controller?.signal.addEventListener("abort", abortChannelFromSession, {
        once: true,
      });
      if (request.signal?.aborted) abortChannelFromRequest();
      if (currentSession.controller?.signal.aborted) abortChannelFromSession();
      try {
        await this.waitForChannelOpen(channel, this.connectionTimeoutMs, channelController.signal);
      } finally {
        request.signal?.removeEventListener("abort", abortChannelFromRequest);
        currentSession.controller?.signal.removeEventListener("abort", abortChannelFromSession);
      }
      return currentSession;
    } catch (error) {
      if (session) {
        await this.disposeClientSession(session, true);
      } else {
        try {
          channel?.close();
        } catch {}
        try {
          await pc.close();
        } catch {}
      }
      throw error;
    } finally {
      this.pendingPeers.delete(pc);
      this.pendingClientControllers.delete(pc);
    }
  }

  private attachClientPeerEvents(session: ClientSession): void {
    const { peerConnection: pc, dataChannel: channel } = session;

    const onTrack = (event: any) => {
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
    };
    pc.addEventListener("track", onTrack);
    session.trackEndedListenerCleanup.add(() => pc.removeEventListener("track", onTrack));

    const onConnectionStateChange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        void this.disposeClientSession(session, true);
      }
    };
    pc.addEventListener("connectionstatechange", onConnectionStateChange);
    session.trackEndedListenerCleanup.add(() =>
      pc.removeEventListener("connectionstatechange", onConnectionStateChange),
    );

    const onMessage = (event: MessageEvent) => {
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
    };
    channel.addEventListener("message", onMessage);
    session.trackEndedListenerCleanup.add(() => channel.removeEventListener("message", onMessage));

    const onClose = () => {
      this.rejectAllPending(session, new Error("WebRTC DataChannel closed"));
      void this.disposeClientSession(session, true);
    };
    channel.addEventListener("close", onClose);
    session.trackEndedListenerCleanup.add(() => channel.removeEventListener("close", onClose));

    const onError = () => {
      this.rejectAllPending(session, new Error("WebRTC DataChannel error"));
    };
    channel.addEventListener("error", onError);
    session.trackEndedListenerCleanup.add(() => channel.removeEventListener("error", onError));
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

    const controller = new AbortController();
    const abort = (source: AbortSignal) => controller.abort(source.reason);
    const abortFromRequest = () => abort(signal!);
    const abortFromSession = () => abort(session.controller!.signal);
    signal?.addEventListener("abort", abortFromRequest, { once: true });
    session.controller?.signal.addEventListener("abort", abortFromSession, { once: true });
    if (signal?.aborted) abortFromRequest();
    if (session.controller?.signal.aborted) abortFromSession();

    try {
      if (this.options.trickleIce) return this.negotiateTrickle(session, controller.signal);

      // A peer's createOffer() cannot be cancelled, so only race the caller's
      // wait; the peer can finish its own work after the session is closed.
      const offer = await this.withDeadline(
        pc.createOffer(),
        this.signalingTimeoutMs,
        controller.signal,
      );
      await this.withDeadline(
        pc.setLocalDescription(offer),
        this.iceGatheringTimeoutMs,
        controller.signal,
      );
      await this.waitForIceGatheringComplete(pc, this.iceGatheringTimeoutMs, controller.signal);

      const localDescription = pc.localDescription;
      if (!localDescription?.sdp || localDescription.type !== "offer") {
        throw new Error("Local SDP offer was not generated");
      }

      const signalingController = new AbortController();
      const timer = setTimeout(() => signalingController.abort(), this.signalingTimeoutMs);
      const abortSignaling = () => signalingController.abort(controller.signal.reason);
      controller.signal.addEventListener("abort", abortSignaling, { once: true });
      if (controller.signal.aborted) abortSignaling();

      try {
        const response = await this.withDeadline(
          fetch(session.signalingUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId: session.id, sdp: localDescription }),
            signal: signalingController.signal,
          }),
          this.signalingTimeoutMs,
          controller.signal,
        );
        if (!response.ok) {
          const text = await this.withDeadline(
            response.text(),
            this.signalingTimeoutMs,
            controller.signal,
          );
          throw new Error(
            `Signaling HTTP error: ${response.status} ${response.statusText}${text ? ` — ${text}` : ""}`,
          );
        }

        const answer = await this.withDeadline(
          response.json() as Promise<RTCSessionDescriptionInit>,
          this.signalingTimeoutMs,
          controller.signal,
        );
        if (answer.type !== "answer" || typeof answer.sdp !== "string") {
          throw new Error("Signaling server returned an invalid SDP answer");
        }
        await this.withDeadline(
          this.setRemoteDescription(pc, answer),
          this.signalingTimeoutMs,
          controller.signal,
        );
      } catch (error) {
        if (signal?.aborted) throw abortError(signal);
        if (session.controller?.signal.aborted) throw abortError(session.controller.signal);
        if (signalingController.signal.aborted) {
          throw new Error(`Signaling timed out after ${this.signalingTimeoutMs} ms`);
        }
        throw errorFromUnknown(error, "WebRTC signaling failed");
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", abortSignaling);
      }
    } finally {
      signal?.removeEventListener("abort", abortFromRequest);
      session.controller?.signal.removeEventListener("abort", abortFromSession);
    }
  }

  private async negotiateTrickle(session: ClientSession, signal?: AbortSignal): Promise<void> {
    const pc = session.peerConnection;
    const controller = new AbortController();
    session.trickleAbort = controller;
    const abort = () => controller.abort(signal?.reason);
    const abortFromSession = () => controller.abort(session.controller!.signal.reason);
    signal?.addEventListener("abort", abort, { once: true });
    session.controller?.signal.addEventListener("abort", abortFromSession, { once: true });
    if (signal?.aborted) abort();
    if (session.controller?.signal.aborted) abortFromSession();
    const candidates: (RTCIceCandidateInit | null)[] = [];
    let ended = false;
    let wake: (() => void) | undefined;
    let failure: Error | undefined;
    const onCandidate = (event: { candidate?: { toJSON(): RTCIceCandidateInit } }) => {
      if (ended || controller.signal.aborted) return;
      const candidate = event.candidate ? event.candidate.toJSON() : null;
      if (candidate?.candidate === "") return;
      if (candidates.length >= 256 || !this.validTrickleCandidate(candidate)) {
        failure = new Error("Invalid or excessive local ICE candidates");
      } else {
        candidates.push(candidate);
        if (candidate === null) ended = true;
      }
      wake?.();
    };
    pc.addEventListener("icecandidate", onCandidate);
    const timeout = setTimeout(
      () => controller.abort(new Error("Trickle ICE timed out")),
      this.iceGatheringTimeoutMs + this.signalingTimeoutMs,
    );
    try {
      const offer = await this.withDeadline(
        pc.createOffer(),
        this.signalingTimeoutMs,
        controller.signal,
      );
      const applying = this.withDeadline(
        pc.setLocalDescription(offer),
        this.iceGatheringTimeoutMs,
        controller.signal,
      );
      await waitForLocalDescription(
        pc,
        applying,
        "have-local-offer",
        "offer",
        this.iceGatheringTimeoutMs,
        [controller.signal],
      );
      const response = await this.withDeadline(
        fetch(session.signalingUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: session.id, sdp: pc.localDescription, trickle: true }),
          signal: controller.signal,
        }),
        this.signalingTimeoutMs,
        controller.signal,
      );
      if (!response.ok) {
        cancelResponseBody(response);
        throw new Error(`Signaling HTTP error: ${response.status} ${response.statusText}`);
      }
      const result: unknown = await this.withDeadline(
        response.json(),
        this.signalingTimeoutMs,
        controller.signal,
      );
      if (
        !result ||
        typeof result !== "object" ||
        !("generation" in result) ||
        typeof result.generation !== "string" ||
        !result.generation ||
        result.generation.length > 256 ||
        !("sdp" in result) ||
        !result.sdp ||
        typeof result.sdp !== "object" ||
        !("type" in result.sdp) ||
        result.sdp.type !== "answer" ||
        !("sdp" in result.sdp) ||
        typeof result.sdp.sdp !== "string" ||
        !result.sdp.sdp
      ) {
        throw new Error("Signaling server returned an invalid trickle answer");
      }
      const generation = result.generation;
      await this.withDeadline(
        this.setRemoteDescription(pc, { type: "answer", sdp: result.sdp.sdp }),
        this.signalingTimeoutMs,
        controller.signal,
      );
      const upload = async () => {
        let index = 0;
        while (true) {
          if (controller.signal.aborted) throw abortError(controller.signal);
          if (failure) throw failure;
          if (index === candidates.length) {
            await new Promise<void>((resolve, reject) => {
              const onAbort = () => {
                wake = undefined;
                reject(abortError(controller.signal));
              };
              wake = () => {
                controller.signal.removeEventListener("abort", onAbort);
                wake = undefined;
                resolve();
              };
              controller.signal.addEventListener("abort", onAbort, { once: true });
              if (controller.signal.aborted) onAbort();
            });
            continue;
          }
          const candidate = candidates[index++];
          const patch = await this.withDeadline(
            fetch(session.signalingUrl, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ sessionId: session.id, generation, candidate }),
              signal: controller.signal,
            }),
            this.signalingTimeoutMs,
            controller.signal,
          );
          if (patch.status !== 204) {
            cancelResponseBody(patch);
            throw new Error(`ICE candidate HTTP error: ${patch.status}`);
          }
          if (candidate === null) return;
        }
      };
      const download = async () => {
        let cursor = 0;
        while (true) {
          const url = new URL(session.signalingUrl);
          url.searchParams.set("sessionId", session.id);
          url.searchParams.set("generation", generation);
          url.searchParams.set("cursor", String(cursor));
          const pageResponse = await this.withDeadline(
            fetch(url, { signal: controller.signal }),
            this.signalingTimeoutMs,
            controller.signal,
          );
          if (!pageResponse.ok) {
            cancelResponseBody(pageResponse);
            throw new Error(`ICE polling HTTP error: ${pageResponse.status}`);
          }
          const page: unknown = await this.withDeadline(
            pageResponse.json(),
            this.signalingTimeoutMs,
            controller.signal,
          );
          if (
            !page ||
            typeof page !== "object" ||
            !("generation" in page) ||
            page.generation !== generation ||
            !("candidates" in page) ||
            !Array.isArray(page.candidates) ||
            !("next" in page) ||
            !Number.isInteger(page.next) ||
            page.next !== cursor + page.candidates.length ||
            (page.next as number) > 256 ||
            !page.candidates.every((candidate: unknown) => this.validTrickleCandidate(candidate)) ||
            page.candidates.slice(0, -1).includes(null)
          )
            throw new Error("Signaling server returned an invalid ICE candidate page");
          for (const candidate of page.candidates as (RTCIceCandidateInit | null)[]) {
            await this.withDeadline(
              pc.addIceCandidate(candidate),
              this.iceGatheringTimeoutMs,
              controller.signal,
            );
            if (candidate === null) return;
          }
          cursor = page.next as number;
          if (!page.candidates.length)
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => {
                controller.signal.removeEventListener("abort", onAbort);
                resolve();
              }, 50);
              const onAbort = () => {
                clearTimeout(timer);
                reject(abortError(controller.signal));
              };
              controller.signal.addEventListener("abort", onAbort, { once: true });
              if (controller.signal.aborted) onAbort();
            });
        }
      };
      await Promise.all([
        applying.then(() => {
          if (!ended && !failure) {
            if (candidates.length >= 256)
              failure = new Error("Invalid or excessive local ICE candidates");
            else {
              candidates.push(null);
              ended = true;
            }
            wake?.();
          }
        }),
        upload(),
        download(),
      ]);
    } finally {
      controller.abort();
      clearTimeout(timeout);
      pc.removeEventListener("icecandidate", onCandidate);
      session.controller?.signal.removeEventListener("abort", abortFromSession);
      if (session.trickleAbort === controller) delete session.trickleAbort;
    }
  }

  private validTrickleCandidate(value: unknown): value is RTCIceCandidateInit | null {
    if (value === null) return true;
    if (!value || typeof value !== "object") return false;
    const candidate = value as RTCIceCandidateInit;
    return (
      typeof candidate.candidate === "string" &&
      candidate.candidate.length > 0 &&
      candidate.candidate.length <= 4096 &&
      (candidate.sdpMid == null ||
        (typeof candidate.sdpMid === "string" && candidate.sdpMid.length <= 256)) &&
      (candidate.sdpMLineIndex == null ||
        (Number.isInteger(candidate.sdpMLineIndex) &&
          candidate.sdpMLineIndex >= 0 &&
          candidate.sdpMLineIndex <= 65535)) &&
      (candidate.sdpMid != null || candidate.sdpMLineIndex != null) &&
      (candidate.usernameFragment == null ||
        (typeof candidate.usernameFragment === "string" &&
          candidate.usernameFragment.length <= 256))
    );
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
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) throw abortError(signal);
    if (pc.iceGatheringState === "complete") return true;

    const completed = await new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;

      const cleanup = () => {
        clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", onStateChange);
        signal?.removeEventListener("abort", onAbort);
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

      const onAbort = () => finish(false);
      timer = setTimeout(() => finish(false), timeoutMs);
      pc.addEventListener("icegatheringstatechange", onStateChange);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
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
    session.controller?.abort(new Error("WebRTC session closed"));
    session.trickleAbort?.abort(new Error("WebRTC session closed"));

    if (this.sessions.get(session.peerUrl) === session) {
      this.sessions.delete(session.peerUrl);
    }
    this.rejectAllPending(session, new Error("WebRTC session closed"));
    for (const cleanup of session.trackEndedListenerCleanup) cleanup();
    session.trackEndedListenerCleanup.clear();

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
          const response = await fetch(url, { method: "DELETE", signal: controller.signal });
          cancelResponseBody(response);
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
    const listen = (target: EventTarget, type: string, listener: EventListener): void => {
      target.addEventListener(type, listener);
      session.peerListenerCleanup.add(() => target.removeEventListener(type, listener));
    };

    const onDataChannel = (event: any) => {
      const channel = event.channel;
      const onMessage = (messageEvent: Event) => {
        void (async () => {
          const data = (messageEvent as MessageEvent).data;
          let requestId: string | undefined;
          try {
            const message = JSON.parse(String(data)) as {
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
              signal: session.controller.signal,
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
      };
      listen(channel, "message", onMessage);
    };
    listen(pc, "datachannel", onDataChannel);

    const onTrack = (event: any) => {
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
    };
    listen(pc, "track", onTrack);

    const onConnectionStateChange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        void this.closeServerSession(session.id);
      }
    };
    listen(pc, "connectionstatechange", onConnectionStateChange);
  }

  private async attachConfiguredServerStream(session: ServerSession): Promise<void> {
    if (session.closed) return;

    if (!session.localStreamResolved) {
      const configured = this.options.localStream;
      const isFactory = typeof configured === "function";
      let stream: WeriftMediaStream | undefined;

      if (isFactory) {
        const factory = Promise.resolve().then(() => configured(session.id, session.context));
        void factory
          .then(
            (lateStream) => {
              if (!session.closed || !lateStream) return;
              session.localStream = lateStream;
              session.ownsLocalStream = true;
              this.disposeServerLocalStream(session);
            },
            () => {},
          )
          .catch(() => {});
        stream = await this.withDeadline(
          factory,
          this.signalingTimeoutMs,
          session.controller.signal,
        );
      } else stream = configured;

      if (session.closed) {
        if (stream && isFactory) {
          session.localStream = stream;
          session.ownsLocalStream = true;
          this.disposeServerLocalStream(session);
        }
        return;
      }
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

  /** Idempotent: concurrent closes share peer/resource cleanup. */
  public closeServerSession(sessionId: string): Promise<void> {
    const pending = this.closingServerSessions.get(sessionId);
    if (pending) return pending;
    const session = this.serverSessions.get(sessionId);
    if (!session || session.closed) return Promise.resolve();
    session.closed = true;
    for (const cleanup of session.peerListenerCleanup) cleanup();
    session.peerListenerCleanup.clear();
    session.trickle?.detach();
    delete session.trickle;
    session.controller.abort();
    session.release();
    this.serverSessions.delete(sessionId);
    const closing = Promise.resolve()
      .then(async () => {
        try {
          await session.peerConnection.close();
        } catch (error) {
          this.log("warn", "WebRTC peer close failed", error);
        } finally {
          this.disposeServerLocalStream(session);
          this.emitServerSession(session, "closed");
        }
      })
      .finally(() => this.closingServerSessions.delete(sessionId));
    this.closingServerSessions.set(sessionId, closing);
    return closing;
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
