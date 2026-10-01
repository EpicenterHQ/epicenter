# Store-relative recording implementation evidence

Historical evidence: the Personal audio copy path and its browser harness were
removed during the hosted blob authority cutover. The results below describe the
earlier implementation, not the current Whispering UI.

Date: 2026-09-23. Task baseline: `f6e51408a5c811c34e1adb0321c28639ffd6200a`.
Decision foundation: `8e02241510`. The foundation documented the design; it did not
implement it. The continuation narrowed copying to declared scalar values and
omission of Whispering's unused content node.

## Implemented boundary

Capture and import publish Local bytes and a Local row. Local initializes once
from admitted boot and does not wait for Personal. Ready Personal descendants
capture a non-null context handle. Shared recording views receive a concrete
store. Playback, download and transcription use that store's bytes; transcript
writes use its row.

Save to Personal captures values before awaiting copy, uses the returned fresh
BlobId and creates a fresh row. It omits source ID/content. Edits and deletions do
not propagate. Device-durable completion requires flush, saved status and a fresh
row check. A Personal row reaching another client is a separate sync observation.

Document-owned Finish saving actions retain known bytes, values, row IDs and
inferred text across route changes. Retry does not reupload, create another known
row, or infer again. Missing/nonconforming rows and conflicting text stay failed.
The bounded registry refuses new output before capture/inference when full.
Departure fences publication before navigation and prevents successor-account retry.

## Deletion achieved

Removed `remoteAudio`, account envelopes on recording rows, Local-first remote
fallback, uploaded badges, the upload operation, selected-library state/UI and its
preference. Removed public Personal store identity while retaining private Account
capture, open constructors and distinct blob capabilities. Removed duplicate audio
availability queries and the obsolete synchronous `createRecording` publication API.
The player owns one source, disposal, loading/error state and explicit reopening.

Replaced two stale selected-library browser scripts with the current product-flow
harness. Native recorder and direct runtime-transcriber implementations remain.
The generic content node API/storage key/codec and transcript scalar schema remain.
ADR-0425 and other Proposed schema changes were not adopted.

## Review adjudication

Each checkpoint used two fresh independent read-only Codex reviewers. An initial
second-reviewer allocation failed at the runtime thread limit; a fresh retry
succeeded. Neither reviewer edited the checkout.

- Wave 0 retained store-relative ownership and identified readiness/recovery gates.
  The user subsequently authorized the absolute clean break.
- Revised wave 1 retained module Local and ready-only Personal context. Accepted
  capacity refusal before manual/VAD admission and reconciliation of transcript
  retries after accepted writes. Deleted the `accepted` shortcut that could clear
  retained text after its row was deleted. Added post-flush row checks.
- Wave 2 retained concrete store readers. Accepted the common deletion prize:
  remove availability preflight and let the player own acquisition/retry. Fixed
  wrong-worker readiness, Personal titles/descriptions, the Local-only history
  link after Personal transcription and bulk mutation query ownership.
- Wave 3 retained document-owned publication receipts. Both independently ran
  eight copy/publication tests with 25 assertions and found no integrity blocker.
  Accepted removing the unused synchronous creation path and correcting failure
  text that promised a Finish saving action when no receipt existed.
- Wave 4 retained document-owned recovery and explicit store ownership. Accepted
  the final-utterance regression: ordinary VAD stop now retains its reservation
  through the stop callback, suppresses new admission, and releases unused capacity
  after success. Failed stop restores admission. Departure disposal still discards.
  The reviewer independently confirmed the repair: 24 tests, 93 assertions.
  Both reviewers identified stale architecture/state guidance; those passages now
  describe module Local, ready Personal context and containing-store audio reads.
  The other reviewer independently ran 15 recovery tests with 40 assertions.
  The optional forwarding-helper deletion was declined: the paired read/open audio
  helpers keep the existing recording-domain boundary without new state.

## Verification

Commands run from the repository root with `/Users/braden/.bun/bin` on PATH:

```sh
bun test --isolate apps/whispering/src/lib/operations \
  apps/whispering/src/lib/whispering apps/whispering/src/lib/queries \
  packages/app/src/open-store.test.ts packages/app/src/app.test.ts \
  packages/app/src/blob-copy.test.ts packages/app/src/store-blobs.test.ts \
  packages/server/src/middleware/cors.test.ts
bun run --cwd packages/app typecheck
bun run --cwd apps/whispering typecheck
bun run --cwd apps/whispering build
```

