# 0198. Local Mail's one durable local write is a convergent request, and a generative action never becomes one

- **Status:** Proposed
- **Date:** 2026-08-01
- **Amends:** [ADR-0098](0098-local-mail-state-round-trips-through-gmail.md) at its refusal of local-only mail state. ADR-0098 refused device-bound behavior "until a future ADR accepts device-bound behavior with explicit failure semantics"; this is that record, and it admits exactly one bounded class. Its rule that every state a human acts on round-trips through Gmail is otherwise untouched, and snooze and send-later stay refused.
- **Relates:** [ADR-0082](0082-local-mail-syncs-by-push-free-history-list-polling.md) (the polling pass this record extends), [ADR-0116](0116-local-mail-is-desktop-first-one-bun-engine-no-background-mail-service.md) (desktop-first, one Bun engine, Gmail owns truth), [ADR-0163](0163-scalar-sync-separates-fact-reads-from-numbered-intent-submissions.md) (the scalar wire already owns the word "intent"; this record deliberately does not reuse it), [ADR-0164](0164-scalar-facts-converge-independently-epicenter-refuses-distributed-transactions.md) (one row is the unit of independent convergence, and inseparable facts go in one row), [ADR-0171](0171-every-durable-local-write-leaves-an-automatic-authority-obligation.md) (an Epicenter write drains to the Epicenter authority automatically; that drain is not this one), [ADR-0173](0173-each-row-owns-at-most-one-write-once-immutable-blob.md) (the row-bound blob plane, still Proposed and unimplemented, which is why attachments are refused), [ADR-0188](0188-gmail-app-identity-belongs-to-the-distribution-and-no-epicenter-server-enters-the-gmail-path.md) (no Epicenter server enters the Gmail path), [ADR-0196](0196-local-mails-mirror-is-a-reader-and-one-full-message-fetch-is-its-entire-budget.md) (the mirror is a reader with a one-call budget), [ADR-0197](0197-a-mirrors-corpus-version-names-its-artifact-and-only-the-app-knows-when-one-is-ready.md) (the mirror artifact is named by a corpus version and a bump starts an empty successor)

Two records this design depends on are in flight on unmerged branches and are
therefore cited by number and name only, with no link: **ADR-0191** (the
Epicenter host process owns the mail engine and its sync loop, in process) and
**ADR-0193** (durable authorities preserve truth; disposable materializations can
always be rebuilt). Whoever merges reconciles the numbering. ADR-0191 is a hard
precondition, for the reason given under "Where a request lives".

## Context

A Local Mail triage write is Gmail-first today. `apps/local-mail/src/modify.ts`
calls `messages.modify`, `messages.trash`, or `messages.untrash` per id and folds
the returned `labelIds` into the mirror. If Gmail is unreachable the write simply
fails, and the SPA's optimism (`apps/local-mail/ui/src/lib/optimistic.ts`) is
projected from the TanStack mutation cache, so it lives exactly as long as the
in-flight request. A reload, a crash, or a failed call erases the appearance of
the change and the human's decision with it.

Two product promises now sit on top of that. Reads must work offline after a
sync, without credentials. And an archive or label change made offline must
display as applied while honestly saying it has not reached Gmail yet.

Keeping the second promise requires a durable record of what the human asked
for, and the moment such a record exists the design has to answer three
questions: where it lives, what removes it, and what is allowed into it. The
third is the dangerous one. A durable list of "things to do to Gmail later"
reads like a general effects queue, and a general effects queue eventually
carries a send. A duplicate automatic send is not a degraded experience; it is a
message a person did not write twice arriving twice.

## Decision

**The only Local Mail write that is durable before it reaches Gmail is a
convergent request: one mutable row of desired provider state for one message,
settled by re-asserting it, and deleted the moment the provider fact already
agrees. Nothing else in Local Mail is durably queued. A generative provider
action, `drafts.send` above all, is a foreground action that runs once, is never
recorded for later, and is never retried by a timer.**

Everything below follows from that sentence, and a feature that cannot be built
inside it is refused rather than accommodated.

### Three kinds of local write, three different laws

| Kind                              | Example                        | Idempotent | Cancels by agreement | Durable before it lands | Auto-retried |
| --------------------------------- | ------------------------------ | ---------- | -------------------- | ----------------------- | ------------ |
| Convergent request                | archive, mark read, star, trash | yes        | yes                  | **yes**                 | yes          |
| Authored content                  | a draft body                    | n/a        | no                   | no, in v1 (see below)   | n/a          |
| Generative provider action        | send, permanent delete          | **no**     | no                   | **never**               | **never**    |

