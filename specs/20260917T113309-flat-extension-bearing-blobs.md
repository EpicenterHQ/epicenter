# Flat extension-bearing blobs

**Date**: 2026-09-17
**Status**: In Progress
**Owner**: Braden Wong

## Accepted outcome

An app saves immutable bytes under complete extension-bearing keys, uses those
keys as desktop filenames and browser database keys, and keeps recording details
in its rows. Successful recording Stop publishes the audio and returns its saved
key. `app.blobs.local.open(key)` resolves that key on either platform.

**Existing-data disposition: clean break.** On 2026-09-17, the user clarified
that pre-existing data is disposable and requested a clean breaking change.
This supersedes the original preservation requirement and the proposed
copy-and-verify conversion. No conversion ledger, old-reference translation,
legacy URL parser, historical archive importer, or compatibility reader is
required. Do not ask again whether old-format data must be preserved.

The consequence is deliberate: pre-change recordings, local objects, hosted
URLs, archives, and pending recovery operations need not remain usable. The
implementation must preserve correctness for newly created data. ADR-0394 and
ADR-0395 now select document-only materialization and recovery through ordinary
Push. ADR-0379's cleanup removed structural archives and unused backup
orchestration while retaining live library safeguards.

The user subsequently confirmed **zero users and no existing data**. There is
nothing to migrate, reset, inventory, or clean up. No one-time reset utility,
conversion record, stale-client rollout, or administrative deletion belongs to
this implementation.

The original design direction remains in ADR-0349 (app-local storage), ADR-0366
(saved recording), ADR-0372 (explicit hosting), and ADR-0393 (independent byte
lifetime). Their proposed status and current code remain evidence rather than
additional approval gates. The concurrent native-capture plan still owns device
admission; this plan owns its saved output.

## Final shape

Examples shorten the random body; production keys retain 21 lowercase
alphanumeric characters.

```text
Desktop app directory              Browser app database
  blobs/                             blobs, keyPath: id
    blob_abc.wav                        {id, bytes: ArrayBuffer, size}
    blob_def.webm                       index: [id, size]

Recording row
  audioBlobId = "blob_abc.wav"
  title, transcript, duration, other descriptive fields

capture -> successful Stop -> saved complete key -> local.open(key)
```

There is one ordinary desktop file per blob, with no per-blob folder or JSON
sidecar. Reserved same-directory temporary names cannot parse as saved keys.
Browser size comes from the bytes at write time and commits with them; the index
supports list/stat without returning record values. Desktop uses filesystem size.
Neither representation stores descriptive recording metadata.

The directory is internal app storage even though external tools can read its
files. External renaming or replacement is unsupported. No watcher or external
edit synchronization is introduced.

## Replacement process

Build and verify the new contract, connect active callers, then delete retired
code. Use fresh generated test data. The shipped implementation contains only
the new format, with no compatibility readers or startup reset behavior.
Unsupported inputs fail normally; an error must never erase newly created data.

Browser transaction, blocked-connection, and erase-lock handling remain runtime
correctness requirements. The final schema contains only `blobs` and its derived
index. These guarantees protect future data and do not introduce migration work.

## Contract and owners

### Complete keys and format policy

The blob package owns one grammar: `blob_` plus 21 lowercase alphanumerics, one
dot, and 1 to 10 lowercase alphanumeric suffix characters. Reject separators,
encoded traversal, URL queries/fragments, trailing dots, controls, and arbitrary
human filenames. TypeScript and Rust must agree.

`packages/blobs/src/blob-format.ts` owns producer format selection, conventional
read types, and container equivalence. It is a pure policy, not a registry or
service. Selection uses a supported producer MIME first, then a supported File
suffix only when MIME is absent/generic; otherwise use `.bin`. File evidence
must survive a Blob-typed argument without cross-runtime `instanceof File`.
Changing the suffix never converts bytes.

Known declared types must agree with the saved key's container family. Aliases
such as `audio/x-wav` and `audio/wav` are equivalent. Ordinary local reads return
one conventional type per suffix and do not retain original codec parameters.
Current choices include `.wav` → `audio/wav`, `.webm` → `video/webm`, `.ogg` and
`.opus` → `audio/ogg`, `.m4a` → `audio/mp4`, and `.mp4` → `video/mp4`.

Imports, browser recording, native WAV, direct upload, export, and transcription
all use this policy. UI import allowlists remain application policy. Download
callers supply complete friendly filenames; download adapters save those names.
The existing `recordings.zip` export must stay a ZIP.

### Publication and playback

