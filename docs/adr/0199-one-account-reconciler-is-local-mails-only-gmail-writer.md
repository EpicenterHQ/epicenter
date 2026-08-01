# 0199. One reconciler per account is Local Mail's only Gmail writer

- **Status:** Proposed
- **Date:** 2026-08-01
- **Amends:** [ADR-0082](0082-local-mail-syncs-by-push-free-history-list-polling.md) at its write-through clause and [ADR-0116](0116-local-mail-is-desktop-first-one-bun-engine-no-background-mail-service.md) at its "triage writes are Gmail-first" invariant. A triage write no longer travels from the request path to Gmail. Both records' other decisions, including push-free polling, the single sync owner, lock-free reads, and the no-background-service refusal, are untouched and this record depends on them.
- **Relates:** [ADR-0198](0198-a-durable-local-mail-write-is-a-per-message-label-assertion-in-a-sibling-intent-database.md) (the assertions this drains), [ADR-0098](0098-local-mail-state-round-trips-through-gmail.md) (Gmail holds every state a human acts on, which is what delivery is for), [ADR-0196](0196-local-mails-mirror-is-a-reader-and-one-full-message-fetch-is-its-entire-budget.md) (the per-message read budget the pull phase spends), [ADR-0188](0188-gmail-app-identity-belongs-to-the-distribution-and-no-epicenter-server-enters-the-gmail-path.md) (the Gmail identity whose per-user quota every call below is charged against)

## Context

ADR-0198 gives an undelivered write a durable home. It does not say who sends it,
and today the answer is "whoever handled the request": `modify.ts` is called
directly by the CLI verbs, the MCP tool, and the HTTP route, each on its own
process and its own schedule. Meanwhile the sync loop is separately serialized by
a per-account lock so that two bulk pulls cannot race one `historyId` cursor
(ADR-0116). So Gmail writes and Gmail reads for one account are governed by two
different disciplines, and a write can land between a pull's page 1 and page 2.

With durable intent that arrangement stops being merely untidy. If two surfaces
can each drain the same assertion, the same label change is sent twice and the
retirement of one can erase the other's newer opinion. If a pull runs before a
drain, the pull re-folds the pre-write labels and the user watches their archive
come back for one poll interval.

## Decision

**For each account there is exactly one reconciler, and it is the only thing in
Local Mail that writes to Gmail. It runs one pass at a time: drain the account's
assertions, retire each one that Gmail confirms, then pull Gmail's facts.**

Nothing else calls `messages.modify`, `messages.trash`, or `messages.untrash`.
The CLI verbs, the MCP tools, and the HTTP routes all assert and return.

### The pass, in order

1. **Drain.** Read every assertion for this account. Group by `message_id`, and
   deliver each message's opinions.
2. **Retire on confirmation.** A Gmail response that carries the message's
   current `labelIds` is the acceptance proof. Delete the exact rows it proves,
   identified by `(message_id, label_id, seq)`, and fold the returned labels into
   the mirror.
3. **Pull.** Run the existing sync pass (`history.list`, or a full pull when the
   cursor is stale) against the same mirror.

Drain before pull is load-bearing and not an optimization. It means the pull that
follows observes the mailbox the user just asked for, so a confirmed write is
never briefly un-done by a history record written before it.

A failed drain does not skip the pull. Reading stays available when writing is
not: a rejected token or an offline machine leaves assertions in place and the
pull fails on its own terms, which is the behaviour ADR-0116 already promises for
reads.

### How one message's opinions are delivered

Split the message's rows into wanted and unwanted label ids and send one
`users.messages.modify` with `addLabelIds` and `removeLabelIds`. Gmail returns
the modified `Message`, which is the per-id acceptance proof retirement needs
(verified against Google's `users.messages.modify` reference, 2026-08-01; the
same reference caps a single request at 100 label ids in each direction, which is
far above anything a triage act produces).

`TRASH` is delivered by `users.messages.trash` and `users.messages.untrash`,
which are Gmail's own verbs for it and which also return the modified `Message`.
This is the only place trash is special. It is stored as an ordinary label
assertion (ADR-0198), it is asserted through the same call as every other label,
and it is projected into read models as an ordinary label. A message carrying
both a trash assertion and label assertions gets the label modify first and the
trash call second, each retiring only its own rows, so an "archive and trash"
lands as both rather than as a race.

Per-message cost, from Google's published quota table (verified 2026-08-01):
`messages.modify` is 5 units, `messages.trash` is 20, `messages.untrash` is 5,
against a ceiling of 6,000 units per user per minute. Delivery is cheap next to
the pull it precedes, where `messages.get` alone is 20 units per message
(ADR-0196).

### What retirement may delete, and nothing more

