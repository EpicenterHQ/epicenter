# Local Mail: durable intent and one account reconciler

**Date**: 2026-08-01
**Status**: Draft
**Owner**: Braden
**Relates**: [ADR-0198](../docs/adr/0198-a-durable-local-mail-write-is-a-per-message-label-assertion-in-a-sibling-intent-database.md) (what a durable write is), [ADR-0199](../docs/adr/0199-one-account-reconciler-is-local-mails-only-gmail-writer.md) (who delivers it), [ADR-0196](../docs/adr/0196-local-mails-mirror-is-a-reader-and-one-full-message-fetch-is-its-entire-budget.md) and [ADR-0197](../docs/adr/0197-a-mirrors-corpus-version-names-its-artifact-and-only-the-app-knows-when-one-is-ready.md) (the mirror stays a versioned disposable artifact), [ADR-0116](../docs/adr/0116-local-mail-is-desktop-first-one-bun-engine-no-background-mail-service.md) (one Bun engine, no background service), [ADR-0098](../docs/adr/0098-local-mail-state-round-trips-through-gmail.md) (Gmail holds every state a human acts on), [ADR-0188](../docs/adr/0188-gmail-app-identity-belongs-to-the-distribution-and-no-epicenter-server-enters-the-gmail-path.md) (the shipped distribution's Gmail identity, whose per-user quota every delivery call below is charged against)

## One sentence

Local Mail stops writing to Gmail from the request path: a triage act becomes a
durable per-message label assertion in a sibling `intent.db`, one reconciler per
account drains those assertions and then pulls Gmail's facts, and the
browser-memory optimism that stood in for durability is deleted.

## Read this first

The two ADRs above are the decisions. This spec is the execution: what is true
today, what has to change, in what order, and what proves each step. If this file
disagrees with an ADR, the ADR wins. When the work lands, delete this file and
flip both ADRs to Accepted.

## What is true today

- `apps/local-mail/src/modify.ts` is the writer. `foldMessageMutations` loops
  over ids, calls `messages.modify` or `messages.trash`/`untrash`, and folds each
  response into the mirror. It is called directly by the CLI verbs
  (`apps/local-mail/src/cli.ts`), the MCP tool (`apps/local-mail/src/mcp.ts`),
  and the HTTP routes (`apps/local-mail/src/http/api.ts`). Three surfaces, three
  independent writers, no shared discipline.
- The per-account lock (`apps/local-mail/src/lock.ts`) covers only sync. A write
  can and does land between two pages of a pull.
- Nothing durable records an undelivered write. Offline, the call fails and the
  intent is gone.
- `apps/local-mail/ui/src/lib/optimistic.ts` fills the gap in browser memory by
  projecting TanStack's pending mutation variables over cached rows. It dies on
  reload, is invisible to the CLI and MCP, and can only hide rows the browser
  already holds, so a filtered list's paging and counts are wrong mid-flight.
- The mirror (`apps/local-mail/src/db.ts`) is `mail.v5.db`, versioned and
  disposable under ADR-0197, and correctly holds nothing irreplaceable.

## The destination, stated once

Per account, in `<dataDir>/<accountEmail>/`:

```
mail.v5.db     versioned, disposable, Gmail facts only        (ADR-0196, ADR-0197)
intent.db      durable, the only irreplaceable local state    (ADR-0198)
```

`intent.db` holds one table:

```sql
CREATE TABLE IF NOT EXISTS label_intents (
  message_id  TEXT    NOT NULL,
  label_id    TEXT    NOT NULL,
  want        INTEGER NOT NULL,          -- 1 wanted, 0 not wanted
  seq         INTEGER NOT NULL,          -- per-account monotonic, new on every assert
  asserted_at TEXT    NOT NULL,
  PRIMARY KEY (message_id, label_id)
);
```

Five columns, and that is the whole schema. The primary key is the design:
re-asserting a pair overwrites `want` and allocates a new `seq`, so archive then
unarchive then archive is one row. There is no queue, no event log, and no
payload column.

There is also **no `attempts` and no `last_error`**. A row says what the user
wants, never what happened when we tried. Those two columns are the first half of
a dead-letter table, and adding either one reopens ADR-0198. A failure is
systemic and belongs to the pass, or it is about one message and the assertion is
discarded on the spot.

One reconciler per account, holding the account lock, runs:

```
drain  ->  retire what Gmail confirmed  ->  pull Gmail facts
```

Woken by app start, the poll interval, a coalesced local write, and an explicit
reconcile. Never after the app closes.

Every read surface projects **effective labels** = mirror labels, minus `want=0`
assertions, plus `want=1` assertions, computed in SQL so filter, sort, paging,
and counts all agree.

## Working backward from the destination

| The destination requires                       | Which forces                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| Only the reconciler calls a Gmail write method  | `modify.ts` collapses to an assert; the three surfaces stop calling Gmail            |
| A click is felt immediately without a network   | The read projection must overlay intent, so the overlay ships with the cut           |
| One pending answer                              | `optimistic.ts` and its test are deleted in the same wave, not deprecated            |
| Drain before pull                               | `syncMailbox` becomes the pull phase of `reconcile`, not a peer verb                 |
| Writing and pulling cannot interleave           | The sync lock becomes the reconciler lock                                            |
| Undelivered work is visible and discardable     | A ledger surface: aggregate count, oldest age, one pass-level failure, discard       |
| Bulk and thread acts touch only current members | Enumeration happens at act time from the mirror, never at drain time                 |

Read top to bottom, the first four rows are one indivisible cut. Splitting them
leaves a state where either two writers exist or a click appears to do nothing
for a poll interval. The last three are genuinely separable and come after.

## Ownership map

| Concern                                       | Owner after this work                          |
| --------------------------------------------- | ---------------------------------------------- |
| What a durable write is                       | `src/intent.ts` (schema, assert, retire, discard) |
| Sequence allocation and retirement predicate  | `src/intent.ts`                                |
| Calling any Gmail write method                | `src/reconcile.ts`, and nothing else           |
| Drain ordering, per-id vs systemic failure    | `src/reconcile.ts`                             |
| Trash routing to `trash`/`untrash`            | `src/reconcile.ts`, at delivery only           |
| Pulling Gmail facts, cursor, FULL vs INCREMENTAL | `src/sync.ts` (unchanged, now called by reconcile) |
| Mirror shape, corpus version, DDL             | `src/db.ts` (unchanged)                        |
| Effective-label projection                    | `src/db.ts` read models, over the attached intent db |
| Who may write for an account                  | `src/lock.ts`, widened from sync to reconcile  |
| Label name to id resolution                   | The act path, against the mirror, before asserting |
| Desugaring archive/read/star/label into assertions | `ui/src/lib/actions.ts` and the CLI verbs  |
| Showing pending work                          | The SPA status bar and pending panel           |

Two rules fall out. `intent.ts` never calls Gmail. `reconcile.ts` never decides
what the user meant.

## Waves

Each wave is a reviewable, revertible unit that leaves the app working.

### W0. The intent store, unused

`src/intent.ts`: open `<accountDir>/intent.db` at `0600` inside the existing
`0700` account directory, create `label_intents`, and expose exactly four
operations: `assert`, `pending`, `retire`, and `discard`. Nothing calls it yet.

Four is the whole surface. There is no `recordAttempt`, no `markFailed`, and no
way to write anything to a row except the user's opinion, so the shape ADR-0198
refuses is not reachable from this module's API.

The opener is deliberately its own thing, not `mirrorAt`. `intent.db` is durable
and unversioned; naming it through the mirror grammar would put it inside
`reclaimPredecessors()`'s reach, and the whole point is that it is not
reclaimable.

**Gate**
- Unit tests for the map semantics: re-assert overwrites and bumps `seq`; A then
  B then A is one row; retire by `(message_id, label_id, seq)` deletes only the
  matching row; retire with a stale `seq` deletes nothing.
- A test asserting `mailMirror(...).reclaimPredecessors()` leaves `intent.db`
  present. This is a claim ADR-0198 makes about mechanical safety, so it gets a
  test rather than a comment.
- The `label_intents` DDL has five columns. If a sixth appears, it is a decision
  against ADR-0198 and needs a record, not a review comment.
- `bun run --filter local-mail test` green. No behaviour change anywhere.

### W1. The one-writer cut (clean break)

The indivisible middle. In one wave:

1. `src/reconcile.ts` appears and owns every Gmail write. One
   `messages.modify` per message from its grouped assertions; `TRASH` routed to
   `messages.trash`/`untrash`; labels delivered before trash for a message that
   has both; retire on the returned `Message`; a per-id 400/404 discards that
   assertion and names it in the pass result; anything else stops delivery,
   leaves every row untouched, and becomes the pass's failure. Then it calls
   `syncMailbox` for the pull.
2. `src/modify.ts` is **deleted**. Label-name resolution moves to the act path
   (it needs the mirror's `labels` table, not Gmail), which is also where an
   assertion against an unknown message id or label id is refused before a row
   exists. `setMessagesTrashed` becomes an assertion of `TRASH`.
3. `src/db.ts` read models attach `intent.db` and project effective labels, so
   `listMessages` filtering, ordering, `LIMIT`/`OFFSET`, and counts are all
   computed post-overlay.
4. Surfaces route to assert: `POST /messages/modify` and `POST /messages/trash`
   become `POST /messages/assert`; `POST /sync` becomes `POST /reconcile`; CLI
   triage verbs assert, then run a reconcile pass if this process can take the
   lock; MCP `modify_labels` becomes `assert` and `sync` becomes `reconcile`.
5. `app.ts`'s loop calls `reconcileAccount` instead of `syncMailbox`, and the
   lock it already holds is now the reconciler lock.
6. `ui/src/lib/optimistic.ts` and `optimistic.test.ts` are **deleted**. The SPA
   invalidates and re-reads; the server projection is the pending state.

W1 deliberately ships **without** the ledger UI, discard, thread and bulk
enumeration, and read-on-open. Those are product surface. W1 is about the
invariant. It ships without retry pacing permanently, not temporarily: there is
no schedule to build (ADR-0199).

**Gate**
- `rg -l 'modifyMessage|trashMessage|untrashMessage' apps/local-mail/src` returns
  exactly `gmail-client.ts` and `reconcile.ts`. This grep is the invariant, and
  it belongs in review notes and ideally in `scripts/`.
- Unit: drain groups a message's opinions into one modify; a `TRASH` assertion
  produces a trash call and no `TRASH` in `addLabelIds`; a mid-flight re-assert
  survives retirement; a per-id 404 discards that assertion, names it in the pass
  result, and the loop continues; a token failure leaves **every row byte-for-byte
  unchanged** and still runs the pull.
- Unit: a label name that does not resolve to an id in the mirror's `labels`
  table writes no row and returns the refusal to the caller. This is the only
  pre-creation refusal; nothing tests "the mirror already agrees", because no
  such rule exists (ADR-0198, ADR-0199).
- Unit: an assertion whose effect the mirror already appears to satisfy is still
  written and still delivered. A stale mirror must never suppress a real write.
- Unit: `listMessages` with a pending `want=0` on `INBOX` omits the row from the
  inbox view **and** returns a full page, proving the overlay is pushed down.
- Live smoke against a real account: archive with the network off, quit the
  process, reopen, observe delivery and the row disappearing from `intent.db`.
- Live smoke: assert, then discard before the next wake, and confirm with
  `history.list` that Gmail never saw it. This is the discard window, not a
  general cancel guarantee.
- Full `bun run check`.

### W2. The ledger surface

Status gains three readings and no more: the undelivered count, the age of the
oldest from `asserted_at`, and the current or most recent reconcile failure as
one message taken from the running reconciler's last pass outcome. Zero
undelivered is stated, not implied by an absent warning.

`GET /pending` returns the account's assertions as they are stored: message id,
label id, want, and `asserted_at`. There is nothing else to return.
`POST /pending/discard` takes ids or clears all, and discard is the only exit
that is not delivery. A pending list shows the assertions with per-row discard;
it does not show a per-row status, because there is not one.

Discard is abandonment, not recall. It removes an undelivered row so it is never
sent; it cannot un-send one the reconciler already delivered. The UI says that
rather than implying an atomic cancel, and getting back from a delivered change
is a new assertion like any other.

Disconnect reports the undelivered count and discards on confirmation;
reauthorization retains. CLI gains `pending` and `discard`; MCP gains a
`pending` tool so an agent can see undelivered work rather than assuming its
write landed.

**Gate**
- Live smoke: offline, archive three messages, watch the counter reach 3 and the
  age climb, reconnect, watch it fall to 0.
- Live smoke: disconnect with pending work and confirm the count is reported
  before anything is discarded.
- Live smoke: revoke the token, run a pass, and confirm the failure appears once
  as the pass's failure and not once per pending assertion.
- Unit: discard removes the row and the read projection reverts to mirror labels.
- Unit: the pending payload carries no status, attempt, or error field.

### W3. Enumeration surfaces

Thread and bulk acts enumerate concrete ids from the mirror at act time and
assert one row per id. The per-act cap defaults to 500 ids, refused with a count
rather than silently truncated.

Read-on-open asserts `(id, UNREAD, want=0)` when the user opens a message the UI
is showing as unread. The trigger is the affordance the user saw, not a
correctness test against mirrored facts: if the mirror is stale and Gmail already
has the message read, the assertion is written anyway and Gmail no-ops it. An
earlier draft made this conditional on the effective label set, which is the
fact-comparison ADR-0198 refuses. Repeat opens are free regardless, because the
primary key collapses them into one row.

**Gate**
- Unit: a thread act over a 3-message thread creates exactly 3 assertions.
- Live smoke: act on a thread, receive a new message into it before the next
  wake, and confirm the new message is untouched.
- Unit: opening the same message twice leaves exactly one assertion.
- Unit: reversing an act (archive then un-archive) overwrites the row and bumps
  `seq`; it never deletes the row and never consults the mirror.

### W4. Collapse and straggler sweep

Delete the vocabulary the old shape needed: `MessageWriteOutcome`, `folded`,
`aborted`, per-id error summaries, and the CLI's per-id exit-code reporting
built on them. Rewrite `apps/local-mail/README.md`'s triage and app sections.
Flip ADR-0198 and ADR-0199 to Accepted and delete this spec.

**Gate**
- `bun run check` and `bun run check:doc-hygiene` clean.
- No remaining reference to write-through in `apps/local-mail`.

## The smallest first vertical slice

**W0 plus W1, as two commits in one wave.** That is the smallest thing that makes
"one reconciler per account is the only Gmail writer" a true statement rather
than a plan.

It cannot be smaller, because the invariant is global. Leaving any one of the
CLI, MCP, or HTTP surfaces on the old path leaves a second writer, and the
statement is false. It should not be larger, because the ledger UI, discard,
enumeration, and read-on-open are all product surface that a true invariant does
not depend on.

The one thing inside the slice that looks droppable and is not is the read
overlay (W1 step 3). Without it, a click writes a row and the list does not
change for up to a poll interval, which reads as a broken app and would create
pressure to keep `optimistic.ts` alive beside the durable ledger, the exact
parallel-optimism state ADR-0198 refuses.

## Deletions

| Deleted                                            | Because                                            |
| -------------------------------------------------- | -------------------------------------------------- |
| `src/modify.ts` and `src/modify.test.ts`           | The request path no longer writes to Gmail          |
| `ui/src/lib/optimistic.ts` and its test            | One pending state, and it is on disk                |
| `POST /messages/modify`, `POST /messages/trash`    | Collapse into `POST /messages/assert`               |
| `POST /sync`                                       | A pass is drain-then-pull; the verb is `reconcile`  |
| `MessageWriteOutcome`, `folded`, `aborted`         | They described a request that talked to Gmail       |
| The four spent Local Mail specs                    | Their designs landed or are contradicted by ADR-0198/0199 |

## Provider grounding

Verified against Google's published Gmail API reference on 2026-08-01. These are
the facts the design leans on; re-verify before changing any of them.

| Fact                                                            | Consequence here                                     |
| --------------------------------------------------------------- | ---------------------------------------------------- |
| `messages.modify` returns the modified `Message`                | The per-id acceptance proof retirement needs          |
| `messages.modify` caps at 100 label ids per direction           | Far above a triage act; not a constraint in practice  |
| `messages.batchModify` response body is empty, up to 1000 ids   | No acceptance proof, so it is refused (ADR-0199)      |
| `messages.trash` and `untrash` are separate and return `Message`| Trash routes specially at delivery only               |
| `threads.modify` "applies to all messages in the thread"        | Thread delivery would be a standing target; refused   |
| Label `id` is immutable, `name` is an editable display string   | Intent is keyed by id, never by name                  |
| A `historyId` is "typically valid for at least a week"          | Unchanged; the pull phase keeps its 404 full-resync   |
| Quota: `modify` 5, `trash` 20, `untrash` 5, `batchModify` 50, `get` 20, `history.list` 2, ceiling 6,000/user/minute | Delivery is cheap next to the pull; bulk archive at 5 units per message is the accepted cost |

## The remaining decision surface

Nothing below is an open architectural question. The model is settled by ADR-0198
and ADR-0199. What is left sorts into three kinds, and confusing them is how a
tuning knob turns into a redesign discussion.

### Evidence gates: prove it in the wave, do not debate it

**The overlay join.** `ATTACH` `intent.db` onto the mirror connection and compute
effective labels in SQL. This is not a taste fork; it follows from the
requirement that filtering, ordering, paging, and counts be post-overlay, which
in-memory projection cannot deliver. What is unproven is mechanical:
`openMailDbReadonly` must attach read-only, and `busy_timeout` behaviour across
two attached files is untested here. **W1 prototypes it first.** If SQLite will
not do it, the fallback is loading the (small, bounded) pending set into a temp
table in the same connection, which preserves push-down. Reverting to a
post-query overlay in TypeScript is not a fallback; it is the defect.

### Product parameters: ship the default, tune from use

Each has a default. None blocks any wave, and changing one later is a one-line
edit, not a decision record.

| Parameter                 | Default   | Why this number                                                                     |
| ------------------------- | --------- | ------------------------------------------------------------------------------------ |
| Per-act enumeration cap   | 500 ids   | Replaces `modify.ts`'s 100-id guard, which existed because Gmail ran each id as a request. The new cap exists so a user cannot silently queue an unbounded drain. Refuse above it with the count. |
| Write-wake debounce       | 750 ms trailing | A burst of keyboard triage should be one wake. Pure tuning; the correctness path does not depend on it, because the poll interval catches anything the debounce misses. |
| Status age display        | Oldest `asserted_at` | One number is what makes "some pending work" read as "something is wrong". |

### Standing constraints: already decided, listed so they are not re-litigated

- **Retirement is `seq` equality.** ADR-0199 chose it for reviewability. It
  redelivers a pair re-asserted to the same value mid-flight, at 5 quota units
  and no user-visible effect. Comparing `want` as well is a bounded optimization
  if that ever proves common, not a fork.
- **`intent.db` corruption is reported, never auto-deleted.** The mirror's answer
  is "re-pull"; this file has no such answer, so the only safe move is to say so
  and require an explicit discard. Automatic deletion here would destroy the one
  thing in the app Gmail cannot give back.
- **Nothing expires.** No age threshold, no attempt ceiling, no quiet cleanup.
  Delivery and explicit discard are the only exits (ADR-0198, ADR-0199).
- **No per-row failure state, ever.** If `attempts`, `last_error`, a status
  column, or a dead-letter table is proposed, that is a change to ADR-0198 and
  needs a record, not a pull request.
- **Local facts never retire intent.** No rule may drop, skip, or suppress an
  assertion because the mirror appears to already satisfy it; the mirror lags and
  can be incomplete. Reversal is a new assertion, retirement is the reconciler's
  after provider confirmation, and discard is an explicit human act.

### One thing genuinely worth deciding

**Where the invariant grep lives.** The one-writer rule is currently enforced by
review. `scripts/` already hosts structural checks that `check:structure` runs; a
Local Mail writer check would fit there, and the cost is one entry. A check that
runs is worth more than a gate that a reviewer has to remember.