The raw byte contract has put, get, stat, list, and delete. Do not rebuild copy
or statMany. Writes are immutable and collision-safe across independent Bun and
Rust publishers. A failure before publication exposes no complete object; a
failure after publication cannot erase the published object. Retained finalized
bytes and receipts allow retry without acknowledging different bytes.

Bun and Rust use different reserved temporary-name prefixes. Cleanup only owns
its own staged output; it never removes a committed object. No general startup
sweep is needed for this rewrite. Reject symlinks and nonregular final entries;
an occupied file, directory, or dangling link is a collision. Constructor roots
are trusted app configuration and resolve consistently across runtimes.

Bun `openFile` owns a validated descriptor through a result
with `close()`. The host releases it after full/range responses,
invalid ranges, cancellation, and native upload completion/failure. Preserve
HEAD, byte ranges, native streaming, attachment disposition, sandbox CSP,
nosniff, and same-origin protection. Temporary browser playback URLs remain
explicitly disposable.

### Recording and row lifetime

The live capture identifier and saved key have separate jobs. Browser output
format is known at completion; pin its full key once and reuse it after save
failure. Native output is WAV and can pin a saved `.wav` key earlier. Keep
request/session ownership, stale-session rejection, and saved-result receipts.
Only successful Stop establishes that the returned key names committed bytes.

The current native owners are `blobs.rs`, `recorder/recorder.rs`, and
`recorder/sessions.rs`; there is no current `recorder/blob.rs`. Adapt encoder
handle ownership so every writable encoder is finalized before publication.
The App's recorder and `app.blobs.local` must use the same app-scoped store.

Rows own titles and transcripts. Failed row creation leaves enumerable saved
bytes. Row deletion, account changes, and failed uploads do not delete audio.
No second local save follows a successful Stop.

### Explicit hosting

Remote upload remains an explicit operation with a fresh server-minted ID.
Keep owner/app authorization, captured-account URLs, redirect refusal, size
checks, and independent remote lifetime. Direct and local-first File uploads
must agree on format. Infer upload MIME from filename only for absent/generic
types; preserve declared provider MIME metadata.

The grammar-change checkpoint also adapted structural archives and private
backup storage. ADR-0379's subsequent caller audit removed those implementations
and their dedicated tests. Their historical results below remain evidence of
that checkpoint, not obligations to rebuild byte-restoration machinery.
Document-only checkout and saved folder copies carry references only.

## Implementation and review

The replacement is integrated into the canonical blob modules and active App,
recording, host, upload, export, and recovery paths. The duplicate `src/flat/`
adapters and retained old sources were deleted after replacement tests and an
independent integration review passed. Copy, statMany, the host copy route,
sidecar publication, and paired browser stores are removed.

The native publication module is `apps/epicenter/src-tauri/src/flat_blobs.rs`;
`blobs.rs` adds native app scoping. The host retains one Bun store per app for
its lifetime so publication receipts survive later HTTP requests. Browser Stop
pins the finalized bytes and actual-format key for retries. Archive v3 derives
attachment formats from keys and keeps hosted HTTP(S) URL spans opaque.

Independent reviews caught and resolved fresh-input retry identity, native/Bun
root aliasing, hosted URLs incorrectly requiring local bytes during backup, and
the host recreating receipt-owning stores per request. Integration tests also
found premature same-instance collision results, Bun's ranged-stream EOF stall,
and ZIP export attempting to serialize an unused CRDT node into YAML. The
replacement has regression coverage for each repaired behavior.

READMEs and ADRs 0349, 0366, 0372, and 0393 describe the resulting contract.
Existing unrelated work remains intact. No real-data resets were performed. Task-start HEAD: `49eda6b46dd086edad8b9e4178cf491e3cc67214`.

## Acceptance evidence

Verified on this macOS host with generated data:

- 369 tests across 37 core blob, App, client, archive, and recovery files.
- 57 desktop host/account tests, including real HTTP streaming, range and
  cancellation cleanup, private uploads, and built application serving.
- 64 Whispering tests across recording, row lifetime, imports, upload, provider
  request serialization, download names, and actual ZIP contents.
- Native library: 155 tests passed with two ignored, followed by the newly added
  Stop collision/retry test passing separately. Desktop transport has 34 tests
  included in the core suite. These counts describe distinct runs, not a sum.
- Blob, client, App, server, host, and both Whispering target typechecks passed.
- Native Stop publishes WAV and returns a full key; independent Bun get/stat/list
  and descriptor opening work after the recording session closes. FFprobe reports
  PCM s16le, mono, 48 kHz for this Stop output; FFmpeg decodes it successfully. Cross-runtime
  grammar, collisions in both directions, and 20 publication races passed.
