# AI and runtime integration

Status: In Progress

## Connection migration checkpoint: 2026-09-10

The custom connection migration is complete in the working tree. Core App owns
`app.ai.connections`; Whispering and Vocab own plain TypeScript selection
handles. The picker and operations share exact source matching. The old combined
configuration owner, exports, and duplicated routing branches are removed.
The completed API spec and launcher were retired; ADR-0365 and the App README
record the implemented boundary and migration procedure.

Initialization uses one Web Lock per settings prefix. Pre-ID settings first
become one committed ID mapping, then separate connection and selection stores.
Existing destination stores win, including empty ones; successful writes survive
an interrupted split. Connection-only callers can initialize normalized records
without parsing selections. Synchronous owners refuse uninitialized legacy data.
Old bytes remain recovery data and receive no steady-state writes or observation.

Independent review retained these boundaries and found two construction gaps.
The selection owner now refuses a pre-migration open, preventing new choices
from hiding old scopes. Both application bootstraps release selection observation
if synchronous App construction throws, preserving the original failure even if
cleanup also fails. Regression tests reproduce both failures before the repairs.

Verification from this checkout:

| Check | Result |
| --- | --- |
| App, native protocol, connection lifetime/storage | 67 tests pass |
| Selection, migration, picker | 26 tests pass |
| Agent chat | 10 tests pass, separate process |
| Whispering operations/publication/recording close and Vocab dictation/practice | 49 tests pass, mock-sensitive suites in separate processes |
| Actual application bootstrap failure cleanup | 4 tests pass, separate processes |
| Account lifetime/refusal/browser auth and departure | 43 tests pass |
| Browser and desktop saved-recording contracts | 36 tests pass |
| Platform selection and import seams | 4 tests pass; browser output excludes native inference commands |
| App, app-shell, Vocab, Whispering browser/host typechecks | Pass |
| Whispering browser and host builds | Pass |
| Root typecheck | Same eight starting Data errors |
| Document hygiene and paths | 44 existing hygiene findings; ten dead paths outside this change |

`bun packages/app/scripts/ai-connections.browser.mjs` passes actual Chromium
concurrent initialization, stable IDs across reload, exact SDK URL/bearer/model,
and cross-document selection/deletion without fallback. Its compatible endpoint
is a local protocol fixture. The product run separately passes the actual picker,
recording, real cached Whisper Tiny, real Ollama Polish, playback, exact uploaded
bytes, and reopen in Local, Personal, and Shared. New assertions prove separate
stores survive reload and contain no serialized SDK client. No browser errors or
external requests occurred. The first product attempt was interrupted by Vite
hot updates during capture; the acceptance harness now disables HMR and the
complete rerun passes.

The native SDK smoke and actual Wry/IPC smoke both pass against the existing
speech WAV and cached model, including invalid/empty input, exact hints/model,
retirement, draining, denied model administration, unchanged settings, and no
CSP violations. These are file-inference checks, not native microphone evidence.

Logs, baseline status, patches, and original copies of the previously untracked
API spec/launcher are in `/tmp/ai-connections-20260910/`. Final product evidence
and inspected screenshots are in
`/var/folders/qx/9462vg517cvdtpjr4tt32_200000gn/T/whispering-recording-evidence-jHwptN/`.
Browser migration evidence is in
`/var/folders/qx/9462vg517cvdtpjr4tt32_200000gn/T/ai-connections-evidence-WAzQSE/`.
Checked-in scripts remain the reproduction procedure; temporary paths identify
this run only. No commit, deployment, model download, production-data change,
or real credential change was made.

`system_profiler SPAudioDataType` still shows no controllable loopback input.
Host microphone capture, host playback/reopen, and reload recovery remain the
active tasks below. Portable dictation remains separate.

## Integration evidence: 2026-09-09

The actual Whispering browser workflow passes in Local, Personal, and Shared:
select a connection/model, record, save, transcribe with real Whisper Tiny,
Polish with real Ollama, play the audio, and reopen identical bytes and both
transcripts. The final run has no browser errors or external requests.
Native file inference separately passed a real Wry WebView using production
permissions and host CSP. The host AI leaf now supplies that verified adapter.

Native microphone capture, host blob playback/reopen, and active-capture reload
recovery remain unproved. No controllable CoreAudio input fixture was available.
This leaves the wider runtime and library specs active. File inference does not
complete portable microphone-to-text dictation.

### Delivered repairs

- Whispering opens its selected library before creating UI consumers. Local
  receives no ambient Account; Personal and Shared retain the authenticated actor.
- Transcription captures its client, model, credentials, and hints before reading
  saved bytes through `app.blobs.get()`. Removed or mismatched selections never
  redirect to another destination. Shared never guesses a Personal native path.
