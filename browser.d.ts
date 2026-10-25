import type { HyperTransport, TransportRequest, TransportResponse } from "@hyperttp/types";
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
/** Browser client transport. Caller-owned local media tracks are never stopped. */
export declare class WebRtcTransport implements HyperTransport {
    private readonly options;
    private readonly sessions;
    private readonly queues;
    private readonly trackListeners;
    private readonly disposals;
    private closed;
    private closing;
    private sequence;
    constructor(options?: WebRtcTransportOptions);
    onTrack(listener: (event: WebRtcTrackEvent) => void): () => void;
    getSession(peerUrl: string): WebRtcSessionView | undefined;
    execute(request: WebRtcTransportRequest): Promise<TransportResponse>;
    close(): Promise<void>;
    destroy(): Promise<void>;
    private createSession;
    private configureMedia;
    private negotiate;
    private receive;
    private sendRequest;
    private dispose;
    private run;
    private abortable;
    private waitFor;
}
//# sourceMappingURL=browser.d.ts.map