# Transcript reviews

Crossing off a transcript means its useful decisions and follow-ups have a
written home. It does not mean its proposed implementation shipped. Retained
transcripts are historical evidence; deleted exports are identified below.
Current code, ADRs, and active plans must be read together.

## Eight-export review, 2026-09-20

Reviewed at `eef712ceac6796a0b89c0075f7974d1644ca0646`, including the
pre-existing uncommitted Mail storage and Whispering ownership changes. Read
the conversational turns throughout all eight exports; searched activity logs
and inspected relevant evidence selectively. Historical test totals and live
mail observations are not fresh verification. No production source was changed.
During review, HEAD advanced to `fd30a306b0` through an unrelated agent-guidance
commit. It changed none of the application source supporting these findings.

Four exports describe completed or superseded work. Two more can leave after
preserving their product direction here. Keep the last two as temporary
references for still-actionable work. They are mixed histories, not plans to
execute from top to bottom.

| Export | Disposition | Current grounding and surviving value |
| --- | --- | --- |
| `codex-session-01a0af68-0807-7501-b307-bb518be8a6ec.md` | Deleted: superseded startup assessment | Historical browser generation helpers and the production `_initial_generation` experiment are gone. Skills now calls `openApp`. The inert declaration and current opener are implemented. Its Vocab boot failure no longer reproduces. The [startup report](reports/20260917-startup-and-unfinished-work.md) preserves the checkpoint; its next-step ordering is historical. Skills' product purpose and physical acceptance remain separate questions. |
| `codex-session-01a0b345-aae0-7a41-89f3-c6fb70ce1877.md` | Deleted: repairs and package collapse completed | App, app-shell, and Whispering package test scripts use `--isolate`. `packages/data` is gone; the App root exports `defineApp`, `defineTable`, and `field`, with the engine under `src/data`. The late proposal is now implemented by [ADR-0407](adr/0407-app-owns-the-declaration-and-data-engine.md) and later opener amendments. Do not restore its earlier claim that the separate data package is necessary. |
| `codex-session-01a0b36b-572c-7560-92a6-7ca714680133.md` | Deleted: completed SQLite explanation | [SQLite ownership](../packages/device/src/owner.ts) and its tests preserve connection closure, drain, pool release, and failure retention. Later App admission owns cross-context exclusion. The old explanation is not another unfinished redesign. The unused returned `drain` method is separately covered by the retained audit. |
| `codex-session-01a0b46e-1f3e-72e2-ac68-7cabf6278cda.md` | Deleted: completed runtime verification | [The opener](../packages/app/src/open.ts), [memory runtime tests](../packages/app/src/runtime.test.ts), and [browser admission evidence](../packages/app/evidence/data/app-ownership/browser.ts) preserve the result. `await openApp` returns a ready App; there is no public `app.ready` phase. Its final WebKit rerun supersedes its earlier failed observation. Browser checks were not rerun in this review. |
| `codex-session-01a0b1dd-1af1-70e0-addd-6299bf4830b4.md` | Deleted after extracting takeaways | Its framework direction is represented by current code and ADRs. Its claims that scopes and platform selection are unbuilt are stale. Preserve the Mail credential race, the unresolved “Zhongwen should be personal GitHub” correction, and hardware acceptance below. Its graceful-departure recommendation is superseded by process/document replacement. |
| `codex-session-01a0b345-8c37-7fe0-82d4-8fc0b9c77f07.md` | Deleted after extracting product direction | The [integration review](reports/20260918-integration-review.md) already records the merge work. The user selected local Gmail reading/search/triage and a broader Chinese study app with saved words and review. Preserve those outcomes below. Its startup blocker is now resolved; its PR counts, mergeability, and clean-checkout claims are historical, not current status. |
| `codex-session-01a0b531-b6c6-7e21-a89c-0db3c3d88683.md` | Retained: test/API work | Most final deletion candidates still exist. `StoreBacking` still allows replication without `discard`; signed-in opening still waits for Personal. Vocab still truncates candidate phrases. The duplicate Whispering owner lookup is already removed in the dirty checkout. Use the corrections below alongside the [dated test audit](reports/20260918-test-direction-audit.md). |
| `codex-session-01a0b74a-1b65-7023-a484-f68c0587d625.md` | Retained: Mail execution work | Bounded storage writes exist in the dirty checkout. Account-wide pacing, shared cooldown, page-sized reconciliation, and request cancellation do not. Preserve the user's refusal to remove pending changes or formatted mail. Its early description of runtime replacement as unbuilt is obsolete. |

