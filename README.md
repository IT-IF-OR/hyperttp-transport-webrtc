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
By default FFmpeg's `-re` paces input at its nominal rate. For a live input that
is already paced, use `createPcmAudioSource(pcmStream, { realtime: false })` to
avoid this second limiter. RTP is paced using its 48 kHz timestamps, with a
bounded queue of 100 packets. An unpaced producer can overflow that queue, in
which case `audio.done` rejects; UDP itself can also drop packets before they
reach the queue. Producers remain responsible for pacing and bounded buffering.
After an input or event-loop pause, delivery resumes without a catch-up burst.
At EOF, `done` waits for queued packets to be delivered; explicit close discards them.
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
  protocol: "webrtc",
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

- Signaling supports opt-in trickle ICE or the default full SDP exchange over HTTP POST `/signal`; DELETE releases a session.
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

Run `bun run typecheck:runtimes` for separate shared, Node, Bun and Deno type
checks. Shared and Deno checks cover the browser-safe modules only; Node and Bun
checks cover all source. Bun's types include Node compatibility types.
Run `bun run test:node`, `bun run test:bun`, and `bun run test:deno` to execute
Vitest in each actual runtime; `tests/runtime.test.ts` verifies which runtime is
running. Deno requires `-A` for these tests, so only run trusted code. Chromium
integration tests require `/usr/bin/chromium` or `PLAYWRIGHT_CHROMIUM_EXECUTABLE`
and otherwise skip. The shutdown test launches the corresponding runtime in a
separate process to check that WebRTC resources do not keep it alive.

## Integration boundaries

The root entry has a `browser` export condition for bundlers that support it;
`/browser` remains the explicit, portable browser entry. The PCM adapter remains
server-only. Node and browser transports can also tunnel other protocol requests
through the DataChannel; they intentionally do not restrict `protocol` to WebRTC.

The protocol's `sessionId` is application metadata. The server transport inserts
its own `x-webrtc-session-id`, exposed by `protocol-webrtc` as `transportSessionId`.
It is suitable for `getServerSession(id)`, not authentication.

Configure an application ACK-handler on protocol servers even for media-only
requests (for example `webRtcControlHandler` from `protocol-webrtc`). Media can
start during negotiation before that handler is invoked. Core request hooks and
DataChannel handlers therefore do **not** authorize HTTP signaling or media access.
For private streams place the signaling endpoint behind an authenticated gateway
that also enforces session ownership and resource limits. Treat `sessionId`,
`x-peer-id`, and `x-webrtc-session-id` as metadata, never user identity.

Protocol `offer`/`answer`/`candidate` actions are application messages; the built-in
transport uses its own HTTP SDP negotiation rather than these messages.

## Custom signaling path and early authorization

Low-level `transport.listen()` and `core.listen()` accept
`signaling: { path: "/calls/signal", authorize: async request => boolean }`.
Authorization runs for POST and DELETE before SDP parsing, session lookup or peer
creation. Returning false or throwing denies access with 403. The raw request has
headers/method/URL and an AbortSignal, no body. On disconnect or listener shutdown,
the signal aborts; a late authorization result cannot create a new session.
Core forwards these options unchanged. The high-level `server.webrtc.signal()`
facade additionally injects typed application services into both callbacks.
The default remains `/signal` without authorization for backward compatibility.

## Server sessions and signaling ownership

A server signaling authorization result may carry a trusted owner identity:

```ts
const transport = new WebRtcTransport({
  localStream: async (sessionId, context) => {
    // context.ownerId and context.authorization come from authorize(), not the wire.
    return mediaForOwner(context.ownerId, context.signal);
  },
  disposeLocalStream: (sessionId, stream) => releaseMedia(sessionId, stream),
});

await transport.listen({
  signaling: {
    path: "/signal",
    authorize: async (request) => {
      const identity = await authenticate(request);
      return identity
        ? { ownerId: identity.id, context: identity }
        : false;
    },
  },
});
```

`ownerId` is stored when the session is created. A later POST or DELETE must be
authorized as the same owner. Session identifiers, headers and signaling bodies
are never used as owner identity. An authorization callback that returns `true`
creates an anonymous session (`ownerId` is `undefined`); use the structured result
when ownership isolation is required.

Use `closeServerSession(sessionId)` for idempotent application cleanup. The
`onServerSession` listener receives `created` and `closed` events, including the
trusted authorization context and an abort signal. `WebRtcTransport.close()`
closes all listener-owned sessions and emits the corresponding close events.

Without opting in, the server gathers all ICE candidates before returning its SDP
answer. Gathering timeouts fail the request rather than returning a partial answer.

### Opt-in server trickle ICE wire protocol

The server supports trickle ICE on the configured signaling path (default `/signal`). The existing clients and `POST` without `trickle: true` are unchanged: they exchange a fully gathered SDP answer. Browser and Werift-based clients on Node.js, Bun and Deno can opt in with `new WebRtcTransport({ trickleIce: true })`. The Werift client currently waits for the candidate exchange to finish before completing negotiation.

* `POST /signal` with JSON `{ "sessionId": "...", "sdp": { "type": "offer", "sdp": "..." }, "trickle": true }` returns `200` JSON `{ "sdp": { "type": "answer", "sdp": "..." }, "generation": "..." }` as soon as the local answer is available, potentially before gathering completes. Apply the answer before its candidates. The answer can already contain candidates.
* `GET /signal?sessionId=...&generation=...&cursor=0` returns `200` JSON `{ "generation": "...", "candidates": [...], "next": 0 }`. Poll with the returned `next` cursor; it is an array index, and repeated requests at the same cursor replay the same entries. Each entry is an `RTCIceCandidateInit` or `null` (end of candidates). A response without `null` is not complete. The cursor defaults to `0`.
* `PATCH /signal` with JSON `{ "sessionId": "...", "generation": "...", "candidate": ... }` applies one client `RTCIceCandidateInit` or `null` for end-of-candidates. A non-null candidate needs a nonempty `candidate` string and `sdpMid` or `sdpMLineIndex`. Success is `204`. Send candidates in order and await each response, including the final `null`.
* `DELETE /signal?sessionId=...` closes the session as before. All operations pass through the configured authorization callback; GET and PATCH must have the same owner identity and listener as the session. Anonymous/boolean authorization retains its existing anonymous ownership semantics.

Every accepted new offer invalidates the previous generation, including when switching back to legacy signaling. A new offer while negotiation or server ICE gathering is in progress returns `409`; stale or missing generations return `409`, unknown sessions `404`, owner mismatch `403`, and invalid payloads/cursors `400`. At most 256 entries (including end-of-candidates) are accepted per direction per generation; further client entries return `429`, and server overflow closes the session. Candidate strings are limited to 4096 characters, IDs to 256 characters, and request bodies to 1,000,000 bytes. Session closure, disconnection, failed gathering, and listener shutdown release generation state. Clients should stop polling after `null`, close unused sessions, and treat non-success responses as terminal or restart negotiation as appropriate.