- The shared picker supports manual account, configured, and installed native
  model choices. Previous OpenAI/Groq/speaches fields have an explicit import
  action. Deepgram, ElevenLabs, and Mistral retain their distinct protocols.
- Native file inference preserves empty-audio success, applied-hint metadata,
  and exact model identity. It leaves active-model settings alone and drains
  computation while suppressing cancelled output.
- Recording, imports, and manual/bulk retries share complete-work draining.
  Account replacement stops follow-on inference and delivery. An admitted stop
  still saves after UI admission closes; failed row creation still rejects so
  the caller retains its source. App retirement suppresses late history/output.
- Browser leaves supply clipboard, fetch, downloads, focused shortcuts, and the
  existing recording pill. Native-only UI effects no longer run in browser tabs.
  The UI session remains because it owns real subscriptions and query teardown.

### Reproduction and scope

| Command from root | Evidence |
| --- | --- |
| `bun packages/app/scripts/recording-libraries.browser.mjs` | Real MediaRecorder and temporary authenticated Worker: Local, Alice/Bob Personal isolation, Shared row convergence, exact bytes/playback/reopen, owner-override 403, cancellation, meter and playback-source release, zero Local authority requests. |
| `EPICENTER_NATIVE_AUDIO=/path/speech.wav bun apps/whispering/scripts/saved-recording.browser.mjs` | Actual Whispering UI in all three libraries. Saved/uploaded digests match, raw and polished text persist, library switching closes first. The browser uses an authenticated temporary endpoint backed by the real native engine; no production discovery bridge is added. |
| `EPICENTER_NATIVE_AUDIO=/path/speech.wav bun packages/app/scripts/native-ai-smoke.ts` | Actual SDK multipart, native commands/decoder/cached model, invalid input, exact hints/model, output suppression and drain. This fixture uses Tauri MockRuntime. |
| `EPICENTER_NATIVE_AUDIO=/path/speech.wav bun packages/app/scripts/native-webview-smoke.ts` | Actual macOS Wry/IPC, production app ACL/CSP, native transcript, empty input, denied model administration, retired-client refusal, unchanged settings, no CSP violations. No microphone or Account opens. |

Native scripts require the already-cached
`handy-computer/whisper-tiny-gguf@main/whisper-tiny-Q8_0.gguf` model.
The run used `/tmp/app-ai-baseline/native-speech.wav`; Polish used installed
Ollama `qwen2.5vl:3b`. No model was downloaded.

The final isolated UI report and inspected screenshots are in
`/tmp/ai-runtime-integration-20260909/workflow-candidate/browser-ui-evidence/`.
The original live UI report remains in
`/var/folders/qx/9462vg517cvdtpjr4tt32_200000gn/T/whispering-recording-evidence-DDV2rm/`.
Package browser evidence is in
`/var/folders/qx/9462vg517cvdtpjr4tt32_200000gn/T/app-recording-evidence-6Arf0l/`.
Native logs and focused checks are under `/tmp/ai-runtime-integration-20260909/`.
Scripts clean their processes and temporary test state. These paths are local
run artifacts; the checked-in scripts are the durable reproduction procedure.

### Committed integration

| Commit | Working outcome |
| --- | --- |
| `89e2cf28f8` | One runtime declaration, App-owned saved recording, and all constructor/import consumers. |
| `fcdf6bfddc` | SDK clients and explicit destinations across the picker, agent chat, Vocab, and Home. |
| `6cb62c11d4` | Whispering library selection, saved-recording workflow, browser leaves, native inference, and reproducible acceptance scripts. |

Each code commit was checked in an isolated snapshot with workspace dependencies
pointing into that snapshot. Runtime has 132 focused passing tests; SDK has 98.
The workflow snapshot has 106 App/recording tests and 77 Whispering tests passing,
including platform and selection checks, plus both typecheck leaves and builds.
Real native checks cover 23 transcription regressions, one cached-model test,
two capability tests, binding coverage, SDK protocol, and actual SDK/Wry inference.
The UI run initially stopped on Vite's allowance for shared installed dependencies;
the checked-in test harness now permits the resolved Bun cache, and the retry
passes without serving another checkout's application source.

The additional unchanged Vocab boot guard expects the removed
`ConversationsSession.svelte` component while its page mounts `VocabShell`.
Its failing assertion and unchanged-file comparison are preserved in the SDK
packet. This is separate from the passing SDK dictation and practice tests.

Concurrent restore commit `b577421734` landed between the SDK and workflow commits.
The final workflow patch preserves it. Auth, backup, and the proposed AI API
conversion retain their separate ownership. Native comment corrections were
reviewed separately and both binding files were regenerated by `export_types`.

### Additional working-tree checks

