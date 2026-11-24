"use strict";import{RTCPeerConnection as r}from"werift";export function createWebRtcPeerConnection(e={}){return new r({...e,bandwidthEstimator:e.bandwidthEstimator??"gcc"})}export function createWebRtcRuntime(){let e;return{load(){return e??=import("./pcm-audio.js").then(({createPcmAudioSource:t})=>({createPeer:createWebRtcPeerConnection,createAudio:t}))}}}
//# sourceMappingURL=runtime.js.map
