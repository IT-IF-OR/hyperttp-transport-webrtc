import type { HyperTransport, TransportListenOptions, TransportRequest, TransportResponse, TransportServer } from "@hyperttp/types";
import { type WebRtcServerSessionContext, type WebRtcServerSessionEvent, type WebRtcSessionView, type WebRtcTrackEvent, type WebRtcTransportOptions as InternalWebRtcTransportOptions } from "./types/types.js";
import { MediaStream as WeriftMediaStream, RTCPeerConnection as WeriftPeerConnection } from "werift";
declare module "@hyperttp/types" {
    interface TransportServer {
        readonly webrtc?: Pick<WebRtcTransport, "getSession" | "getServerSession" | "onTrack" | "closeServerSession" | "onServerSession">;
    }
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
    readonly webrtc: Pick<WebRtcTransport, "getSession" | "getServerSession" | "onTrack" | "closeServerSession" | "onServerSession">;
}
export declare class WebRtcTransport implements HyperTransport {
    private readonly sessions;
    private readonly connecting;
    private readonly serverSessions;
    private readonly sessionListeners;
    private readonly closingServerSessions;
    private readonly trackListeners;
    private readonly serverClosers;
    private requestSequence;
    private closing;
    private readonly pendingPeers;
    private readonly iceServers;
    private readonly iceGatheringTimeoutMs;
    private readonly signalingTimeoutMs;
    private readonly connectionTimeoutMs;
    private readonly requestTimeoutMs;
    readonly createMediaStream: () => WeriftMediaStream;
    private readonly createPeerConnection;
    private readonly options;
    constructor(options?: WebRtcTransportOptions);
    private log;
    onTrack(listener: (event: WebRtcTrackEvent) => void): () => void;
    onServerSession(listener: (event: WebRtcServerSessionEvent) => void): () => void;
    private emitServerSession;
    getServerSession(sessionId: string): WebRtcServerSessionView | undefined;
    getSession(peerUrl: string): WebRtcSessionView | undefined;
    execute(request: TransportRequest): Promise<TransportResponse>;
    listen(options: TransportListenOptions): Promise<WebRtcTransportServer>;
    close(): Promise<void>;
    destroy(): Promise<void>;
    private getOrCreateSession;
    private createClientSession;
    private attachClientPeerEvents;
    private queueNegotiation;
    private ensureMedia;
    private addLocalTracks;
    private addReceiveTransceivers;
    private negotiate;
    private negotiateTrickle;
    private validTrickleCandidate;
    private setRemoteDescription;
    private withDeadline;
    private waitForIceGatheringComplete;
    private waitForChannelOpen;
    private sendRequest;
    private finishPending;
    private rejectAllPending;
    private disposeClientSession;
    private attachServerPeerEvents;
    private attachConfiguredServerStream;
    private disposeServerLocalStream;
    /** Idempotent: concurrent closes share peer/resource cleanup. */
    closeServerSession(sessionId: string): Promise<void>;
    private emitTrack;
    private toSignalingUrl;
    private createId;
}
//# sourceMappingURL=webrtc.d.ts.map