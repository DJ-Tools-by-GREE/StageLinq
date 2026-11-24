# StageLinq project memory

The 2026-11-24 integration merges `chrisle/StageLinq` main at `83f6723`
(upstream v3.5.7) into this fork, starting from `7faabba`. There are 50 incoming
commits since the common ancestor `044a6ca`. The package remains
`@gree44/stagelinq` and its version is now 3.5.7.

The follow-up overlap review confirmed that the fork added BeatInfo forwarding
in `8ec9d06`, before upstream `8bf4368`, and TrackLength subscriptions in
`f6e7b07`, before upstream `ed5042a`. Both now use Chris's implementation.
StateMap follows the upstream list and ordering, with the 38 remaining
WebView-specific subscriptions appended. Player follows the upstream source
with the additional Track/CurrentBPM guard needed to keep track BPM distinct.
The BeatInfo connection uses upstream's optional-service setup with the
disconnect cancellation guards added during integration.

The review covered StageLinq's README, CHANGELOG, TODO, all service/protocol
guides and Wireshark guide, plus StageLinq-WebView's AGENTS.md, CLAUDE.md,
README.md, memory.md, historical error log and archived project README.
WebView's referenced StageLinq-main.zip was absent. The current sibling source
and fetched upstream Git history supplied the package implementation.

## Incoming upstream changes

| Area | Changes |
|------|---------|
| Engine OS 5 file transfer | Accept larger transfer chunks, learn the device's chunk size, use it for partial reads, probe when a nonzero first offset needs it, and clamp the final full-download chunk to the announced file size. |
| TCP service parsing | Reassemble partial length prefixes and payloads. Skip a malformed message while continuing with subsequent messages in the same read. |
| Device service discovery | Buffer fragmented announcements and timestamps, bound service-name lengths and handle unknown message IDs without an uncaught exception. |
| Device retries | Honor the configured attempt count, await linear backoff of 500 ms per attempt, catch detached connection failures and allow rediscovery after a 10-second failed-device cooldown. |
| Offline discovery | Pause announcements with one warning when usable interfaces disappear, resume when they return and handle asynchronous announcement errors. |
| StateMap startup | Log service connection timeouts. Automatic database downloads run in the background so StateMap setup can proceed before they finish. |
| BeatInfo | Connect the optional service, forward aggregate BeatData with connection information, expose the event on StageLinqInstance and the static wrapper, and correct the CLI and documentation. This fork already forwarded beats on devices. |
| Track metadata | Subscribe to Genre, CurrentKey, TrackLength and TrackUri for all four decks and add genre, key, trackLength and trackUri to PlayerStatus. This fork already subscribed to TrackLength. |
| Database API | Export Databases and DbConnection from the package root. Update the Track interface to Engine DJ 5 schema 3.0.2. |
| Mixer visibility | Warn once for ignored JM08/X1800/X1850 mixers. They continue through the existing ignored-device path. |
| Dependencies | Replace better-sqlite3 with better-sqlite3-multiple-ciphers, locked to 12.11.1, and update metadata-connect to the published 1.2.0 package. Add the native-driver allowScripts entry for npm 12. |
| Release tooling | Retire release.js and its npm commands. Run tests in prepublishOnly. Upstream also moved CI to shared connector-ci workflows and OIDC publishing. This fork uses its existing token workflow as described below. |
| Documentation | Correct BeatInfo payload examples, describe actual Engine metadata states and subscription behavior, expand related connector links and clarify Wireshark installation on Windows. |
| Tests | Add upstream coverage for transfer chunk sizes/ranges, malformed and fragmented messages, connection retries, offline announcements, metadata and subscriptions. Add fork regression coverage for preserved telemetry, BPM separation and disconnect cancellation. |

## Fork merge decisions

- Keep all 104 previous state subscriptions and add the 12 new genre, key and
  URI subscriptions. The resulting 116 entries include 24 per deck. WebView
  requires SampleRate, CurrentKeyIndex, track BPM and Speed* data. It appends
  its loop subscriptions through the exported mutable States array.
- Keep one optional BeatInfo setup after Player initialization. The two
  branches introduced separate setup blocks that would otherwise duplicate
  the connection/listeners.
- Preserve the distinction between Track/CurrentBPM (`trackCurrentBpm`) and
  the live deck CurrentBPM (`currentBpm`). Preserve reduced nowPlaying
  emissions, custom logger injection, Node16 module settings, dynamic ESM
  metadata loading, prepare builds, rimraf and the Prime 4+ keyword.
- Cancel retries and close in-flight connections on disconnectAll. A captured
  AbortSignal suppresses late service setup, state and beat events from an
  earlier connection. Clear connection state so the same manager can discover
  devices again. Consume completed StateMap callbacks once. WebView uses
  maxRetries 999 and reconnects through a watchdog, so old retry loops must
  stop during reconnect. The subsequent WebView audit replaced private
  singleton mutation with fresh public StageLinqInstance objects.
- Retain the fork's NPM_TOKEN release authentication and local workflow
  definitions. Upstream's shared publish workflow requires npm OIDC trusted
  publishing and supplies no token fallback. Change both fork workflows from
  Node 20 to Node 24 to match the supported dependency runtime.
