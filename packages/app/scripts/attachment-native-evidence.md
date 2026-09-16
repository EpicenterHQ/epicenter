# Attachment checkpoint verification, 2026-09-16

Independent cumulative review covered `b854d07a5e`, `06dbc0294b`, and
`94a2a3a311` against `09b1965e55`, including Whispering consumers. It retained
the design and found a blocking durability defect. Commit `373b4cb141`
repairs filesystem observations after unconfirmed download or acknowledgment
publication. An independent follow-up approved the repair.

Review traced capture/import, playback/export/inference, persisted upload debt,
download admission, deletion and retirement races, cancellation draining,
recoverable retry deadlines, and immutable publication retries. Library-owned
transfer remains the accepted design. No application upload runner, public
`blobs.remote`, or broader App redesign was introduced.

The three filesystem fault regressions failed before the repair and passed
afterward: 3 tests, 21 assertions. The tests cover a download renamed into its
final address before a failed directory flush, live retry, independent reopen,
and an acknowledgment receipt visible before its directory flush succeeds.
Observation repeats required durability barriers before claiming local presence
or cleared upload debt. This adds filesystem synchronization work to attachment
observations. Reads still perform local I/O only.

Native acceptance then exposed two transport defects. Commit `2f4bde66dc`
preserves encoded request bodies through the desktop account broker. WKWebView
rejected the former reconstructed Request with `ReadableStream uploading is
not supported`, preventing Personal-library startup. Binary and multipart
regressions plus cancellation during body preparation pass. The rebuilt native
Personal library opens. Brokered request bodies are materialized; attachment
byte transfers remain on the separate streaming Rust path.

Commit `603fc71c03` removes a duplicate native upload `Content-Type`. Reqwest
appended a second MIME header after the ticket's validated one. The object
fixture stored `audio/wav, audio/wav`, and final verification correctly refused
publication. An actual HTTP regression failed with both values before repair;
the native suite passes with exactly one. Independent review approved both
repairs. Neither changes destination ownership or weakens object verification.

## Exact checks

Run commands from the repository root unless the command supplies `--cwd`.
The final attachment counts include the repair; unchanged suites were verified
before that repair, and affected byte-store consumers were rerun afterward.

| Command | Result |
| --- | --- |
| `bun test packages/blobs/src packages/data/src/store/attachment.test.ts packages/data/src/store/attachment-sync.test.ts` | 139 pass, 0 fail, 1,669 assertions |
| `bun test packages/app/src/app.test.ts packages/app/src/recording.test.ts packages/app/src/recording` | 102 pass, 0 fail, 401 assertions |
| `bun test packages/app/src/epicenter-host.test.ts` | 5 pass, 0 fail, 15 assertions |
| `bun test apps/epicenter/src/server.test.ts` | 46 pass, 0 fail, 408 assertions |
| `bun test apps/whispering/src/lib/whispering/recordings.test.ts` | 12 pass, 0 fail, 39 assertions |
| `bun test apps/whispering/src/lib/whispering/app.test.ts` | 3 pass, 0 fail, 9 assertions |
| `bun test apps/whispering/src/lib/operations/recording.svelte.test.ts` | 17 pass, 0 fail, 67 assertions |
| `bun test apps/whispering/src/lib/operations/recording-close.test.ts` | 10 pass, 0 fail, 34 assertions |
| `bun test apps/whispering/src/lib/operations/transcribe.test.ts` | 9 pass, 0 fail, 32 assertions |
| `bun test apps/whispering/src/lib/operations/pipeline.test.ts` | 12 pass, 0 fail, 40 assertions |
| `bun test packages/server/src/store-sync/attachment-transfer.test.ts packages/server/src/store-sync/attachment-mount.test.ts packages/server/src/s3-blob-store.test.ts` | 12 pass, 0 fail, 61 assertions |
| `bun run --cwd packages/server test:workers workers/attachment-publication.test.ts workers/current-retirement.test.ts workers/initial-generation.test.ts` | 11 pass |
| `cargo test --manifest-path apps/epicenter/src-tauri/Cargo.toml --lib` | 169 pass, 0 fail, 3 ignored |
| `bun run --filter @epicenter/app --filter @epicenter/blobs --filter @epicenter/server --filter @epicenter/whispering --filter @epicenter/honeycrisp --filter @epicenter/vocab typecheck` | Pass; Svelte checks report 0 errors and 0 warnings |
| `bun x tsc --noEmit -p packages/data/tsconfig.dom.json` | Pass |
| `bun run --cwd apps/epicenter typecheck:home` | Pass; 0 errors and 0 warnings |
| `bun test packages/server/evidence/library-ownership/foundation.test.ts` | 7 pass, 2 fail, 81 assertions |
| `bun run --cwd packages/data typecheck` | Fails with 8 DOM-boundary diagnostics |
| `bun packages/app/scripts/recording-libraries.browser.mjs` | Pass: Local, Personal, Shared, and automatic A/B transfer journeys |
| `bun test packages/auth/src` | 141 pass, 0 fail, 587 assertions |
| `bun test packages/auth/src/desktop-broker-auth.test.ts` | 16 pass, 0 fail, 57 assertions |
| `bun test apps/epicenter/src/account-transport.test.ts apps/epicenter/src/desktop-auth-authority.test.ts` | 51 pass, 0 fail, 327 assertions |
| `bun run --cwd packages/auth typecheck` | Pass |
| `bun run --cwd apps/epicenter build:whispering` | Pass |
| `bun packages/app/scripts/attachment-native-account.mjs` | Pass, exit 0: real auth, HTTP/WebSocket, outage/reconnect, request framing, held download and cleanup |
| `bun packages/app/scripts/attachment-native.mjs --import --account` | Pass, exit 0: native Local and A/B journeys described below |
| `bun x biome check packages/app/scripts/attachment-native.mjs packages/app/scripts/attachment-native-account.mjs` | Pass: 2 files, no fixes |