Retirement deletes the row whose `(message_id, label_id, seq)` matches what the
delivery actually carried. If the user re-asserted that pair while the call was
in flight, `seq` has moved, the delete matches nothing, and the newer opinion
survives to be delivered on the next pass.

This is the whole of the newer-write protection, and it is why ADR-0198 allocates
a sequence on every assertion rather than only on the first. Retiring by key
alone would silently discard the user's most recent decision whenever it raced a
delivery, which is precisely the case a user creates by pressing undo quickly.

A pair re-asserted to the same value mid-flight is redelivered once. The extra
call is a no-op at Gmail and costs 5 units; comparing `want` as well as `seq`
would avoid it and is deliberately not done, because the simpler predicate is the
one a reviewer can confirm is correct.

### When an assertion cannot be achieved

**Refuse it before it exists, where that is possible.** An assertion is created
only against a message and a label the mirror already holds. A label name that
does not resolve, a label id that is not in `labels`, and a message id that is
not in `messages` are all refused at the moment the user acts, to the user's
face, and no row is written. That is where the great majority of impossible
assertions are caught, and it is the cheap place to catch them.

What survives that check is the race: a message deleted or purged in Gmail
between the act and the drain. Gmail answers with a per-id `400` or `404`, and
retrying cannot fix it. **The assertion is discarded and the discard is reported
in that pass's result**, then the drain continues to the next message. There is
no failure row, no unachievable state, and nothing to clean up later, because a
row that cannot ever be delivered has no reason to outlive the pass that learned
so.

Everything else, a rejected token, a throttle, a network error, is systemic. The
pass stops delivering, every affected row keeps its opinion **exactly as it was**,
and the next wake tries again. Nothing is written to the assertions: a systemic
failure is a fact about the pass, not about any row in it, and the reconciler
reports it as the pass's failure.

Retries are therefore unbounded and unpaced by anything stored. What bounds them
is a human: the count and age are visible, and discard is one action away. That
is the entire retry policy, and it is deliberately not a schedule.

### What wakes it

App start, the existing poll interval, a local write (coalesced, so a burst of
keyboard triage is one wake and not one per keystroke), and an explicit reconcile
the user or an agent asks for. Nothing else, and nothing after the app closes.

There is no background mail service and this record does not add one (ADR-0116).
An assertion made while nothing owns the reconciler simply waits, visibly, until
something does. The headless surfaces keep their promise: a one-shot `local-mail
reconcile` takes ownership for its single pass and drains, and a CLI triage verb
run while no app is open asserts and then drains in the same process. When the
open app already owns the account, a second process asserts and yields, and the
open app's next wake delivers it. That is a strictly better arrangement than
today, where the second process would have written to Gmail behind the first
one's back.

### Ownership

The per-account lock that ADR-0116 introduced for sync ownership becomes the
reconciler lock, covering drain and pull together. There is no second lock and no
second owner, so "who may write to Gmail for this account" and "who may advance
this account's cursor" are one question with one answer.

Accounts remain independent. Each has its own reconciler, its own lock, and its
own `intent.db`, and their passes overlap freely.

### The product surface

Local Mail's writes are a **visible, bounded retry ledger**, not a silent sync.
Bounded by the user, not by a counter.

Status reports exactly three things, and adding a fourth is a decision, not a
detail:

- **The undelivered count.** Zero is the normal reading and it is stated, not
  implied by an absent warning.
- **The age of the oldest undelivered assertion**, from `asserted_at`. This is
  what turns "some pending work" into "something is wrong".
- **The current or most recent reconcile failure**, as one message. It is the
  running reconciler's last pass outcome, held in memory like every other pass
  result, never a stored column and never per assertion.

Undelivered work can be discarded, per assertion or wholesale. Discarding is
complete: the row is removed, Gmail never sees it, and the read projection
returns to the mirror's own labels. Discarding is the only way an undelivered
assertion leaves without reaching Gmail.

Disconnecting an account reports its undelivered count first and discards it on
confirmation. A reauthorization is not a disconnect and retains everything.

### What this refuses

- **`messages.batchModify`.** Google documents its response body as empty
  (verified 2026-08-01), so it returns no per-message acceptance proof. Under it,
  retirement would have to be inferred from a later `history.list` pull, which
  reintroduces exactly the ambiguity this record removes: a pass that cannot say
  which assertions landed cannot safely retire any of them, and a crash between
  the call and the next pull leaves the ledger unable to distinguish delivered
  from lost. The quota argument for it is real and is not the deciding one: 50
  units for up to 1,000 ids against 5 units each is a large saving at bulk
  scale. **The reopen condition is specific**: a design that preserves the
  acceptance proof, for instance by proving delivery from the following
  `history.list` window rather than from the call, applied only to assertions
  whose retirement can be deferred that long. That takes a new ADR, because it
  changes what "confirmed" means.
