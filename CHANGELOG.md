# Changelog

## [0.4.1] - 2026-11-08

### Added

- Added the `realtime: false` PCM audio option for inputs that are already paced, avoiding FFmpeg's additional input rate limiter.
- Added bounded RTP pacing based on 48 kHz timestamps, including timestamp wrap handling and explicit overflow and discontinuity errors.

### Fixed

- Prevented accumulated scheduling drift after event-loop stalls by recovering gradually without a catch-up burst.
- Waited for queued RTP packets to be delivered before completing audio at EOF; explicit close still discards pending packets.

### Notes

- Producers using `realtime: false` must pace their input; sustained overload can overflow the bounded queue, and UDP packets may be dropped before reaching it.

## [0.4.0] - 2026-11-06

### Added

- Added opt-in Trickle ICE signaling to the server and browser and Werift-based clients. Enable it with `trickleIce: true` to exchange candidates during ICE gathering.
- Added generation-scoped candidate upload and polling, end-of-candidates handling, signaling authorization and session ownership checks, bounded candidate queues, and cleanup when sessions close.
- Added integration coverage using a real Chromium peer for Trickle ICE DataChannel requests and FFmpeg/Opus audio decoding, alongside signaling and Werift gathering tests.

### Changed

- Kept full ICE gathering as the default for existing clients. The opt-in signaling wire format and its limits are documented in the README.
- Signaling responses disable caching to avoid stale candidate polling results.

### Notes

- Trickle ICE support requires compatible signaling on both sides. Applications using proxies must forward and authorize the candidate polling and upload requests.
- The Chromium tests use FFmpeg with libopus and a local Chromium executable; they do not verify audio output or compatibility under production network conditions.