The three columns that matter are the last three, and they are not independent.
Durability is earned by idempotence plus cancellation-by-agreement, because
those two properties are what make an unbounded number of retries safe. An
effect that has neither cannot be made safe by a queue, so it does not get one.

### What a request is

One row per `(account, message)`, holding the desired presence of the labels a
human touched on that message:

```txt
mailRequests row
├── account      the mailbox this request belongs to
├── messageId    the Gmail message id it targets
├── desired      { "INBOX": "absent", "UNREAD": "absent" }
└── requestedAt  when the human asked, for display and for the degradation rule
```

The row is the settlement unit because Gmail's endpoint is per message: one row
becomes at most one `messages.modify` call plus, when `TRASH` is a key, one
`messages.trash` or `messages.untrash`. Trash is a Gmail endpoint rather than a
label delta, but it is stored as the `TRASH` key so that one algebra covers every
triage verb, which is already how the SPA models it today
(`deltaForTrashed` in `optimistic.ts`).

A request is not an event and there is no log. Archiving writes
`INBOX: "absent"`. Undoing before settlement writes `INBOX: "present"`, which
equals the observed provider fact, so the key is removed; when no keys remain the
row is deleted. **Archive then undo leaves nothing behind because there was never
anything to cancel: there was one mutable desired state that returned to
agreeing with reality.** The same rule handles a change made on the phone: if
Gmail already reports what the request wants, the request is done and is deleted,
whoever did it.

A request is also removed, not retried forever, when Gmail answers `400` or `404`
for that id (the message is gone) or when the provider fact says the message no
longer exists. This is the per-id error rule `modify.ts` already applies.

One unresolved request per `(account, message)` is the invariant, and it is the
single local writer's invariant, in the same sense `packages/data`'s replica
schema uses the phrase: Local Mail runs on one desktop surface, so one writer
mints these rows. If a second surface ever violates it, the settler applies the
row with the newest `requestedAt` and deletes the others. That is a degradation
rule, not the model.

### Where a request lives, and where it must not

**Not in the mirror.** ADR-0098 already names an overlay table beside the mirror
as the escape hatch it exists to catch, and ADR-0196 and ADR-0197 make the
reason mechanical rather than stylistic: the mirror holds only what
`messages.get` returned, and a corpus-version bump names a new empty artifact
(`mail.v6.db`) that nothing migrates into. A pending request stored there would
be stranded in a predecessor no read path consults. In the vocabulary of ADR-0193,
a request is state that lives nowhere else, so putting it in a materialization
creates an authority by accident.

**Not in a third app-owned durable store.** A private file of pending requests
beside `mail.v5.db` would be a second authority with no backup story, no
portability story, and no law in the corpus governing it.

**In the person's Epicenter, under `so.epicenter.mail`, as ordinary rows.** It is
the one authority the platform owns, it already gives durable-write-plus-
automatic-obligation for free (ADR-0171), and applications already reach it
through a bound Lens.

This is why ADR-0191 is a precondition rather than a nice-to-have. An Epicenter
replica has one local writer, and Local Mail as a separate Bun process would
either need a second replica of the same Epicenter on one machine or would have
to open the desktop host's replica file from outside it. Both are refused.
When the mail engine runs inside the Epicenter host process, there is one
replica, one writer, and no discovery protocol.

The consequence is precise and must be stated in the product, not just here:
**the durable-request promise exists only on the Epicenter host surface.** The
headless CLI and MCP surfaces keep writing Gmail-first with no request row, so an
agent's `modify_labels` still succeeds or fails synchronously. That asymmetry is
honest: an agent calling a tool wants an answer, and a human clicking archive
wants their decision kept.

### Two drains, and they are not the same drain

Writing a request row is an Epicenter write, so Epicenter's own runtime owes the
authority that row (ADR-0171). Settling the request is Local Mail asking Gmail to
match it. Neither implies the other:

```txt
human archives
      |
      +--> request row committed locally
      |          |
      |          `--> Epicenter drain: the row reaches the Epicenter authority
      |
      `--> Mail settlement: the row reaches Gmail, and the fold deletes it
```

A request that has replicated to the Epicenter authority has not reached Gmail. A
request that has reached Gmail may not yet have replicated. Status must never
report one as the other.

### One pass, and no caller controls its order

`sync()` settles unresolved requests for the account, then refreshes provider
facts. That order is not a preference: settling first means the same pass
observes the effects it just caused, so the requests resolve immediately instead
of looking unresolved for one more interval. Callers do not get two verbs, a
drain hook, an ordering flag, or a database handle.

