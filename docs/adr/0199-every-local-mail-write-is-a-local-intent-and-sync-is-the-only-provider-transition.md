# 0199. Every Local Mail write is a local intent, and sync is the only provider transition

- **Status:** Accepted
- **Date:** 2026-08-01
- **Amends:** [ADR-0082](0082-local-mail-syncs-by-push-free-history-list-polling.md) at its write-through clause only: writes no longer hit Gmail first and fold the response in after, they record a local intent that sync replays. The polling decision, the cursor discipline, and the refusal of push are untouched; [ADR-0116](0116-local-mail-is-desktop-first-one-bun-engine-no-background-mail-service.md) at its "triage writes are Gmail-first, no shared writer required" runtime invariant, which is replaced by a single-writer rule. Desktop-first, one engine, no background service, and lock-free reads are untouched
- **Relates:** [ADR-0198](0198-local-mail-stores-gmail-facts-and-durable-local-overlays-in-one-stable-file-per-account.md) (the file this owns), [ADR-0200](0200-an-offline-draft-edit-replaces-a-known-gmail-drafts-whole-mime-content.md) (the draft overlay this replays), [ADR-0098](0098-local-mail-state-round-trips-through-gmail.md) (the round-trip rule an intent satisfies on replay), [ADR-0061](0061-local-books-reads-facts-from-the-mirror-reports-live-and-writes-through-one-approved-verb.md) (the write-through pattern Local Mail borrowed and now leaves; Local Books keeps it)

## Context

ADR-0082 decided write-through for Local Mail: send to Gmail first, fold the
response into the mirror after. ADR-0116 then made "no shared writer required" a
runtime invariant on that basis.

Read against the code, that arrangement has two writers to the same fact tables.
`sync.ts` writes under the per-account gate and the `lock.ts` sync-owner lock.
`modify.ts`'s `patchMessageLabels` writes the same `messages` table from the
HTTP route, the CLI, and MCP, under neither. Three costs are live today:

- `MirrorWriteError.MirrorBusy` was written for the genuine two-process case
  (a watch loop and an MCP host syncing one account). The fold quietly widened
  it: a sync pass can now lose the file to a triage click in the same process,
  through a path no lock covers.
- The fold stamps `synced_at` on a fact row without moving the cursor, and
  `finishFullPull` sweeps `WHERE synced_at < ?`. A fold therefore shields a row
  from a sweep, which is a fact-tier effect authored outside sync.
- The fold is best-effort and swallows every failure silently
  (`tryFoldMessageLabels` catches and returns `false`). The UI compensates with
  ephemeral optimism read out of TanStack's mutation cache, which is per-tab and
  dies on reload.

And because the durable effect is the Gmail call, offline triage does not work
at all: the action fails, and the optimism that briefly covered it evaporates.

## Decision

**A Local Mail write records a local intent in the mailbox database and returns.
`sync()` is the only function that talks to Gmail on the mailbox's behalf, and
the only writer of the mailbox database. One pass replays pending overlays to
Gmail, then refreshes Gmail facts.**

### What one pass does, in this order

1. **Replay pending overlays** to Gmail: label, archive, and trash overrides,
   then draft body replacements.
2. **Refresh provider facts**: `history.list`, or a full pull when
   `decideMode` says so.
3. **Retire the overlays Gmail confirmed** in the refreshed facts.

Replay comes first so that step 2 confirms the user's own writes in the same
pass. Refreshing first would leave a just-made triage action reading as pending
for a whole extra interval, for no gain.

### The handle

One `openMailbox({ dataDir, accountEmail })` per account, exposing a read
surface, an intent surface, and `sync()`. Nothing else.

There is **no public database handle, no writer object, no `create` flag, and no
post-write callback.** `openMailDb` stops being exported, `MailDb` stops
crossing a module boundary, and `syncDeps.db` stops being reachable from the
HTTP layer.

Reads stay direct and lock-free, which is ADR-0116's invariant and is untouched:
a read-only open of the same file, selecting from the composed views. The ad-hoc
SQL `query` verb keeps its read-only handle and now reads those views, so it
agrees with the UI by construction rather than by discipline.