### Current architecture, not another migration request

The [root declaration](../packages/app/src/index.ts) is inert. The separate
[opener](../packages/app/src/open.ts) captures an Account, acquires one
[App claim](../packages/device/src/app-claim.ts), and returns ready device and
optional Personal stores. [Platform selection](../packages/app/src/platform/default.ts)
already chooses browser or host resources. No separate data package or Shared
store remains. Separate signed-out and account-owned device storage remains;
the older “Local survives sign-in” wording must not imply automatic adoption
or a shared namespace across identities.

[AppBoot](../packages/app-shell/src/boot-screens/app-boot.svelte) opens the
working App. [Desktop auth](../apps/epicenter/src/desktop-auth-authority.ts)
writes next-boot credentials and relaunches. Browser departures replace the
document. Explicit resource closure still serves rollback, retirement, ordinary
unmount, and tests; it does not restore a navigation drain barrier.

Some decision headers lag implementation: ADRs 0409, 0415, and 0416 still say
Proposed. ADR-0407's amendment header still calls runtime injection unbuilt.
These labels are not evidence that current callers need another implementation.
This review does not change decision acceptance statuses.

### Mail: preserve the product, finish execution

The user explicitly retained local mail, a durable pending-change queue, and
formatted reading. Read-only Mail and plain-text-only rendering were explored
and rejected as the next simplification. Removing concurrency was also narrowed
to a measurement question; the final direction permits bounded concurrency
through one account pacing policy.

#### Extracted from `codex-session-01a0ba84`

The session's product review is complete. Keep offline reading, offline triage,
durable pending changes, formatted mail, and Undo. Undo belongs to the existing
per-message assertion model: it is a newer assertion, not cancellation or a
second history system.

One concrete UI edge case remains actionable. Moving a message that is already
in `TRASH` to Trash is a no-op, but the current generic Undo path inverts that
assertion and restores the message. Make the no-op action ineligible for Undo,
or capture the prior state before offering Undo, and add a regression test. This
is a focused action-planning fix, not a reason to remove Undo or redesign the
intent store.

- [The Gmail client](../apps/local-mail/src/gmail-client.ts) retries each
  request independently, has no shared rate gate, passes no cancellation signal
  to `fetch`, and uses a non-cancellable sleep.
- [Full pull](../apps/local-mail/src/sync.ts) loops through every page, fetching
  groups of eight messages. [Reconciliation](../apps/local-mail/src/reconcile.ts)
  drains pending changes once before that pull. A queued follow-up in
  `reconcileNow` does not give changes delivery opportunities between pages.
- [Message detail](../apps/local-mail/src/mailbox.ts) already reads stored
  SQLite content without requesting Gmail. Incremental sync already uses
  `history.list`. Neither needs a replacement read path.
- Dirty `writeChunks` code saves bounded transactions before advancing the
  checkpoint. It still rejects an individual serialized statement above
  4 MiB. Preserve shared SQLite batch atomicity; this is a remaining Mail/large
  value transport decision, not permission to split arbitrary transactions.
- [Reconnect](../apps/local-mail/src/accounts.ts) and
  [refresh rotation](../apps/local-mail/src/token-manager.ts) both write the
  credential. `withAccount` tracks admitted work for removal; it does not
  serialize reconnect with refresh. A synthetic probe paused a refresh,
  installed a reconnect credential, then released the old refresh response:
  the old rotated credential overwrote the reconnect. Existing pending-rotation
  tests do not cover that in-flight interleaving.

The transcript reports real Gmail login and 500 downloaded messages with a
reload at 400, later reaching 1,600 before throttling. Keep that as historical
partial acceptance. It does not prove full download, offline triage delivery,
or keychain reopening after a complete desktop restart. The maintained
[Mail evidence notes](../apps/local-mail/evidence/README.md) identify those
remaining journeys. This review touched no mailbox or live credential.

### Test/API audit: what remains actionable

The dated audit's old bootstrap failures and historical auth-restoration
recommendations are superseded. Its final narrower cleanup remains useful:

