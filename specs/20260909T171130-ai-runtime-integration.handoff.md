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
- ADR-0365: actual SDK clients through `app.ai.runtime`, `app.ai.account`, and
  `app.ai.configured()`, with a separately planned portable dictation lifecycle.
- ADR-0373: product operations access the page-owned App when invoked.
- ADR-0374: the host owns one Account and restarts applications on replacement.
- ADR-0375 and ADR-0369: one selected library per application document.
- ADR-0376 and ADR-0380: construction chooses resources; the opened App owns their
  scope and shutdown, and recording must publish bytes that its App can read.

The relevant plans are:

- `specs/20260908T193514-app-ai-capabilities.md`
- `specs/20260909T085106-application-runtime-composition.md`
- `specs/20260908T212054-whispering-call-time-app-composition.md`
- `specs/20260908-ai-client-and-portable-dictation.md`
- `specs/20260909T004225-library-ownership-execution.md`

Several checkpoints lag code. For example, ADR-0365 still calls App AI unbuilt,
but `packages/app/src/ai.ts` already exposes those SDK clients and owns their
shutdown. Its configured connection IDs, credentials, and selections live in
`ai-configuration.ts`. Current Whispering completion/transcription and the shared
picker already contain consumer migrations. Assess what still needs removal or
real evidence before proposing another migration.

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
   existing export. Do not make that full feature a prerequisite for finishing
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