Focused checks pass: 25 AI/native/SDK-stream tests; 56 App tests; 151 auth and
departure tests; 36 recording-contract tests; 9 picker tests; 10 agent-chat tests;
3 Vocab dictation tests. Whispering's publication, completion, Polish,
transcription, pipeline, import/retry, capture/recovery, and domain suites run in
separate processes. Use `bun test --tsconfig-override .svelte-kit/tsconfig.json
<file>` from `apps/whispering` for its aliases. Bun 1.3.14 still prints an internal
directory-mismatch diagnostic on passing runs.

The final root aggregate fails only on its eight starting Data browser-global/type
inference errors. Intermediate runs also encountered concurrent backup and auth
errors; those are absent from the final check. This integration corrected two
native adapter test assertions that treated extra protocol metadata as SDK-declared
fields. App's isolated snapshot and final live check both pass its two typecheck
leaves. Root doc hygiene reports 44 findings and the path check reports ten
existing references outside
the edited integration paths. ADR status is not changed to silence those checks.

Whispering browser and host typechecks pass with zero errors/warnings; both
builds pass; platform selection has four passing checks. Browser main and
non-overlay route imports exclude native inference and saved-recording host
commands. The unchanged shared `desktop-close.ts` still imports Tauri core/event
behind `isTauri()`; the entire multi-route bundle is not claimed to be native-free.

Independent review retained the App/runtime and explicit picker boundaries and
verified the lifecycle repairs above. Clipboard failure reporting remains a
separate grounded follow-up: `operations/sink.ts` discards clipboard Results and
can report successful delivery after refusal. This workflow proves saved history,
not clipboard failure recovery.

No deployment, production migration, historical-data deletion, or real credential
change occurred. Cross-device object-store attachment transfer, packaged library
selection, full offline shell startup, and backup/recovery remain in the wider
library execution. The concurrent AI API revision below keeps its own owner.

## Active execution path

The connection API conversion is implemented: `app.ai.connections` owns custom
endpoint/key management and clients; applications own workflow selections.
Whispering and Vocab initialize separate stores before opening, using a serialized
conversion that preserves IDs and recovery bytes. `configuration`, `configured()`,
and the combined owner are removed. See the [package README](../packages/app/README.md)
and [AI access decision](../docs/adr/0365-ai-owns-inference-access-and-applications-own-workflow-selection.md).
The recording/native acceptance tasks below remain active.

The continuation baseline is `9bf9183425`; status and tracked patches are in
`/tmp/ai-runtime-integration-20260909/`. The integration preserves the library
checkpoint and concurrent restore work.

The saved-recording selection, complete-work drain, browser acceptance, native
file inference, and obsolete-path removal are delivered above. Remaining work:

1. Supply a controllable CoreAudio input and prove host capture, App reads,
   playback, and reopen in Local, Personal, and Shared.
2. Reload during native capture, recover through the reopened App, then cancel
   before storage ownership releases.

Portable dictation remains a separate feature with its own acceptance target.

The initial independent review retained the App and shared picker boundaries. It found
transcription's late provider resolution, guessed Personal native blob paths,
and untracked manual/bulk retries. Native empty audio and hint handling were
compared and preserved before deleting the old route. The UI session still owns
real recording/query/subscription lifetimes and remains until replaced.

Starting App/Whispering typechecks and 11 AI/native protocol unit tests pass.
The root baseline fails on eight Data browser-global/inference errors and one
picker test assertion type. Bun 1.3.1 needs Whispering's generated SvelteKit
tsconfig supplied explicitly for tests using `$lib` aliases.

## Original handoff: historical task scope

Continue in /Users/braden/conductor/workspaces/epicenter/yamoussoukro.

Reconcile and finish the existing AI and runtime work around one dependable
Whispering workflow: choose an explicit inference destination and model, record
audio, save and play it through the same App, transcribe it, optionally polish
the text, and reopen the saved result. Deliver working code, acceptance evidence,
updated execution notes, and coherent commits. Start with a short reconciliation
of what exists and what remains; do not build a second competing abstraction.

The library checkpoint is committed as `3aff50a319`. It proves Honeycrisp Local,
Personal, and Shared against a temporary local Worker. The working tree still
contains substantial earlier AI, runtime composition, Whispering lifecycle,
SQLite, and restore work. Preserve it. HEAD and the working tree intentionally
have different constructor/recording layouts: the library commit was isolated
without committing the concurrent constructor consolidation or recording move.
Its required replica/resource changes were applied at the committed recorder
paths, while the working tree carries them at their proposed App paths. Do not
undo either side by treating HEAD as the ownership baseline.

First inspect Git status, recent commits, staged and unstaged diffs, and actual
call sites. Saved baselines include `/tmp/honeycrisp-library-baseline/`,
`/tmp/honeycrisp-library-stage/`, `/tmp/runtime-composition-baseline/`, and
`/tmp/app-ai-baseline/`; inspect what remains available rather than assuming
these temporary files persist. Check whether another session owns overlapping
files before editing them.