- Browser App recording Stop saved actual MediaRecorder output, then App-owned
  local.open played it through HTML audio after page reload in both engines.
  Microphone acquisition alone used a generated oscillator stream.
- Real recording rows export as `recordings.zip`; unzipping verifies titles,
  transcripts, complete audio references, and ordinary Markdown files. Browser
  anchor and native save-dialog adapters preserve complete filenames.
- Explicit upload tests preserve local bytes, independently mint remote keys,
  enforce private ownership, and preserve provider MIME. New archives restore
  exact bytes, retain hosted URLs, and safely retry prepared operations.

| Engine | Producer MIME | Saved suffix/type | 65 objects, 256 MiB: list plus stat | Process-tree RSS delta |
| --- | --- | --- | --- | --- |
| WebKit | audio/mp4; codecs=mp4a.40.2 | .m4a, audio/mp4 | 111 ms | +832 KiB |
| Chromium | audio/webm;codecs=opus | .webm, video/webm | 18 ms | -7456 KiB |

The browser fixture forbids value-reading IndexedDB APIs during list/stat.
RSS includes the harness and descendants, not every possible reparented engine
process. Garbage collection can make its delta negative. This is an observation,
not a memory bound, allocation measurement, or disk-I/O result.

## Caller refinement

The follow-up caller review keeps the blob contract and moves publication out of
Whispering's processing pipeline. Imports and voice-activated capture use
`saveAudioRecording` to publish bytes and create a row. Manual Stop already
publishes bytes and creates its row directly. All three producers enter the
pipeline with a recording ID; row creation owns initial descriptive and
transcription fields. Availability is `local`, independently of `audioUrl`.

An independent review accepted these boundaries. Follow-up tests cover captured
inference during deferred publication, admitted saves completing after UI
admission closes, retirement preserving bytes without a row, and voice-activated
save failures updating feedback. Real blob/row fixtures verify that repeated
pipeline execution creates no additional bytes or rows. This is not a test of
clicking the UI's transcription retry action.

An adversarial review caught a shutdown regression: retirement after successful
publication must end quietly so producer draining can release the library. The
helper returns no row in that case, retaining the bytes. Caller tests cover
retirement through import departure and voice-activated producer draining.

The refinement passed 63 tests across eight files in separate focused runs and
both Whispering target typechecks. The production host build passed. Root
typechecking still reports the same 12 baseline `packages/data` diagnostics.
`recordings.zip` contains Markdown and audio references, not audio payloads.
Saved-byte/archive recovery does not promise recovery of unfinished microphone capture after restarting the application.

## Remaining acceptance work

Implementation work and automated integration are complete. This spec remains
In Progress to track acceptance that has not been exercised:

- [ ] Physical microphone recording and installed desktop WebView playback.
- [ ] A real OS save dialog/download journey and an authorized real hosted
  provider upload/playback/delete journey. Mock transport proves neither.
- [ ] Windows execution of Bun and native publication, and abrupt-power-loss
  durability. Windows native publisher and tests cross-compiled to metadata;
  that is no evidence of execution. Other supported operating systems also
  need their own end-to-end runs.

No migration, reset, orphan inventory, compatibility parser, or remote cleanup
remains. The user confirmed there are zero users and no existing data. Delete
this spec after recording the outstanding acceptance results; durable design
already lives in the package documentation and amended ADRs.

Useful current commands:

```sh
bun test packages/blobs/src
bun test packages/app/src/recording
bun test apps/epicenter/src/server.test.ts apps/epicenter/src/account-transport.test.ts
bun test packages/client/src packages/server/src/routes/blobs.test.ts
bun packages/blobs/scripts/native-smoke.ts
bun packages/blobs/scripts/native-flat-smoke.ts
bun packages/blobs/scripts/browser-smoke.ts
bun run --filter @epicenter/blobs --filter @epicenter/client --filter @epicenter/app typecheck
bun run --filter @epicenter/whispering typecheck
```

Root typecheck currently fails in `packages/data` for missing DOM globals and
four benchmark diagnostics. An isolated task-start snapshot with independent
dependencies reproduces every diagnostic. Landing's missing `@astrojs/svelte`
messages also reproduce but its check exits successfully. Documentation hygiene
still reports 58 ADR status issues, the same count as the task-start snapshot;
text amendments change some messages. Do not
attribute these baseline failures to this change or silently repair unrelated
work to make the overall check green.
