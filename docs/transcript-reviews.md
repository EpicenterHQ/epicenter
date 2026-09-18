# Transcript reviews

Crossing off a transcript means its useful decisions and follow-ups have a
written home. It does not mean its proposed implementation shipped. Retained
transcripts are historical evidence; deleted exports are identified below.
Current code, ADRs, and active plans must be read together.

## Reviewed

- [x] `codex-session-01a09818-1756-7291-bd5b-817145613256.md`:
  independent blobs, working-copy recovery, and optional application copying.
  Decisions preserved in ADRs 0392 through 0395, 0399, and 0401; execution in
  the [completed backup cleanup](adr/0379-reconstruction-is-an-explicit-destructive-library-operation.md)
  and [App scopes plan](../specs/20260912T112824-app-hub-and-whispering-transcription-collapse.md).
- [x] `codex-session-01a09819-f0c2-7a93-a621-aa33f2c21de2.md`:
  runtime platform selection and full-trust host permissions. Proposals and
  remaining download choice preserved in ADRs 0402/0403 and the
  [platform plan](../specs/20260912T120000-app-composition-greenfield.md).
- [x] `2026-09-15-101019-look-at-the-current-adrs-and-then-based-off-them.txt`:
  broad ADR-versus-code audit. Reviewed 2026-09-15; disposition and surviving
  findings below. The duplicate supplied path was reviewed once.

