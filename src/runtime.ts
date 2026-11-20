import { RTCPeerConnection } from "werift";

export type {
  RTCPeerConnection as WebRtcPeerConnection,
  MediaStream as WebRtcMediaStream,
} from "werift";

export type WebRtcPeerConfiguration = import("werift").RTCPeerConnectionConfig;

/** Creates a server peer with the same bounded RTP send path as the transport. */
export function createWebRtcPeerConnection(
  configuration: WebRtcPeerConfiguration = {},
): RTCPeerConnection {
  return new RTCPeerConnection({
    ...configuration,
    bandwidthEstimator: configuration.bandwidthEstimator ?? "gcc",
  });
}

export interface WebRtcRuntime {
  load(): Promise<{
    createPeer: (configuration: WebRtcPeerConfiguration) => RTCPeerConnection;
    createAudio: typeof import("./pcm-audio.js").createPcmAudioSource;
  }>;
}

/** Load the optional PCM encoder adapter once, when an application admits audio. */
export function createWebRtcRuntime(): WebRtcRuntime {
  let loaded: ReturnType<WebRtcRuntime["load"]> | undefined;
  return {
    load() {
      return (loaded ??= import("./pcm-audio.js").then(({ createPcmAudioSource }) => ({
        createPeer: createWebRtcPeerConnection,
        createAudio: createPcmAudioSource,
      })));
    },
  };
}