- Import ../index explicitly in the discovery CLI. Importing the package
  directory selected dist/index.d.ts after a build and caused TS5055 failures
  on subsequent builds.

## StageLinq-WebView compatibility

The initial WebView review used checkout `0372b20`, whose dependency lock
selected published `@gree44/stagelinq@3.1.0`. In the follow-up, the user selected
the local checkout workflow. Both workspaces and the lockfile now link this
sibling StageLinq 3.5.7 checkout. Install this package's dependencies first and
rebuild its dist output after source edits before rebuilding WebView.

| Consumer behavior | Effect of this merge |
|-------------------|----------------------|
| Beat samples, elapsed time, Art-Net, OSC and replay | Preserve the aggregate event payload, sample-rate subscription and one forwarded beat per device update. |
| Pitch, BPM, faders and loops | Preserve raw message envelopes, telemetry subscriptions, mutable States and enum exports. |
| Audio/artwork downloads | Preserve getFileTransferService(net://uuid), getFile(path), Uint8Array results and percentComplete progress units. Larger firmware chunks gain upstream fixes. WebView still serializes downloads per device. |
| Key display and recording | The follow-up fixes the transient Am/8A behavior. WebView normalizes named keys into Camelot, retains them across beats and uses CurrentKeyIndex/KEY_MAP as a fallback. It consumes matching accumulated PlayerStatus.key and clears old key state on track replacement, unload and reconnect. |
| Connection watchdog | Retry delays now increase by 500 ms per attempt. Added cancellation prevents obsolete attempts from continuing after the watchdog disconnects the old instance. |
| Database downloads | WebView sets downloadDbSources false. Other consumers enabling it must wait for database availability before querying, since ready no longer implies completion. |
| New genre and track URI | Exposed by the package. WebView currently ignores these fields. |
| TrackLength | PlayerStatus now also carries the raw value. WebView continues handling firmware values expressed in samples through its raw-message conversion. |

The upstream Track interface removes trackData, overviewWaveFormData, beatData,
quickCues, loops, thirdPartySourceId and activeOnLoadLoops, and adds lastEditTime
and albumArtSourceHash. Applications reading those typed columns must account
for Engine DJ 5 performance data moving to PerformanceData/OverviewData.
WebView's active bridge does not consume this interface.

New PlayerStatus fields are required in the TypeScript interface, although
actual partial status updates can omit metadata until the hardware sends it.
External callers constructing PlayerStatus values may need to supply the new
fields. Existing event consumers should continue to handle absent metadata.

WebView consumes the key from accumulated PlayerStatus updates and uses raw
message events for its other active state handling. Live hot-cue positions are
unavailable in its documented hardware workflow, and its offline cue cache is
not yet consumed by the bridge.

## Validation

- Clean npm ci, repeated TypeScript builds and npm pack succeeded on Node
  24.15.0 with npm 11.12.1. The package and lockfile identities match.
- All 265 tests across 23 files pass. Vitest reports one existing warning
  about an unawaited assertion in ConnectionHealth.test.ts.
- Native DbConnection queries and the dynamic metadata-connect ESM import
  succeeded through the compiled public entry point.
- In a temporary WebView checkout, the existing 3.1.0 baseline built first.
  Both root and backend then resolved the packed 3.5.7 fork and the full
  frontend/backend production build passed.
- Eleven compiled WebView bridge checks passed, covering subscriptions,
  sample timing and loop conversion, pitch and faders, single beat forwarding,
  aggregate/flattened beats, layer mapping, serialized downloads and progress,
  and singleton replacement. Both SQLite drivers opened and queried in-memory
  databases in the consumer environment.
- Initial consumer validation used
  /private/tmp/stagelinq-webview-validation-en7ok1gr. The follow-up links the
  actual WebView checkout to this repository and rebuilds both projects.
  The installable merged package is /private/tmp/gree44-stagelinq-3.5.7.tgz.
- The upstream-alignment follow-up passes all 265 package tests. In the actual
  linked WebView checkout, clean npm ci, the full production build, 18 focused
  key regressions and 11 broader bridge checks pass. The CurrentKey sequence
  stays 8A before the named-key message, after it and after the next beat.
- Live Denon hardware, real firmware transfers, CI and npm publication have
  not been exercised. StateMap connection failures are logged but leave the
  device marked connected, so WebView's existing watchdog remains relevant.
  In-flight TCP attempts keep their underlying timeout and close when they
  settle after cancellation.

## WebView audit follow-up

The detailed 2026-11-24 WebView audit uses this package's public
StageLinqInstance and parseNetworkPath APIs, plus Chris's metadata-connect
parser for embedded artwork. It retains per-device transfer serialization:
downloadFile waits for availability but does not make multiple callers atomic.
The WebView build now rebuilds this sibling before its own workspaces.

The audit report and consumer regression tests live in
../StageLinq-WebView/docs/review-2026-11-24/. This follow-up changes no library
runtime behavior. WebView's direct file-type parser is patched independently;
this fork still follows upstream's file-type 16 dependency, which needs a
separate API migration for advisory GHSA-5v7r-6r5c-r473. WebView's installed
dependency audit does not cover this sibling's separate dependency tree.
