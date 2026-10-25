import type { HyperTransport, LogLevel, TransportListenOptions, TransportRequest, TransportResponse, TransportServer } from "@hyperttp/types";
import { type WebRtcSessionView, type WebRtcTrackEvent, type WebRtcTransportOptions as InternalWebRtcTransportOptions } from "./types/types.js";
import { MediaStream as WeriftMediaStream, RTCPeerConnection as WeriftPeerConnection } from "werift";
declare module "@hyperttp/types" {
    interface TransportServer {
        readonly webrtc?: Pick<WebRtcTransport, "getSession" | "getServerSession" | "onTrack">;
    }
}
export type WebRtcTransportOptions = Omit<InternalWebRtcTransportOptions, "localStream" | "disposeLocalStream" | "createMediaStream"> & {
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
export declare class WebRtcTransport implements HyperTransport {
    private readonly sessions;
    private readonly connecting;
    private readonly serverSessions;
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
    private closeServerSession;
    private emitTrack;
    private toSignalingUrl;
    private createId;
}
//# sourceMappingURL=webrtc.d.ts.map