| Current finding | Action to carry forward |
| --- | --- |
| Static-token generator and exported resolver still exist; the resolver's executable consumer is a Worker test fixture | Remove the obsolete tooling and replace the fixture together. Preserve the production 409 refusal for historical data. Current self-host deployables use named sessions. |
| `createAppSqlite` returns `drain`; only its dedicated test calls it | Remove that returned method and the dedicated case; retain internal draining in `close` and real close-order tests. |
| Foundation evidence still contains five cases over an alternate initialization implementation | Remove that prototype with its cases. Keep the first two production-backed tests and the real Worker initialization tests. |
| Two App replacement cases manufacture a replacement without passing it to production | Remove/fold those cases while preserving actual identity-isolation tests. |
| Hosted-identity/source-spelling tests and rejected passkey-hook evidence remain | Prune only with the maintained build, callback-boundary, and production enrollment coverage retained. The shared authenticator fixture is still used. |
| Recording-close tests still observe obsolete `removeLocal` fakes; push-to-talk disposal coverage was weakened | Repair meaningful disposal/timer/session assertions. No blanket lifecycle-test deletion. |
| `StoreBacking.replication` and `discard` are independently optional | Require invalidation for replicated storage before removing the legacy-backing test and fallback. |
| Whispering used a supplied owner plus a global lookup | Already addressed by uncommitted explicit-owner changes in transcription and completion. Do not reimplement it from the transcript. |
| Fresh signed-in Local depends on uncached Personal opening | Reproduced with the production opener and memory runtime: Device acquired successfully, Personal returned `StorageFailed`, and the App rejected. Signed-out opening succeeded. Browser journey and readiness design remain follow-ups. Preserve the signed-in storage identity. |
| Vocab candidate parsing guesses that punctuation introduces glosses | Reproduced: `Yes: absolutely`, `你好：世界`, and `wait - what` become `Yes`, `你好`, and `wait`; `say:` disappears. Source validation and tests must change together. These are transient candidates, not proven corruption of saved entries. |

The working-copy engine still has only tests and benchmark callers. That is a
product-purpose question, not evidence that the whole engine should be deleted.
The `pg-protocol` alias also remains in Worker test configuration; the integration
report's concern about its removal condition survives. Neither warrants another
storage rewrite during transcript cleanup.

### Product choices and acceptance to preserve

The earlier synthesis preserves the user's “Zhongwen should be personal GitHub”
correction. The later conversation asks for a broader Chinese study app with
saved words and review; it does not explicitly settle repository placement.
Current Vocab has saved text, human notes, acquisition stages, and generated
practice conversations. It has no demonstrated retrieval/review history loop.
[The host's compiled-app list](../apps/epicenter/src/applications.ts) excludes
Vocab. Preserve the product goal without silently choosing in-repo ownership,
scheduled repetition, automatic glosses, or a desktop integration project.

The team-notes discussion in `01a0b74a` is also a future product direction.
Removing server-wide Shared is implemented. Restoring it would not provide
workspace membership, invitations, revocation, or separate team budgets.
Explicit shared collections were discussed, not implemented or adopted as a
new mandatory architecture.

Physical microphone interruption/reacquisition still has an unchecked gate in
the [runtime lifetime plan](../specs/20260919T090341-runtime-lifetime-collapse.md).
Its previous attempt failed before capture because macOS exposed no input
device. Do not infer that hardware acceptance passed from synthetic browser
recording or SQLite tests. Skills/chat product purpose remains open in root
guidance; transcript deletion does not authorize deleting those applications.

### Verification and disposition limits

Fresh isolated tests: **265 passed, zero failed, 1,051 assertions across 23
files**, covering all Mail source tests plus SQLite ownership, App ownership,
scopes, declaration/import boundaries, retirement, foundation evidence, and
Vocab boot/parser tests. A separate complete-runtime suite passed **10 tests,
45 assertions**. Total: **275 passed, zero failed**. Passing parser/prototype
tests can still preserve the wrong contract, as the probes above demonstrate.

Commands:

```sh
bun test --isolate apps/local-mail/src packages/device/src/owner.test.ts packages/app/src/app.test.ts packages/app/src/scopes.test.ts packages/app/src/index.test.ts packages/app/src/import-boundaries.test.ts packages/app/src/data/store/store-retirement.test.ts packages/server/evidence/scope-ownership/foundation.test.ts apps/vocab/src/lib/boot-node.test.ts apps/vocab/src/lib/entry-candidates.test.ts
bun test --isolate packages/app/src/runtime.test.ts
```

No browser/native acceptance, hosted CI, deployment, PR status, or full repository
gate was rerun. The six deleted exports were untracked; this entry preserves
their decisions and remaining work, not every tool log. The two retained exports
may be removed once their active work has an implementation/decision record;
retention is temporary, not a competing architecture reference.

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
