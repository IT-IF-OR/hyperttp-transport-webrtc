import type { LogLevel, TransportRequest, TransportResponse } from "@hyperttp/types";
import type { MediaStream as WeriftMediaStream, RTCPeerConnection as WeriftPeerConnection, RTCDataChannel as WeriftDataChannel, MediaStreamTrack as WeriftMediaStreamTrack } from "werift";
export declare const WEBRTC_BYTES_MARKER = "__hyperttp_webrtc_bytes_v1__";
export declare const MAX_SIGNALING_BODY_BYTES = 1000000;
export type EncodedWebRtcBytes = {
    [WEBRTC_BYTES_MARKER]: true;
    base64: string;
};
export type WebRtcAction = "connect" | "stream" | "datachannel";
export type WebRtcTransportRequest = TransportRequest & {
    peerUrl?: string;
    action?: WebRtcAction;
    iceServers?: RTCIceServer[];
    localStream?: WeriftMediaStream;
    receiveAudio?: boolean;
    receiveVideo?: boolean;
    channelLabel?: string;
    timeout?: number;
};
export interface WebRtcTrackEvent {
    readonly side: "client" | "server";
    readonly sessionId: string;
    readonly peerUrl?: string;
    readonly peerConnection: WeriftPeerConnection;
    readonly track: WeriftMediaStreamTrack;
    readonly stream: WeriftMediaStream;
    readonly streams: readonly WeriftMediaStream[];
}
export interface WebRtcMediaController {
    readonly localStream: WeriftMediaStream | undefined;
    readonly remoteStream: WeriftMediaStream;
    addTrack(track: WeriftMediaStreamTrack, stream?: WeriftMediaStream): Promise<void>;
    replaceTrack(kind: "audio" | "video", track: WeriftMediaStreamTrack | null): Promise<void>;
    removeTrack(track: WeriftMediaStreamTrack): Promise<void>;
    close(): Promise<void>;
    on(event: "track", listener: (e: {
        track: WeriftMediaStreamTrack;
        stream: WeriftMediaStream;
    }) => void): () => void;
    on(event: "trackEnded", listener: (e: {
        track: WeriftMediaStreamTrack;
    }) => void): () => void;
    on(event: "stream", listener: (e: {
        stream: WeriftMediaStream;
    }) => void): () => void;
}
export interface WebRtcSessionView {
    readonly id: string;
    readonly peerUrl: string;
    readonly peerConnection: WeriftPeerConnection;
    readonly dataChannel: WeriftDataChannel;
    readonly remoteStream: WeriftMediaStream;
    readonly localStream?: WeriftMediaStream;
    readonly media: WebRtcMediaController;
}
export interface WebRtcTransportOptions {
    readonly iceServers?: RTCIceServer[];
    readonly iceGatheringTimeoutMs?: number;
    readonly signalingTimeoutMs?: number;
    readonly connectionTimeoutMs?: number;
    readonly requestTimeoutMs?: number;
    readonly logger?: (level: LogLevel, message: string, meta?: unknown) => void;
    readonly verbose?: boolean;
    readonly createPeerConnection?: (configuration: RTCConfiguration) => WeriftPeerConnection;
    readonly createMediaStream?: () => WeriftMediaStream;
    readonly disposeLocalStream?: (sessionId: string, stream: WeriftMediaStream) => void;
    readonly localStream?: WeriftMediaStream | ((sessionId: string) => WeriftMediaStream | undefined);
}
export interface PendingResponse {
    resolve: (response: TransportResponse) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    signal?: AbortSignal;
    abortListener?: () => void;
}
export interface ClientSession {
    id: string;
    peerUrl: string;
    signalingUrl: string;
    peerConnection: WeriftPeerConnection;
    dataChannel: WeriftDataChannel;
    remoteStream: WeriftMediaStream;
    localStream?: WeriftMediaStream;
    localTrackIds: Set<string>;
    pending: Map<string, PendingResponse>;
    negotiation: Promise<void>;
    closed: boolean;
    mediaController: WebRtcMediaController;
}
export interface ServerSession {
    negotiating?: boolean;
    id: string;
    peerConnection: WeriftPeerConnection;
    remoteStream: WeriftMediaStream;
    localTrackIds: Set<string>;
    localStream?: WeriftMediaStream;
    localStreamResolved: boolean;
    ownsLocalStream: boolean;
    closed: boolean;
}
export interface RTCIceServer {
    credential?: string;
    urls: string | string[];
    username?: string;
}
//# sourceMappingURL=types.d.ts.map