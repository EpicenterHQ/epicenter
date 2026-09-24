# 0281. A generation is a whole database, and a device chooses which one it holds

- **Status:** Accepted
- **Date:** 2026-08-28
- **Amended by:** [ADR-0417](0417-a-data-address-holds-one-document.md) withdraws generation selection and independently writable histories from current data; historical bytes remain untouched.
- **Amends:** [ADR-0276](0276-an-authority-holds-a-numbered-succession-of-generations-and-nothing-is-ever-overwritten.md) at what a generation does to a device. The numbering, the retention rule, and "nothing is ever deleted except by a person" are unchanged. Withdrawn: `current` as a stored value, `PUT /current`, `setCurrent` as a verb, `supersededBy` as a client signal, and "a replica on an old generation is told, and discards and refills."
- **Amends:** [ADR-0280](0280-a-browser-stores-durable-record-is-a-chain-of-updates-in-indexeddb-folded-on-idle.md) at the database's identity. One IndexedDB database per store becomes one per generation, which is what `record.ts` already implements and what makes discarding one a `deleteDatabase` rather than a scan.
- **Amends:** [ADR-0272](0272-restore-replaces-a-workspace-from-an-artifact-under-a-new-document-identity.md) at the loss it announced. A restore discards nothing, so the paragraph describing what a person is told they are giving up describes a cost that no longer exists.
- **Unbuilt:** all of it.
- **Amended by:** [ADR-0285](0285-a-generation-is-a-url-parameter-and-a-device-stores-no-selection.md) at where the choice lives: the local ledger database, the stored selection, and the in-app switch are withdrawn, and the generation becomes a URL parameter. Held-and-chosen and fully-live are unchanged.
- **Amended by:** [ADR-0286](0286-every-generation-is-minted-from-an-artifact-and-compaction-is-an-export-then-an-import.md) at compaction, which stops being an in-memory path of its own and becomes an export followed by an import.
- **Amended by:** [ADR-0395](0395-restore-is-one-request-that-carries-its-own-safety-copy.md) at product recovery: no generation picker or writable historical generation is required; recovery uses the current working copy and ordinary Push while generation and retirement mechanisms remain separate.

## Context

Every design for restore so far treated a new generation as an event that happens to a device: notice it, push what you owe into the old one, switch, delete. That is a migration, and the machinery lived in the migration. It needed an ordering rule ("switch only when you owe nothing"), a write rule for retired generations ("accepts pushes from members, hands out no new membership"), a blocked-delete path in the switch, and a dialog announcing what would be lost.

ADR-0277 had already removed the reason for all of it without saying so. Once a generation is an address rather than a claim about identity, `document-hub.ts` is right that "a replica holding a superseded generation is talking to a different object entirely, so there is nothing to compare and nothing to refuse." A stale replica is not dangerous. It is somewhere else.

## Decision

**A generation is a database a device may hold, and which one it is looking at is a local choice.**

- **On both sides, a generation is a whole store.** On the authority it is a numbered set of Durable Objects (ADR-0277). On a device it is one IndexedDB database, named for the generation, so discarding one is `deleteDatabase` rather than a scan.
- **A device is never told to move.** There is no `current` on the authority and no supersession state on a replica. "Latest" is derived: the highest complete, untombstoned number in the ledger. The entire notice mechanism is `ledger.some(g => g.complete && !g.gone && g.n > selected)`, checked at boot, on reconnect, and on `visibilitychange`, and shown as a pill.
- **Every held generation is fully live, forever.** It keeps syncing to its own authority and keeps accepting writes. There is no read-only state, no barrier, and no moment at which an older generation becomes special. An older generation is an ordinary generation.
- **Creating a generation refuses to carry unpushed work forward.** This is required rather than permitted: a restore is a statement that the new generation's contents are what the person wants, and quietly merging the old generation's stragglers into it undoes the thing they asked for. The refusal is the absence of code.
- **Nothing is deleted as a step in any protocol.** A person deletes a generation on the authority, and a person purges a local copy. Neither implies the other.
- **Storage names order by what is dropped whole**, coarsest first, so the outermost segment is the boundary a deletion sweeps:

```txt
  epicenter/local/<dataId>/gen/<n>
  epicenter/account/<baseURL>/<principalId>/<dataId>/gen/<n>
```

  A small ledger database at the same name without `gen/<n>` holds the list and the selection. The `claims.ts` Web Lock is taken on that ledger name rather than on a generation, because a device reading one generation while writing another holds two open at once.

- **The local realm has generations and a much smaller ledger.** It allocates numbers and lists them; it does not gate requests and does not keep a sweep list, because both defend against lazy Durable Object instantiation and a browser has no such thing. `deleteDatabase` is complete by itself, so there is no local tombstone.
- **Compact is client-side and in memory:** walk the live rows, serialize each document out through its codec and deserialize into fresh `Y.Doc`s, and write the result into a new generation **at the same row ids**, through the path a copy uses. Minting new ids would break every reference (ADR-0279). The artifact is not in this path; the zip stays the manual, legible export a person can open.

## Consequences

- Drain-then-switch is deleted entire, along with the retired-generation write rule, the switch ordering constraint, blocked-delete on a critical path, ADR-0272's loss dialog, and `superseded` as a client state.
- The complexity moves to "which generation am I on, and how does a person see that," which is a pointer and a piece of UI rather than a protocol with an ordering rule.
- A person can hold two devices on two generations indefinitely, and they will not converge, because they are different histories by construction. The design does not prevent this; it shows it. Work written into an older generation after a newer one exists is fully synced, invisible to any "do you owe anything" check, and dies when that generation is deleted. The browse list therefore shows `lastWriteAt` per generation, and it is a fact a person reads rather than a gate they pass.
- Going back to an older state is not a promotion. It is exporting that generation and minting a new one from it, which keeps "higher number is later" a strict total order. That order is what makes the pill decidable from the list alone.
- Compaction inherits its codec's declared losses (ADR-0268), which ADR-0267 stated for export and which is now also true of a rebuild.

## Considered alternatives

- **Drain, then switch (the design this replaces).** A stale device pushes into the old generation and switches when it owes nothing. Correct, and it is a migration: every mechanism above exists to make the transition safe, and there is no transition here.
- **An older generation goes read-only once a newer one is sealed.** Makes a restore mean something and stops work accumulating somewhere destined for deletion. Refused because a device that has not noticed loses the ability to save, offline, with no warning it could have received.
- **Delete the old generation when a new one is created.** Buys nothing the refusal-to-carry-forward did not already buy, since the machinery was in the drain. What it adds is losing the work, and keeping it costs zero lines.
