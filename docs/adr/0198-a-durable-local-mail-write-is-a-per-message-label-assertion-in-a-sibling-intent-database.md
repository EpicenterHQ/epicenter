# 0198. A durable Local Mail write is a per-message label assertion in a sibling intent database

- **Status:** Proposed
- **Date:** 2026-08-01
- **Amends:** [ADR-0098](0098-local-mail-state-round-trips-through-gmail.md) at its refusal of local-only mail state only: durable local *intent* is admitted, bounded, and defined here. The round-trip rule itself is untouched and this record depends on it.
- **Relates:** [ADR-0082](0082-local-mail-syncs-by-push-free-history-list-polling.md) (the change feed that confirms an assertion landed; its write-through clause is amended by [ADR-0199](0199-one-account-reconciler-is-local-mails-only-gmail-writer.md)), [ADR-0116](0116-local-mail-is-desktop-first-one-bun-engine-no-background-mail-service.md) (one Bun engine, no background mail service, which is why undelivered intent must survive a closed app), [ADR-0196](0196-local-mails-mirror-is-a-reader-and-one-full-message-fetch-is-its-entire-budget.md) (the mirror is a disposable reader, so nothing durable may live in it), [ADR-0197](0197-a-mirrors-corpus-version-names-its-artifact-and-only-the-app-knows-when-one-is-ready.md) (the mirror artifact is versioned and reclaimable; its filename grammar is what keeps this file out of reclamation's reach), [ADR-0199](0199-one-account-reconciler-is-local-mails-only-gmail-writer.md) (who delivers these assertions to Gmail)

## Context

A Local Mail triage write is currently a synchronous Gmail call made from the
request path: `apps/local-mail/src/modify.ts` sends `messages.modify` per id and
folds Gmail's response into the mirror. There is no durable record of a write
that has not landed. Offline, the click fails and nothing remembers it. With a
flaky connection the user cannot tell what reached Gmail and what did not.

The SPA compensates in browser memory. `apps/local-mail/ui/src/lib/optimistic.ts`
reads TanStack's mutation cache and projects pending label deltas over cached
rows at render time. That projection dies on reload, is invisible to the CLI and
the MCP surface, and can only hide rows the browser already fetched, so a
filtered list's paging and counts are wrong the moment a write is in flight.

ADR-0098 refused local-only mail state, and that refusal is correct: a tag or a
read flag that never reaches Gmail leaves the phone showing something false. But
it left no home for a different thing, an undelivered *request*, which is not a
second source of mail truth but a record that the user asked for one. ADR-0196
and ADR-0197 close the obvious hiding place: the mirror is a disposable,
version-named artifact that any corpus bump replaces with a full re-pull, so
anything irreplaceable stored there would be destroyed by routine maintenance.

So the question is not whether Local Mail may keep local state. It is what the
single durable local write is, precisely enough that no second one gets invented.

## Decision

**A durable Local Mail write is one entry in a per-account partial map from
(Gmail message id, Gmail label id) to want or do-not-want. That map lives in a
durable `intent.db`, a sibling of the versioned mirror, and it is the only
durable local record of an act the user has taken.**

### Partial, and only about what was touched

The map holds an opinion only about label ids the user actually acted on. It
never stores a desired label set. An assertion that `STARRED` is wanted says
nothing about `INBOX`, so a Gmail-side change to an untouched label is folded
normally and never fought. This is what keeps a local opinion from silently
becoming a standing claim over a message's whole labelling.

### Keyed by ids, never names

Both halves of the key are Gmail ids. A Gmail label's `id` is documented as
immutable while `name` is a display string the user can rename at will (verified
against Google's `users.labels` reference, 2026-08-01). An intent keyed by name
would silently retarget when a label is renamed and would be unresolvable when it
is deleted. Name resolution stays where it already is: at the moment of acting,
against the mirror's `labels` table, so an unknown name is refused to the user's
face instead of being stored and failing later.

### Concrete message ids, captured when the user acts

A thread, a search query, a filtered list, a page, and the cross-account view are
reading and selection surfaces. None of them is ever a durable target.

An act over any of them enumerates concrete message ids from the mirror at act
time and stores one assertion per id. Archiving a thread archives the messages
that thread contained when the button was pressed. A message that arrives in that
thread afterward is untouched, and no record exists that would touch it. That is
the whole of the semantics, and it is the reason no standing policy, saved rule,
or query-shaped intent is needed to express bulk triage.

### The stored shape

One table, one row per opinion:

| column        | meaning                                                     |
| ------------- | ----------------------------------------------------------- |
| `message_id`  | Gmail message id, part of the primary key                    |
| `label_id`    | Gmail label id, part of the primary key                      |
| `want`        | `1` the label is wanted, `0` it is not                       |
| `seq`         | per-account monotonic integer, allocated on every assertion  |
| `asserted_at` | when the user acted                                          |
| `attempts`    | delivery attempts so far                                     |
| `last_error`  | the last delivery failure, or null                           |

`PRIMARY KEY (message_id, label_id)` is what makes this a map rather than a
queue. Asserting the same pair again overwrites `want` and allocates a new `seq`,
so archive then unarchive then archive collapses to one row saying archive. There
is no history of how the user got here, because nothing needs one.

`seq` exists for exactly one job: it lets a delivery retire the opinion it
actually carried and no other. ADR-0199 owns that rule.

### Where it lives, and why not the two obvious alternatives

`<dataDir>/<accountEmail>/intent.db`, beside `mail.v<version>.db`.

- **Not inside the mirror.** The mirror is a disposable copy of data Gmail owns,
  named by a corpus version, replaced by a full re-pull on any bump, with the
  predecessor reclaimable (ADR-0196, ADR-0197). Undelivered intent is the one
  thing in this app that Gmail cannot give back. Storing it there would make
  `reclaimPredecessors()` a data-loss operation and a corpus bump a silent
  discard of the user's pending work.
- **Not the Epicenter database.** Local Mail is a standalone Bun engine that owns
  its own storage (ADR-0116) and no Epicenter server is in the Gmail path
  (ADR-0188). Routing mail intent through Epicenter's replica would add a
  synchronization plane, an identity, and a failure mode to a write whose entire
  lifetime is measured in seconds on one device.

The separation is also mechanically safe rather than merely intended. ADR-0197
scopes `reclaimPredecessors()` to paths its own filename grammar produces, which
is why a sibling `credentials.json` is already unreachable. `intent.db` does not
match `<name>.v<version>.db`, so reclamation cannot name it, and neither opening
mode ever creates or touches it. The file carries the same sensitivity handling
as the mirror: `0600`, inside the `0700` account directory.

### What an assertion is worth before it is delivered

Nothing has happened to the mailbox. An assertion is local, visible, and
cancellable: removing the row is a complete cancellation, and Gmail never learns
the user changed their mind. After delivery is confirmed, Gmail is authority and
the local row is gone; there is no local state left to disagree with it.

Every read surface projects the effective label set as the mirror's stored labels
with the account's assertions applied over them, computed where the query runs so
that filtering, ordering, paging, and counts are all consistent with what the user
was shown. One projection, shared by the SPA, the CLI, and MCP.

### What this refuses

- **A generic queue or event log.** The map is the state. There is no append-only
  record of intents, no ordering to replay, no compaction pass.
- **A generic payload, change, or operation table.** A row is a label opinion.
  There is no untyped blob column that a future feature can smuggle a different
  kind of write into.
- **A standing policy over a thread, query, or label.** Intent never refers to a
  set that can grow after the user acted.
- **Local-only mail state.** Every assertion names a Gmail label id and exists in
  order to stop existing. Nothing in `intent.db` is displayed as a fact about the
  mailbox; it is displayed as a pending request. ADR-0098's rule is unchanged.
- **Cross-account atomicity.** Each account has its own file, its own sequence,
  and its own reconciler. An act spanning accounts is several independent acts
  and is reported that way.
- **Locally held drafts, send, snooze, and attachment writes.** ADR-0098 refused
  snooze and send-later on product grounds, and ADR-0196 refused attachment bytes
  on storage grounds. Drafts are a finer distinction: ADR-0098 allows them as
  Gmail-backed operations (`drafts.create`, `drafts.update`, `drafts.send`),
  because those round-trip. What this record refuses is a draft *held locally* as
  durable intent, which is a second durable write shape and not a label opinion
  about a known message. Having somewhere to put a pending write does not reopen
  any of these; none of them is expressible in the shape above, which is the
  point of fixing the shape.
- **Deferred permanent delete and spam.** `messages.delete` is never wired
  (ADR-0116's scope), and a deferred, cancellable, silently-retried intent is the
  wrong shape for an irreversible act. Spam reporting trains a shared classifier
  and is likewise not a triage label the user is merely rearranging.
- **Browser-memory optimism beside the durable ledger.** There is one pending
  state and it is on disk. `optimistic.ts` and its mutation-cache projection are
  deleted rather than kept as a faster parallel path, because two answers to
  "what is pending" is the defect, not the latency.

## Consequences

- **Offline triage works and survives a restart.** The user archives on a plane,
  quits the app, reopens it on the ground, and the archive lands. This is the
  product change the whole record exists to make possible.
- **Undelivered work is countable, showable, and discardable.** Because pending
  writes are rows rather than in-flight promises, the app can state how many
  there are and how old the oldest is. ADR-0199 owns that surface.
- **Every reader agrees.** The CLI, MCP, and the SPA all read the same projection
  from the same two files, so an agent and a human see the same mailbox.
- **Archive, read, star, trash, and custom labels stop being five verbs.** They
  are all the same assertion. Trash differs only in how it is delivered, which is
  ADR-0199's problem and not a second stored shape.
- **A second durable file per account.** Backup, permissions, and corruption
  handling now cover two files instead of one, and they are not covered by the
  same rules: the mirror is disposable, `intent.db` is not. A corrupt `intent.db`
  is a real loss of pending work, bounded by how long delivery was blocked.
- **A message deleted in Gmail can strand an assertion.** The delivery attempt
  fails with a per-id 404 and the reconciler must retire it as unachievable
  rather than retrying forever. ADR-0199 owns that.
- **The refusal list is the point.** Each item is something a queue would have
  made expressible. Writing them down is what stops "we already have a durable
  write plane" from becoming the answer to send-later.
- **Reversible with a named trigger.** A concrete product commitment that cannot
  be expressed as label opinions about known message ids (composing and sending
  mail is the obvious one) reopens the shape. It takes a new ADR that says what
  the second durable write is, where it lives, and how a user cancels it.

## Considered alternatives

- **Keep the mirror stable and store overlays inside it.** Rejected. It makes the
  disposable artifact undisposable, so a corpus bump or a reclaim becomes a
  data-loss decision, and it undoes exactly what ADR-0196 and ADR-0197 bought.
  The mirror's value is that losing it costs only quota.
- **A durable operations queue (id, verb, payload, status, attempts).** Rejected.
  A queue records how the user got to a state; a map records the state. The queue
  forces ordering, replay, compaction, and dedupe questions that the map answers
  by construction with one primary key, and its untyped payload column is the
  door through which send, snooze, and drafts arrive without another decision.
- **Store the desired full label set per message.** Rejected. It converts every
  act into a standing claim over labels the user never touched, so any Gmail-side
  or phone-side change to an untouched label is reverted by the next delivery.
  Partial is the difference between "I archived this" and "I own this message's
  labelling".
- **Key intent by label name for readability.** Rejected on Gmail's own contract:
  ids are immutable, names are user-editable display strings, so a rename would
  silently retarget stored intent.
- **Make a thread or a query the durable target.** Rejected. Both grow. A message
  that arrives after the act would inherit an intent the user never expressed,
  which is a filter rule wearing a triage button's clothes, and Local Mail has no
  place to review or revoke standing rules.
- **Keep the browser projection and add durability underneath it.** Rejected. Two
  pending stores disagree the first time a reload lands mid-flight, and the
  browser copy can only correct rows it already holds, which is why filtered
  counts and paging are wrong today.
