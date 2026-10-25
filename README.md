# @hyperttp/transport-webrtc

WebRTC transport for Hyperttp: Werift on the server, native WebRTC in the browser.
Requests/responses use a reliable ordered DataChannel; audio/video use WebRTC media tracks.
No `wrtc` dependency is required.

## Server: receive-only listeners

```ts
import { WebRtcTransport } from "@hyperttp/transport-webrtc";
import { createPcmAudioSource } from "@hyperttp/transport-webrtc/pcm-audio";

// Raw PCM: signed 16-bit little-endian, 48 kHz, stereo.
// Pass an independently subscribed branch of your audio source, not a stream
// that is already locked/consumed by the Discord player.
const audio = await createPcmAudioSource(pcmStream);
const subscriptions = new Map();
const transport = new WebRtcTransport({
  iceServers: [], // Local tests only. Configure STUN/TURN for internet clients.
  localStream(sessionId) {
    const subscription = audio.subscribe();
    subscriptions.set(sessionId, subscription);
    return subscription.stream;
  },
  disposeLocalStream(sessionId) {
    subscriptions.get(sessionId)?.close();
    subscriptions.delete(sessionId);
  },
});

const server = await transport.listen({
  host: "127.0.0.1",
  port: 3001,
  onRequest: (request) => ({
    status: 200,
    headers: {},
    body: { listening: true },
  }),
});

// On application shutdown:
// await transport.close();
// await audio.close();
```

`createPcmAudioSource` is an **optional server-only adapter**, not a WebRTC codec
implementation. It requires an installed FFmpeg executable with `libopus` support
(`ffmpegPath` can override PATH). It encodes one shared PCM input to 20 ms Opus
frames and delivers RTP to independent Werift tracks over IPv4 loopback UDP.
It starts consuming immediately; late subscribers join the current position.
Observe `audio.done` for EOF/encoder/input errors. Close the adapter when its
playback session ends. Closing a listener stops only its track, not the source.
It does not implement seeking, playback pause, or audio mixing.

## Browser

Import the explicit browser entry point so Node/Werift code is not bundled:

```ts
import { WebRtcTransport } from "@hyperttp/transport-webrtc/browser";

const transport = new WebRtcTransport();
const audioElement = document.querySelector("audio")!;
transport.onTrack(({ stream }) => {
  audioElement.srcObject = stream;
});

// Run from a user gesture; browser autoplay policy may require another click
// once the remote track is available.
await transport.execute({
  method: "POST",
  url: "webrtc://127.0.0.1:3001/signal",
  headers: {},
  body: { action: "stream" },
  receiveAudio: true,
});
await audioElement.play();

// await transport.close();
```

For Hyperttp use this browser transport as `customTransport` together with
`WebRtcProtocol`. The protocol's `receive(peerUrl, options?, signal?)` convenience
method selects `action: "stream"` and defaults `receiveAudio` to `true`; it does
not ask for a microphone. Rebuild both linked packages after source changes.
Existing `connect`, `stream`, and `dataChannel` protocol methods remain available.

The server implementation exports `createMediaStream`, `getSession(peerUrl)`,
`getServerSession(sessionId)` and `onTrack`. Server requests include an
`x-webrtc-session-id` header inserted by the transport (overriding the wire value).
This identifies a transport session, **not an authenticated user**.

## Discord and web playback

Keep the shared playback source independent of both outputs:

```text
AudioService / shared playback clock
  ├─ bounded PCM subscription → DiscordAudioOutput
  └─ bounded PCM subscription → createPcmAudioSource → Werift → browsers
```

Do not give the same `ReadableStream` to two readers or use unbounded `tee()`
queues for a long-running broadcast. The application's distributor must handle
bounded per-output queues, backpressure and detached consumers. Discord leaving
voice must detach its output rather than reset the shared playback session.
This package does not change a Discord bot's player lifecycle automatically.
Local browser mute/volume should not change the common source's volume.

## Deployment constraints

- Signaling is non-trickle SDP over HTTP POST `/signal`; DELETE releases a session.
- `webrtc://` maps to HTTP, `webrtcs://` to HTTPS. Terminate TLS at a reverse proxy.
- The built-in signaling server has no authentication, CORS policy, or session
  quotas. Use a same-origin authenticated gateway before exposing it publicly;
  authenticate the initial SDP request before attaching a private audio source.
- STUN alone is insufficient for all NATs; configure TURN for production.
- Request bodies are buffered JSON (binary bodies are base64), not streaming file
  transfers. Large messages and high-rate bulk traffic need additional limits and
  DataChannel backpressure handling.
- `close()` is terminal; create a new transport to reconnect after closing it.
- The browser entry point is integration-tested with injected Werift peers. Real
  browser playback and Discord continuity still require application-level tests.

## Development

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

Network integration tests use loopback and no public STUN servers. PCM adapter
integration tests require FFmpeg with libopus.