Read these decisions as evidence, including their status and amendments:

- ADR-0362: inference access does not require model/runtime administration.
- ADR-0363: a selection identifies the connection and model; no discovery-based
  routing or silent fallback to another destination.
- ADR-0365, the separate AI boundary proposal:
  actual SDK clients through fixed runtime/account capabilities and the target
  custom `connections` API; applications own workflow choices. App-owned
  `app.ai.dictation` remains separate implementation work.
- ADR-0373: product operations access the page-owned App when invoked.
- ADR-0374: the host owns one Account and restarts applications on replacement.
- ADR-0375 and ADR-0369: one selected library per application document.
- ADR-0376 and ADR-0380: construction chooses resources; the opened App owns their
  scope and shutdown, and recording must publish bytes that its App can read.

The relevant plans are:

- AI connection API conversion, now recorded in ADR-0365 and the App README.
- `specs/20260909T085106-application-runtime-composition.md`
- `specs/20260908T212054-whispering-call-time-app-composition.md`
- `specs/20260908-ai-client-and-portable-dictation.md`
- `specs/20260909T004225-library-ownership-execution.md`

At the original handoff, `packages/app/src/ai.ts` already exposed SDK clients
and owned their shutdown, while a combined owner persisted connection records
and selections. The 2026-09-10 checkpoint above replaces that owner and migrates
Whispering, Vocab, and the shared picker. Continue from that checkpoint.

Separate these three concerns:

1. Inference routing: `app.ai.runtime` is a capability supplied by the environment;
   `app.ai.account` uses the captured authenticated person; configured clients
   use explicit independent endpoints/credentials. The native SDK adapter in
   `packages/app/src/native-ai.ts` translates model listing and multipart audio
   into host commands. It has mocked protocol tests, but Whispering's
   `platform/ai.epicenter-host.ts` deliberately still leaves runtime inference
   absent pending native acceptance. Existing code is not proof that real audio
   reaches the native engine through that adapter.
2. Resource composition: the dirty implementation consolidates declarations into
   `defineApplication({ appId, definition, runtime?, ai? })`. Its `browser` and
   `epicenterHost` values choose compatible storage and recording; AI selection
   remains independent. Saved recording moves from recorder into App, while
   portable microphone/VAD functions stay in recorder. This is implemented in
   the working tree, but real authenticated/native record, read, play, reopen,
   active-capture reload recovery, and orderly shutdown still need acceptance.
3. Portable dictation: microphone-to-text streaming sessions and their shared
   desktop configuration are a separate feature. `app.ai.dictation` is not an
   existing export; it is the App-owned target in ADR-0365. ADR-0366 adds
   concurrent native capture on distinct input devices. Do not make those
   features prerequisites for finishing
   saved-recording transcription, and do not mistake raw audio transcription for
   completed portable dictation.

Use the product workflow to decide which remaining boundaries earn their place.
Preserve one App per document and explicit Local/Personal/Shared opening. Account
always remains the person; Shared does not replace the actor. Local opening has
no account-inference capability. Do not borrow a global signed-in Account to
fill it or add a second inference-account selector. Same-owner credential repair
preserves the App; account/server/library changes close producers and resources
before navigation. Application windows never receive server credentials.

Preserve exact model and endpoint selection, manual model entry, per-device
credentials, retained-client retirement, tool-stream behavior, and the one agent
loop. Cancellation of a JavaScript promise is not proof that Rust computation
stopped: verify output suppression and draining where compute cannot interrupt.
Do not silently redirect failed or removed selections to hosted or native work.

Use Bun, temporary local data, and existing local fixtures. No deployment,
production migrations, historical library deletion, account wallet, sharing
roles, runtime-management framework, or browser-to-desktop discovery. Keep
backup/restore work separate. Ask only for a remaining product decision or an
unavailable capability that actually blocks the chosen acceptance evidence.

Verify affected package/application tests, browser and host typechecks, build
import boundaries, and the real workflow. Start with the package scripts and
`bun test packages/app/src/ai.test.ts packages/app/src/native-ai.test.ts`;
these two files passed 11 tests on the working tree during this handoff and prove
mocked transport behavior only. Existing library evidence includes the actual
Alice/Bob UI and 31 Worker tests. Recheck relevant library/auth behavior after
integration. Run mock-contaminated consumer suites in separate processes and
state that limitation rather than reporting a passing aggregate suite.

Stop when the chosen saved-recording workflow works in its supported browser and
native runtimes, replacement/closure preserves identity and drains work, obsolete
paths are coherently removed, and execution notes distinguish UI/native evidence
from mocks. If a real native model or capture fixture is unavailable, finish
independent work and state exactly what remains unproved; do not enable the
native runtime based solely on a mock. Update stale ADR implementation notes
without silently changing decision status. Leave portable dictation as an
explicit follow-up with its own acceptance target.