A named triage verb records its request and asks the same settler to run at once,
so an online archive still feels immediate. There is one settler per account and
two entry points into it.

### What the read view shows

The SQL read model stays exactly what ADR-0196 declared: pushed-down filter and
sort over provider facts, nothing else. Unresolved requests are composed over
those rows in memory at read time, which is what `optimistic.ts` already does;
only the source of the pending set changes, from the TanStack mutation cache to
the unresolved request rows. The set is bounded by what has not settled, so this
stays a small join and never a second SQL relation.

Two display rules are part of this decision, not UI taste:

- A row under an unresolved request is shown **as the human left it**, including
  disappearing from a filtered view, because that is the promise.
- It is simultaneously shown **as not yet in Gmail**, and status reports how many
  changes are waiting and since when. The optimism is never allowed to claim
  Gmail agrees.

`LOCAL_MAIL_READ_ONLY` refuses to record a request, not just to call Gmail.
Otherwise read-only mode would silently accumulate writes that fire later.

### Drafts round-trip through Gmail, and v1 has no offline compose

ADR-0098 already permits `drafts.create`, `drafts.update`, and `drafts.send`
within write-through scope, and permitting them is also what makes a draft
visible in Gmail's own app, which is the entire reason ADR-0098 exists. So a
Local Mail draft is a Gmail draft, and **compose requires the account to be
reachable.** An authored body is not durable in Epicenter in v1.

An authored draft is the one thing in Local Mail that genuinely lives nowhere
else, so if offline compose is ever promised, Epicenter is the only defensible
home for it and the body is a scalar field, not a Yjs document: there is no
second concurrent editor, because Local Mail ships no phone code (ADR-0080,
ADR-0083) and Gmail's app cannot edit an Epicenter row. That reopening needs a
new ADR, because it means unsent bodies replicate through Epicenter servers, and
a reply draft usually quotes provider content that ADR-0196 keeps local.

### Send runs once, in the foreground, and is never repaired by a timer

`drafts.send` creates and delivers a message. It is not idempotent, and Gmail
offers no per-request idempotency token, so after an ambiguous outcome (a
timeout, a dropped connection) the client cannot tell "not sent" from "sent, and
the response was lost". The available checks (does the draft still exist, does a
matching message appear in `SENT`) are observations that race the very outcome
they are inspecting.

Therefore: **send is never recorded as a request, never entered into any drain,
and never retried automatically.** An ambiguous send is reported to the human
with what is known, and the human decides. This forecloses a send outbox,
scheduled send, and retry-on-reconnect for mail, which is the same family
ADR-0098 refused as send-later and refuses again here for a sharper reason.

### Attachments stay refused in v1

Compose is text-only. The row-bound blob plane (ADR-0173) is Proposed and
unimplemented, its publication drain (ADR-0171) is unbuilt, and ADR-0196 refuses
attachment bytes on disk beside the mirror. There is no place to put the bytes
that any record currently governs.

### Vocabulary

Local Mail says **provider fact** (what Gmail returned, materialized in the
mirror), **request** (durable desired provider state), **settle** (apply
unresolved requests to Gmail and fold the results), and **send** (a generative
action). It does not say *intent*: ADR-0163 owns that word for the scalar sync
wire, and a mail request is not one of those.

### The app-facing surface

One mailbox handle per account. Reads return already-composed rows. Every write
is a named domain transition that owns its own request internally.

```ts
type Mailbox = {
	messages(query: MessageQuery): Promise<ProjectedMessage[]>;
	message(id: string): Promise<ProjectedMessageDetail | null>;
	labels(): Promise<LabelSummary[]>;
	status(): Promise<MailboxStatus>; // as-of, corpus state, unsettled count

	archive(ids: string[]): Promise<void>;
	moveToInbox(ids: string[]): Promise<void>;
	markRead(ids: string[]): Promise<void>;
	markUnread(ids: string[]): Promise<void>;
	star(ids: string[]): Promise<void>;
	unstar(ids: string[]): Promise<void>;
	addLabel(ids: string[], labelId: string): Promise<void>;
	removeLabel(ids: string[], labelId: string): Promise<void>;
	trash(ids: string[]): Promise<void>;
	untrash(ids: string[]): Promise<void>;

	sync(): Promise<SyncOutcome>; // settle, then refresh provider facts
};
```

There is no `db`, no writer handle, no `create` flag, no `onWrite` callback, and
no way to settle without refreshing. Verbs are directional rather than toggles,
so each one is total and idempotent; the surface picks which to call from the
labels it is already rendering.