### The replay failure contract

- **Per-id rejection** (Gmail 400 or 404): the intent is impossible, not
  delayed. Mark the overlay failed, stop replaying it, and surface it with a
  discard action. `modify.ts` already draws exactly this line (`isPerIdError`);
  this record promotes it from a loop-continuation rule to the overlay's
  lifecycle.
- **Systemic failure** (network, auth, throttle, `MirrorBusy`): leave the
  overlay pending, advance nothing, retry on the next pass. This is how a failed
  sync pass already behaves.
- **Retry is the next sync pass.** Not a timer, not a backoff schedule, not a
  counter on the row. There is one loop and it already runs on an interval.

### The refusals

- **No background or closed-app delivery promise.** ADR-0116 refuses an
  always-on mail service and this record does not smuggle one back in. An
  overlay written with the app closed sits there until something runs a pass.
  The UI must never imply otherwise.
- **No queued send, and no automatic retry of an ambiguous send.** Send is not
  an overlay. It is an online-only action that succeeds or fails in front of the
  user, which is what keeps ADR-0098's send-later refusal true: a queued send
  *is* send-later wearing an offline-support costume.
- **No second writer, ever, including a fast path for one verb.** The moment a
  second writer exists, the lock, the ordering, and the `synced_at` sweep all
  become conditional again, and every bug in that family comes back.

## Consequences

- **One writer, so the sync-owner lock finally covers every write.**
  `MirrorBusy` originating from a triage action becomes structurally impossible,
  and the error narrows back to the second-process case it was written for.
- **Offline triage works and survives quitting the app.** This is new
  capability, not a tidier version of what exists.
- **The UI's ephemeral optimism deletes.** `readPendingWrites`,
  `projectMessageList`, `rowMatchesLabelFilter`, and the pending-masking dance
  inside `reconcileAfterWrite` all exist to reproduce, per tab and in memory, a
  composition that now happens once in SQL. `applyLabelDelta`'s rule survives as
  the server-side composition; the TanStack mutation-cache seam does not.
- **`POST /messages/modify` and `POST /messages/trash` stop being Gmail calls.**
  They become local writes that return immediately, so they no longer need to be
  awaited for correctness and no longer fail on a plane.
- **Latency to Gmail is now bounded by the sync interval, not by the click.** A
  user who wants it sooner presses refresh, which is the affordance that already
  exists. This is the honest cost of the trade and it should be stated in the
  UI, not hidden.
- **ADR-0116's "Gmail-first triage writes work app-open or app-closed" clause is
  withdrawn.** With the app closed the durable effect now lands locally and
  reaches Gmail on the next pass. What works app-closed for *reads* is
  unchanged.
- **Deferred, named, not built:** running a pass immediately when an intent is
  written and the app is open and online. It is purely additive, changes no
  contract here, and is the obvious follow-up once the interval feels slow.

## Considered alternatives

- **Keep Gmail-first and add durable overlays only for the offline case.**
  Rejected: it is two write paths for one verb, selected by a network check, and
  the two paths write different tables. Every bug in that family lives in the
  disagreement between them, and the disagreement is only reachable in exactly
  the conditions that are hardest to test.
- **Write to Gmail first and record the overlay as a journal.** Rejected: that
  is an operation log, and an operation log needs compaction, ordering, and
  idempotency keys that a desired-state overlay simply does not have. Archive
  then undo would become two rows and two network calls instead of zero.
- **Expose a writer object beside `sync()`.** Rejected: it is the current shape
  with better naming. The property being bought here is that exactly one
  function can move the file, and exporting a second writer is that property
  being sold.
- **A retry counter and backoff schedule on the overlay row.** Rejected for v1:
  there is one loop at a fixed interval, so a counter could only decide when to
  give up, and the per-id versus systemic split already answers that without
  persisting a number.
- **Let the intent surface return a promise that resolves when Gmail confirms.**
  Rejected: it recreates the Gmail-first latency and failure mode at the call
  site while keeping the overlay machinery, so it pays for both models and gets
  the guarantees of neither.
