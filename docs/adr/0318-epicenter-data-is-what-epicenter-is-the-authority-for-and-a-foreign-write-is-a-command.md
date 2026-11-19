# 0318. Epicenter Data is what Epicenter is the authority for, and a foreign write is a command

- **Status:** Accepted
- **Date:** 2026-08-31
- **Amends:** [ADR-0306](0306-borrowed-data-is-disposable-and-a-persons-own-data-is-not.md) at its classification test, which is withdrawn and replaced. Its two classes, its obligations table, and its refusal of migration, repair, backup, and export for a provider copy all stand.
- **Relates:** ADR-0298 (what an authority is), ADR-0312 (the application owns its SQLite file), [ADR-0307](0307-a-derived-index-is-in-memory-sqlite-rebuilt-on-read.md) (the promotion rule this record leans on)

## Context

ADR-0306 classifies by origin and recoverability: data authored here that cannot
be fetched again is a person's own, and a provider copy that can be fetched again
is borrowed. That test is right about every case it was written for and wrong at
the boundary the first mail application reaches.

A Gmail draft composed offline was authored here and cannot be fetched again, so
the test says it is the person's own data and pulls the whole apparatus in behind
it: an Epicenter partition, sync, migration, repair, backup, export. But the
draft is unambiguously Gmail's the moment it exists. Two authorities for one
message is the duelling-writer problem, and the test as written walks into it.

The test is also silent on writes. ADR-0306 has a row for how a shape change
lands and no row for how an edit happens, which is the question a provider
integration asks first.

## Decision

**The classification asks one question: is Epicenter the authority for these
bytes?**

```txt
  Is Epicenter the authority?

    YES  ->  Epicenter Data
             syncs, migrates, repairs, backs up, exports

    NO   ->  the application's own SQLite file
             the platform owes nothing
```

Origin stops being the test and disposability stops being the definition. A
projection is disposable because its authority still holds it; an intent is
disposable the moment its authority accepts it. Both fall out of the answer
rather than deciding it.

The obligations table gains the row it was missing:

| | Epicenter is the authority | a foreign authority |
| --- | --- | --- |
| the local copy is | a replica | a projection |
| **how a write happens** | **accepted here, offered to the authority later, never blocks** | **a command sent to the foreign authority, and the projection re-read from its answer** |
| synchronizes | yes, through the authority | never, it already has one |
| migration on open | required | refused |
| repair on read | required | refused, delete and pull again |
| backup and export | required | refused, the authority holds it |

**A local copy of a foreign authority is read only.** There is no local edit
path. An action a person takes against it is a command, and a command that
cannot be sent yet is a row in a table the application owns:

```txt
intents(id, verb, target, payload, created_at)
```

The row existing is what says the command is owed. It is deleted when the
authority accepts it, and there is no `discharged_at`, for the same reason the
update log has no cursor column: one relation, one meaning, and no second copy of
a fact that can disagree (ADR-0298).

**Intents are per device and never synchronize.** They are authored here and
they are unrecoverable, which is the shape of a person's own data, and they still
must not enter Epicenter Data. Two devices holding one intent both come online
and both call the provider. `archive` survives that because it is idempotent;
`send` mails the same reply twice. The conflict is in the side effect rather than
in the data, so no CRDT converges it, and the repair is leases and exactly-once
delivery per provider. One device owning each intent makes exactly-once true by
construction.

## Consequences

- An intent authored on a device that never comes back online is lost. This is
  accepted rather than mitigated, and it is the reason the table is not synced.
  Syncing it later is not an optimization; it is a different decision that has to
  answer the double-send question first.
- **No platform primitive.** There is no `epicenter.intents` and no third storage
  kind. An intent box is a table in the SQLite file the application already owns
  (ADR-0312). It moves into `@epicenter/data` only when three applications have
  grown the same one (ADR-0307).
- **Delivery is per verb, not per provider.** The platform cannot know that
  `send` is dangerous and `archive` is not. An idempotent verb errs toward
  retrying; a verb with a visible side effect needs the provider's idempotency
  key, or a locally minted identifier written before the call so a retry can ask
  whether the work already landed instead of guessing. This is the same rule the
  transport obeys, stated for an authority that gives nothing for free: **a
  command must not be recorded as delivered at a moment delivery has not been
  confirmed.**
- A provider integration is a fetch loop, a projection, and a command path. It
  needs no outbox against the Epicenter authority, no CRDT, no merge, no
  positions, and no cursor. Adding another integration costs that, not a sync
  partition.
- ADR-0306's own boundary line is restated rather than dropped. It said a local
  copy that cannot be re-fetched belongs in Epicenter Data. It belongs there when
  Epicenter is its authority, which is the narrower and correct version.
- The classification is now mechanical enough to apply to an integration nobody
  has built. Anything with a server that considers itself the owner is a
  projection plus commands, whatever it is made of.

## Considered alternatives

- **Keep recoverability as the test.** Loses on the draft, and on every
  unsent-but-foreign-owned thing after it.
- **Give a provider copy a local write path with an Epicenter-side outbox.**
  Rebuilds the transport per provider without the idempotence that makes it
  tractable, and puts two authorities on one message.
- **Sync the intent table.** Buys offline actions on one device landing from
  another, at the cost of distributed exactly-once delivery against APIs that do
  not offer it.
- **Name intents a third class.** The platform's obligations to an intent and to
  a projection are identical, so it is a distinction the platform cannot act on.
  It is a fact about how an application is built.