Whispering suites ran in separate processes. App, blobs, server, data DOM,
Whispering domain, and host HTTP verification ran after the durability repair.
The native suite ran again after the MIME repair with the counts shown above.
Its three ignored probes were not run; this checkpoint adds no new large-file
RSS measurements.

## Baseline attribution

A separate detached checkout of `09b1965e55` used its own frozen dependency
installation. Its foundation suite returned 7 pass, 2 fail, 80 assertions.
Both checkouts fail initial generation fetch with 404 and receive 403 for an
unadmitted socket. The baseline socket assertion expects 409; the concurrent
working-tree version expects 404. Both main-data typechecks report the same
eight diagnostics: `RequestInfo`, `indexedDB`, `BodyInit`, three resulting
implicit parameter types, and `IDBKeyRange`. Line numbers differ.

The generation source, foundation tests, and dirty planning changes were not
included in this task's repair. These failures remain owned by their existing
workstreams.

## Browser journey

The authenticated self-host HTTP/WebSocket harness used independently
persisted Chromium contexts. A recorded offline, reopened offline, reconnected,
and uploaded automatically. B downloaded before Play, disconnected, played
locally, reopened, and played again. Lost successful PUT and finalize responses,
delayed verification availability, and identical retries passed. B issued no
upload, and offline playback attempted no attachment network request.

This uses a synthetic browser microphone and an HTTP object fixture. It proves
package-consumer behavior, not native Whispering capture or provider conformance.
The report is retained locally at
`/var/folders/qx/9462vg517cvdtpjr4tt32_200000gn/T/app-recording-evidence-WzyUt8/result.json`.
Detailed command logs are retained at `/tmp/attachment-checkpoint.Hk4iCM`.

## Native A/B result

The final native run passed against production source `603fc71c03`, including
the preceding auth repair. A retained its earlier Local recording after
authentication without adopting or uploading it. A then imported a new WAV
into Personal while the authority was unavailable, restarted both native and
Bun processes offline, and played its saved audio. Reconnection automatically
uploaded and acknowledged the file while downloads were paused.

B used a separate native profile, keychain identity, WebKit data store, and
independently issued session for the same principal. Its automatic download
started before Play. Pause canceled the held GET; Retry while paused caused no
new GET or playable file. Resume delivered the audio. The UI reported
`Audio sync: 0 transferring, 0 waiting, 0 need attention.` and explained that
playback uses audio already on the device.

