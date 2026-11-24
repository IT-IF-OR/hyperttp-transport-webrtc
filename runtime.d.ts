import { RTCPeerConnection } from "werift";
export type { RTCPeerConnection as WebRtcPeerConnection, MediaStream as WebRtcMediaStream, } from "werift";
export type WebRtcPeerConfiguration = import("werift").RTCPeerConnectionConfig;
/** Creates a server peer with the same bounded RTP send path as the transport. */
export declare function createWebRtcPeerConnection(configuration?: WebRtcPeerConfiguration): RTCPeerConnection;
export interface WebRtcRuntime {
    load(): Promise<{
        createPeer: (configuration: WebRtcPeerConfiguration) => RTCPeerConnection;
        createAudio: typeof import("./pcm-audio.js").createPcmAudioSource;
    }>;
}
/** Load the optional PCM encoder adapter once, when an application admits audio. */
export declare function createWebRtcRuntime(): WebRtcRuntime;
//# sourceMappingURL=runtime.d.ts.map