- [x] `codex-session-01a0842d-5563-7d62-adc0-4e0c387bd239.md` (export deleted at the user's request on 2026-09-15):
  explicit core reads survive under ADR-0371. The public nullable blob API is
  overridden by ADR-0393; recorder getter removal remains conditional on
  notification/session-cleanup evidence in the [core-read plan](../specs/20260908T204224-explicit-core-reads-and-blob-capabilities.md).
- [x] `codex-session-01a08726-8dd2-7ae3-887e-0310510e68ab.md` (export deleted at the user's request on 2026-09-15):
  development sign-in repairs are committed. The uncompleted real
  browser-to-desktop success check is preserved below and belongs to the
  [one-account plan](../specs/20260908T214916-one-active-account.md).
- [x] `codex-session-01a0872e-a566-76e3-9b84-ba18e0cb6390.md` (export deleted at the user's request on 2026-09-15):
  session ownership and per-input native capture survive in ADR-0366 and the
  [concurrent capture plan](../specs/20260912T122859-concurrent-native-capture.md).
  Its single-library App, public blob API, shared dictation, and durable restore
  attempt proposals are overridden as described below.

## Broad audit: what survives

The audit identifies implementation gaps; it does not introduce a replacement
product direction. Its suggested sequence predates the current attachment
contract. Most of its work already belongs to active plans.

| Transcript claim or recommendation | Current disposition |
| --- | --- |
| Device/account App and explicit inference selection | Composes with the current direction. Automatic attachment delivery is withdrawn; blob hosting is explicit and separate from App scope selection. |
| Build the entire App hub before attachments | Overridden. Stop already saves an app-local BlobId before row creation. Preserve that implementation while scopes and transcription change. Scope and platform work have their own dependencies. |
| Delete recovery code immediately because it is unexported | Overridden by the current recovery waves: replace fixtures and consumers, verify, then remove superseded code and tests. Lack of a public export alone does not establish safe deletion. |
| No ADR names removal of native active-model resolution | ADR-0397 already names that removal. Inventory actual administration/residency callers before deleting anything beyond the obsolete transcription path. |
| Add an R2 binding before backups can work | Not required by the product contract. Current byte storage uses a portable S3 adapter, with list/delete operations. Explicit hosting remains; no new retention or library-delivery protocol is required. |
| Host permissions can change independently | Preserved by the platform plan. Platform selection and full native authority remain distinct decisions. Neither implements account synchronization. |
| Bun self-host lacks store sync | Still true of its entrypoint and already listed under the library-ownership plan's remaining work. |
| Fix every old ADR before any implementation | Too broad. Some records describe current code or have amendment pointers. Reconcile actual contradictions on their affected execution tracks; historical wording is not an alternative target. |

The current recording promise remains: applications choose the destination
through library APIs; Local records and app-local bytes stay in the app across
sign-in; account rows synchronize, while remote blob hosting is explicit and
separate. No mandatory picker, adoption prompt, automatic byte transfer, or
per-recording upload preference follows from this audit.

## Attachment target frozen, 2026-09-17

ADR-0393 and ADR-0366 now require finished-file creation and disposable capture.
Rows store ordinary local BlobId and remote URL values; no row owns a blob's
lifetime. A row with unavailable bytes is still an ordinary row. The workflow
retains its destination before capture; successful Stop commits local publication,
then the application creates the recording row. Unfinished capture may be lost before Stop; no native crash
recovery or automatic remote delivery is promised. Saved durability, live
session cleanup, and original inference ownership remain.

Commit 09b1965e55 implements the superseded row-first checkpoint. Its passing
counts and prior reviews remain evidence, not acceptance of the replacement.
The [cleanup evidence](adr/0379-reconstruction-is-an-explicit-destructive-library-operation.md#implementation-evidence)
identifies preserved tests and the Git checkpoints containing historical
publication, response-loss, retirement, and offline-owner findings. Those records
are audit evidence, not instructions to rebuild byte synchronization.

## Findings carried forward

### Legacy generation startup and evidence

On 2026-09-15, `bun test packages/server/evidence/library-ownership/foundation.test.ts`
returned **7 pass, 2 fail** on the existing working tree:

- Independent device initialization fails with a generation fetch 404.
- The unadmitted-generation socket test expects 404 and receives 403.

The client calls `GENERATIONS_ROUTE.initial`, but
`packages/server/src/store-sync/mount.ts` mounts current-library routes, not
that legacy initial route. `apps/skills/src/lib/application.ts` still calls
`resolveGeneration`; it is not dead code. The three store apps use the App's
current-library startup instead.

Before integrating the existing generation edits, reconcile this caller and
its evidence with current-library startup. Do not blindly discard another
session's diff or delete the caller. This belongs with the
[library-ownership execution work](../specs/20260909T004225-library-ownership-execution.md).
The failures were reproduced here; no clean-baseline comparison was run to
attribute each failure to a particular edit.

### Self-host credential documentation

Both `apps/self-host/worker/index.ts` and `apps/self-host/server.ts` resolve
named-user sessions. ADR-0375 reflects that implementation. ADR-0361 and parts
of the [one-account plan](../specs/20260908T214916-one-active-account.md)
still describe static operator-token entry. Reconcile the intended client
sign-in flow with the deployed server contract before implementing those
steps. The recording decision does not settle or repair this mismatch.

Bun store sync is separately recorded in the library-ownership plan; no new
backlog item is needed for it.

### Storage transport and documentation reconciliation

`packages/server/src/routes/blobs.ts` uses the portable S3 adapter, and the
Cloud Worker, self-host Worker, and Bun self-host all mount these live routes.
Preserve that explicit-hosting deployment inventory during the caller audit.
An absent R2 binding does not establish absent R2 storage. No new retention or
reclamation protocol is required by document-only materialization.

The audit's documentation list has mixed outcomes. ADR-0324 already links its
address amendment; ADR-0399 now explicitly makes copying optional; ADR-0397
names active-model resolution removal. Other discrepancies remain worth
reconciling on the relevant tracks: ADRs 0314/0334 still claim no installation
plane despite `apps/epicenter/src/app-installation.ts`; ADR-0316's Built header
describes an older factory; ADR-0362 uses present tense for the active-model
target; ADR-0376 still names shared App dictation that ADR-0366 withdrew.
These observations are not permission to rewrite accepted decisions or delete
working code. They no longer depend on retaining the audit chat as active work.

## Review limits

This review read the supplied text and checked its main consequential claims
against local artifacts. It did not inspect the externally published HTML
artifact, reproduce the original six-agent audit, measure deletion counts,
or verify every historical ADR claim. No runtime changes were made.

## Core reads, development sign-in, and capture synthesis

Reviewed 2026-09-15. All user turns, substantive assistant conclusions, and the
referenced eight-session comparison were read; repeated tool output was sampled.
Retiring the synthesis does not individually audit or retire the eight other
transcripts it mentions.

| Transcript | Keep | Overridden or qualified |
| --- | --- | --- |
| `01a0842d` | Explicit core observations and queries; reactive Svelte properties; fixed facts stay readonly; no blanket getter ban. | The public `app.blobs.remote` now exposes explicit hosting, not library-owned delivery. A local recording can still use a separately selected account inference connection; storage scope is not inference scope. |
| `01a08726` | Minimum Bun version, local API startup, rebuilt sign-in UI, cancellable sign-in, and development loopback callback. | These repairs compose with the future App; do not repeat them as unbuilt overhaul tasks. Historical test counts are not new verification. |
| `01a0872e` | App resource lifetime, product workflow drain, returned session identity, per-input capture reservations, typed contention, independent cleanup. | ADR-0392 replaces one library per App with scopes; revised ADR-0393 stores ordinary blob references after local publication; shared `app.ai.dictation` is withdrawn; ADR-0395 uses the current working copy rather than durable restore attempts; the package selects platform implementations under ADR-0403. |

### Explicit-read migration remains bounded

The core-read plan retains `getState`, `list`, and `getNonconforming` where
those current core surfaces survive. It must not reconstruct a deleted backup
runner just to rename its pending getter. Likewise, an auth status abstraction
scheduled for deletion is not a reason to create another status method.
The existing public recorder `endedReason` is removed only after proving late
`onEnded` notifications, unsubscribe, registration-gap reconciliation, and
live cleanup. Preserve internal/native state only where that lifecycle needs
it; revised ADR-0366 withdraws automatic unfinished-capture recovery.

The old nullable remote-member proposal is historical. Current
`app.blobs.local` and account-scoped `app.blobs.remote` are the implemented
independent APIs, not an intermediate attachment-synchronization design.

### Development sign-in verification remains specific

The implementation is preserved in commits `0a7128767e`, `6265542ed3`,
`bf2633af59`, and `d804196cec`. Current root scripts start the local API with
Epicenter, and the host README documents the dev loopback callback and
packaged callback distinction. No dependency on the new attachment model is
introduced by these fixes.

The transcript reports 244 targeted tests and successful typechecks, but its
final successful browser authentication and return into the desktop was not
verified because the Mac locked. This review did not perform that live check
or re-run those suites. Preserve that acceptance case in the one-account
execution track; opening the browser or a passing callback unit test is not
proof that the person completed sign-in.

### Capture evidence is still pending

The current concurrent-capture plan already requires actual capture on two
separate input devices, same-device busy errors, session-specific events,
cleanup during startup, and preservation of another App's capture on close.
Two channels of one interface and multiple saved recordings within one App
are not promised. The transcript supplies design/source evidence, not a
successful hardware test. Its old instruction to add portable shared dictation
must not be executed; applications compose capture and transcription.