B played offline, restarted both processes, and played offline again. Playback
time advanced with no audio error. Neither playback nor offline restart issued
an object request or upstream attachment ticket/finalize request. B made no
upload; its persisted attachment metadata has no `originGeneration`.

Both files contain 64,044 bytes with SHA-256
`b489726ad88528a82a3fb2b5cb54d54e3a1c6d2b58d07d769a17ebdcdd53ec92`.
The complete object ledger contains four requests:

| Request | Result |
| --- | --- |
| A upload | PUT 200, one `Content-Type: audio/wav` |
| Server verification | GET 200, `audio/wav` |
| B paused download | Held GET aborted; fixture records 499 |
| B resumed download | GET 200, `audio/wav` |

The run launched six distinct native/Bun process pairs. All exited; both
disposable auth entries were absent afterward, the temporary auth-cell file
was removed, and fixture/listener cleanup passed. The six earlier run-specific
auth entries were also verified absent without reading their values.

The copied Whispering build contains 166 files with aggregate SHA-256
`4137e87ca35ff635de7d0dcc2d42741bab6d1125205f9e62dff472e69caf792d`.
Full result, UI snapshots, request ledger, asset fingerprint, and cleanup
evidence remain at
`/private/var/folders/qx/9462vg517cvdtpjr4tt32_200000gn/T/attachment-native-ShReS7/`.
The command log is `native-attachment-account-final.log` in the log directory
above. Independent review accepted the harness and its request accounting.

Observed diagnostics remain in the report: broker 401 responses during the
controlled authority outage, local 404 responses while B's file was absent,
and hidden-document ViewTransition errors. The deliberately unavailable
inference endpoint returned 404, so transcription failed while saved audio
and delivery succeeded. This run does not establish successful inference.

## Native harness and limits

Run `bun run --cwd apps/epicenter build:whispering` after changes to the
application or its dependencies. The harness copies the built assets and
current native/Bun host sources into a temporary directory, fingerprints the
Whispering assets, and builds its native driver there. It requires macOS and
the existing host build prerequisites.

| Command | Scope |
| --- | --- |
| `bun packages/app/scripts/attachment-native.mjs` | Actual Local microphone capture, save, native/Bun restart, playback |
| `bun packages/app/scripts/attachment-native.mjs --import` | Generated WAV through the actual Local import UI, save, restart, playback |
| `bun packages/app/scripts/attachment-native.mjs --import --account` | Local retention plus authenticated native A/B account delivery and bounded controls |
| `bun packages/app/scripts/attachment-native-account.mjs` | Disposable real auth, HTTP/WebSocket, outage, and object-fixture checks |

The copied host has a unique bundle identifier, keychain service, profile, and
WebKit data store. The driver adds only its command/evidence hooks and event
permission to the copied configuration. Repository host security is unchanged.
DOM events drive the actual Whispering controls. Import assigns a generated
two-second WAV to the real file input; playback calls `play()` on the native
HTML audio element and checks that playback time advances. This does not test
the native file chooser or a physical click on the browser's audio controls.

The physical microphone attempt failed before capture with CoreAudio
`OSStatus: 560947818` while reading the input device name. The UI returned to
Start without claiming a saved recording. `system_profiler SPAudioDataType`
lists Mac Studio Speakers and no input device. The full native capture journey
therefore remains incomplete. The explicit import mode is separate evidence.

Local import, clean process restart, and playback passed in
`attachment-native-1Cv6Vk/result.json` under the macOS temporary directory.
The report retains a hidden-window ViewTransition error; that run does not
claim an error-free console.

No disposable conforming object provider was available. `minio` and `mc` were
absent, no S3/AWS/R2 credentials were configured, and the installed Docker
client could not reach `/Users/braden/.orbstack/run/docker.sock`. The HTTP
object fixture does not establish real-provider signature, checksum,
create-only, or browser CORS enforcement. No production resources were created.

Neither clean process restart nor prior process-interruption probes establish
physical power-loss recovery. Windows durability and signed release packaging
also remain untested.

The next bounded slice requires a physical input device and a disposable
conforming object provider. Extend the account harness's source step from
import to actual microphone capture, then repeat the same A/B journey. Verify
provider checksum, create-only, signature, and browser CORS enforcement against
that provider. Keep general recovery, reclamation, account copying, and the
broader App architecture outside this slice.