Cross-account aggregation is a view that reads several mailboxes. There is no
combined mailbox, no cross-account request ordering, and no shared settler.

## Consequences

- **Offline triage is real and honestly labelled.** A person on a plane archives,
  labels, and trashes; the changes survive a restart; they reach Gmail on the
  next sync for that account; and until then the UI says so.
- **Undo before settlement costs nothing and leaves nothing.** There is no
  compensating event to author, no ordering to preserve, and no window in which
  two contradictory effects both apply.
- **The promise is bounded to an active session, and must be worded that way.**
  Requests settle when a sync runs for that account, which under ADR-0191 means
  while the Epicenter host is open. Local Mail does not promise unattended
  delivery, and the wording in the UI is "waiting for the next sync", never
  "sending".
- **Message ids, label ids, and timing reach the Epicenter authority.** Subjects,
  senders, and bodies never do. This is a real widening of what leaves the device
  compared to today, and it is the price of durability. It does not touch
  ADR-0188, which is about the Gmail credential path, not about metadata.
- **A settled request leaves a terminal row tombstone** in the Epicenter
  authority (ADR-0163), so the tombstone count grows with triage volume. It is
  bounded by messages triaged rather than by actions taken, because the row is
  per message, and a Restore starts a fresh authority lifetime.
- **The mirror stays exactly what ADR-0196 and ADR-0197 made it.** No new column,
  no corpus-version bump, no overlay table, and no state that a rebuild would
  destroy.
- **Headless surfaces keep today's semantics** and gain a stated asymmetry: a CLI
  or MCP write fails when Gmail is unreachable, and `local-mail sync` refreshes
  provider facts without settling host-owned requests. Status is where that shows.
- **What this forecloses:** a general mail effects queue, a send outbox,
  scheduled send, retry-on-reconnect for send, an attachment store, a second
  app-owned durable store beside the mirror, and any caller-visible control over
  settlement ordering.
- **Reopen triggers, each needing its own ADR:** offline compose (which puts
  authored bodies in Epicenter), attachments (which needs ADR-0173's blob plane
  built), and unattended delivery (which needs an always-on owner, the same
  trigger ADR-0098 and ADR-0116 already named).

## Considered alternatives

- **No durable request plane at all: disable triage while offline.** The largest
  refusal available, and it deletes this entire record. Rejected because the
  product promise is offline triage on top of the offline reader ADR-0196 built,
  and a reader that can show mail but not act on it is half a tool. This remains
  the fallback if the request plane ever costs more than it earns.
- **A durable event log of triage actions.** Rejected: it makes archive-then-undo
  two durable events that must be replayed in order and compensated, invents
  ordering Gmail cannot honor across messages, and gets cancellation wrong in
  exactly the case a human notices.
- **Requests in an overlay table beside the mirror.** Rejected: ADR-0098 named
  this as the hazard it exists to catch, and ADR-0197's versioned artifact would
  strand the rows in a predecessor nothing reads.
- **Requests in a new app-private durable store.** Rejected: a second authority
  with no backup, portability, or restore law, invented to avoid using the one
  authority the platform already owns.
- **One request row per `(message, label)`.** Rejected in favor of one row per
  message: the settlement unit is the Gmail call, which is per message, and per
  label multiplies tombstones without buying finer convergence than the single
  writer already has.
- **A deterministic row id derived from `(account, messageId)` to make the
  one-row invariant structural.** Rejected because it is not expressible:
  `create()` in `@epicenter/lens` types `id` as `never`, so row ids are minted by
  the runtime. Deriving and parsing an id would also recreate the flat qualified
  key ADR-0163 deleted.
- **Draft bodies in Epicenter in v1.** Rejected for now: ADR-0098 already makes a
  Gmail draft the shape that reaches the phone, and an Epicenter draft body
  replicates unsent content plus the provider text it quotes. Named above as a
  reopen with its own ADR, not as a deferral with a roadmap slot.
- **A Yjs document for the draft body.** Rejected: there is no second concurrent
  editor, so it would buy merge semantics for a single writer and pay hydration
  and query costs for them.
- **Send in the request plane with an idempotency key.** Rejected because the key
  would have to be honored by Gmail, and it is not. A client-side key can
  deduplicate the client's own retries and cannot tell whether the server already
  delivered.
- **Retry an ambiguous send after checking `SENT`.** Rejected: the check races
  delivery, depends on the mirror being fresh, and its failure mode is the one
  outcome that is unacceptable. A human reading one sentence resolves it
  correctly in seconds.