- **A retry schedule, backoff state, or dead-letter tier.** Nothing about
  delivery is stored, so there is nothing to schedule from and nowhere for a
  permanently-failing row to be filed. A failure is either about the pass, in
  which case the next wake retries, or about one message, in which case the
  assertion is discarded immediately.
- **Automatic expiry of undelivered work.** No age threshold, no attempt ceiling,
  no quiet cleanup. Delivery and discard are the only exits.
- **Background delivery after the app closes.** No daemon, no wake-on-timer, no
  handoff to another process (ADR-0116).
- **A second Gmail writer of any kind.** Not a retry worker, not a fast path for
  a single click, not a direct call from an MCP tool for the case that "obviously
  cannot conflict".
- **Cross-account atomicity.** A pass is one account's. An act that spanned
  accounts succeeds or fails per account and reports per account.

## Consequences

- **The invariant is checkable.** After this lands, exactly one module names
  Gmail's write endpoints, and any new call site is visible in review and in a
  grep. Today the writer is wherever a handler happened to call.
- **A click stops being a network round trip.** Asserting is a local SQLite
  write, so the UI responds at disk speed and the read projection already shows
  the effect. This is what lets the browser-memory projection be deleted rather
  than replaced.
- **Delivery latency is now a poll interval in the worst case.** A write made
  just after a pass waits for the next wake. Coalesced write-wakes make the
  common case immediate; the guarantee is the interval.
- **Two failure surfaces collapse into one.** A failed write used to be a toast
  the user might miss. It is now a count, an age, and one current failure
  message, which is the same shape as a failed sync and is read the same way.
- **The app cannot say which pending assertion is the problem.** With no per-row
  error there is no "this one failed" answer, only "delivery is not succeeding,
  here is why". Accepted, because the failures that persist are systemic and
  belong to the pass; the per-message ones do not persist at all. If a real case
  ever needs per-row attribution, it takes a new record, because the column it
  would add is the first half of a dead-letter table.
- **The `MessageWriteOutcome` vocabulary goes away.** `folded`, `aborted`, and
  per-id error summaries described a request that talked to Gmail. An assert
  returns what it stored. Delivery outcomes are read from the ledger.
- **A quota argument is being declined at bulk scale.** Archiving a thousand
  messages costs 5,000 units instead of 50, so a very large bulk act can pace
  itself against the per-minute ceiling. That is a real cost, named here rather
  than discovered later, and it is the one thing the batchModify reopen condition
  exists to revisit.
- **Reads keep working when writes do not**, which is the property that makes an
  offline reader with a pending ledger honest instead of merely broken quietly.

## Considered alternatives

- **Keep writing to Gmail from the request path and add durability only as a
  retry-on-failure fallback.** Rejected. It keeps two writers (the request and
  the retry), so the interleaving that corrupts a newer opinion stays possible,
  and it means the success path and the failure path apply intent differently.
- **A dedicated delivery worker separate from the sync loop.** Rejected. Two
  owners per account is the thing this record exists to remove: they would need a
  shared lock to avoid a write landing mid-pull, and once they share a lock they
  are one owner with extra scheduling.
- **Pull first, then drain.** Rejected. The pull would fold Gmail's pre-write
  labels over the mirror while the user's assertion is still pending, so a
  correctly-projected list would flicker on every pass until delivery.
- **Retire by `(message_id, label_id)` alone.** Rejected. It discards an opinion
  asserted while a delivery was in flight, which is exactly the fast-undo case.
- **Keep an `attempts` counter and a `last_error` per assertion.** Rejected, and
  this was the shape an earlier draft of this record carried. Those two columns
  are what a dead-letter table is made of: once a row can hold a failure, it
  needs a threshold, the threshold needs a terminal state, the terminal state
  needs a place to sit and a policy to clear it, and the partial map has become
  the queue ADR-0198 refused. They also answer a question nobody can act on: a
  persistent failure is systemic and identical for every row, so N copies of one
  error string is noise, and a per-message failure is discarded rather than
  retried and so never accumulates a count. One pass-level failure message
  carries the same information.
- **Expire undelivered assertions after an age or an attempt ceiling.**
  Rejected. It silently drops a write the user made, which is the one thing a
  durable ledger exists to prevent, and it converts a visible problem into an
  invisible one at precisely the moment the problem has lasted long enough to
  matter.
- **Use `batchModify` and confirm from the next `history.list`.** Not rejected on
  merit, deferred with a named condition above. It is a different definition of
  confirmed and deserves its own record rather than a footnote in this one.
- **Deliver a whole thread in one call.** Rejected. Google documents
  `users.threads.modify` as "this applies to all messages in the thread"
  (verified 2026-08-01), meaning the thread as Gmail sees it at delivery time,
  including messages that arrived after the user acted. That is the
  standing-target semantics ADR-0198 refuses, bought back at the delivery layer.