The final cumulative suite passed 161 tests with 553 assertions across 25 files.
Both Whispering typecheck targets passed with zero errors/warnings; the app package
typecheck and browser production build passed. `git diff --check` passed.
Changed TypeScript/script lint reports one existing `noAssignInExpressions` error
in `packages/app/src/open-store.ts` at `closeBlobs`; the identical expression was
verified at the task baseline. No new lint errors remain. This is not a claim of
a clean repository-wide lint run.

The actual UI harness uses installed Chrome, fresh profiles, temporary self-host
Worker state, a local S3 fixture and deterministic inference. It blocks external
HTTP/WebSocket destinations. It configures fixture inference through the real
catalog and drives capture/copy/transcription/import/download through product UI.
Only the boot/session observer and storage/transport fault injection are test hooks.

Observed product checks include:

- Signed-out and signed-in synthetic capture creates Local bytes and durable rows.
  Capture from the Personal page leaves Personal empty until an explicit copy.
- Local reload and ready-only Personal provider mounting succeed.
- Editing Local while the upload is held preserves pre-await destination values.
- Real IndexedDB write refusal retains the row ID. Finish saving on another route
  clears the debt without another byte upload or row creation.
- Personal playback uses the root controlling worker. Invoking the captured expiry
  timer produces HTTP 410; Reopen audio acquires a new source. This injects expiry
  instead of claiming a five-minute wall-clock soak.
- Reload and a second profile containing only auth state read Personal rows/audio,
  while the second profile has no Local recordings. This establishes remote
  delivery independently of the first client's flush result.
- Personal download and transcription work without Local bytes. Transcript
  persistence retry after IndexedDB refusal survives route changes with one
  inference request.
- Delayed Personal does not block Local capture. Dependent inference waits and
  receives the captured Account's prompt and dictionary.
- Failed Personal acquisition leaves Local capture and file import working.
- Sign-out emits the captured departure abort before held document navigation.
  Releasing the late upload while navigation is held does not publish another row.
  The harness returns HTTP 204 for that navigation, keeping the retired document
  available to inspect after the hold; it does not claim a successful sign-out reload.

Complete browser evidence: `/var/folders/qx/9462vg517cvdtpjr4tt32_200000gn/T/whispering-recording-evidence-qDavgk/result.json`.
The run had no uncaught page errors. Earlier harness attempts exposed test-driver
navigation waits and were corrected before this complete run.

Product verification exposed two integration defects that unit probes missed:
the worker asset was served below the wrong copied path, and CORS overwrote the
current-download response's exposed generation/log-position headers. The build
now strips the source path; the trusted-origin middleware exposes both headers.

## Clean-break disposition and limits

The executing user explicitly refused legacy compatibility. This disposition
covers existing rows, old clients and their later pending offline writes. No
migration, compatibility/version gate or fallback resolver was added. Old Personal
rows may still name Local bytes and old Local rows may still contain remote
references; replacement readers do not reinterpret those addresses.

No actual user data was migrated, reset or deleted. No production deployment or
remote push was performed. Unrelated dirty skill/blog/session work is excluded.

Synthetic microphone evidence does not establish physical microphone behavior.
The deterministic endpoint does not establish model accuracy. The S3 fixture and
self-host Worker do not establish production S3 deployment health. Existing direct
native transcription is preserved and covered by focused tests, but this run does
not claim packaged native microphone or native-model UI acceptance. Page reload
ends in-memory recovery; it is not a persistence acknowledgement.


## Changed files and completion

The task changes these boundaries; each commit's file list is the complete manifest:

- `apps/whispering/src/lib/whispering/`: Local and Personal handles, resource/session
  composition, pending saves, worker readiness and recording helpers/tests.
- `apps/whispering/src/lib/operations/`: Local capture/import, durable publication,
  independent Personal save, retained transcript persistence and same-store readers.
- `apps/whispering/src/lib/queries/`: per-view transcription/download ownership;
  deleted audio availability query.
- `apps/whispering/src/lib/components/` and `src/routes/(app)/`: ready Personal
  provider, explicit history routes, playback and Finish saving, settings callers.
- `apps/whispering/src/lib/state/`, `shortcuts/` and `utils/`: Local callers without
  an app-owned store selector; corresponding documentation.
- `apps/whispering/src/lib/data.ts`, `vite.config.ts`, `scripts/` and documentation:
  relationship removal, root worker packaging and isolated product verification.
- `packages/app/`: public identity removal, runtime/type regressions and README.
- `packages/server/src/middleware/cors.ts`: expose store-download protocol headers
  to trusted browser origins, committed separately from the product clean break.
- ADR-0428 and ADR-0429: implemented ownership and private-account contracts.
  Removed the completed execution plan, handoff and continuation plan.

No implementation blocker remains from the five wave checkpoints. Physical/native
acceptance and production infrastructure remain unverified as described above.
