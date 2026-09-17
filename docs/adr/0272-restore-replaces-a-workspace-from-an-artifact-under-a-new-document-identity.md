# 0272. Restore replaces a workspace from an artifact, under a new document identity

- **Status:** Accepted
- **Date:** 2026-08-27
- **Amended by:** [ADR-0276](0276-an-authority-holds-a-numbered-succession-of-generations-and-nothing-is-ever-overwritten.md) at the authority operation. Restore creates a new generation and re-points rather than installing an envelope over the current one, so the operation is not destructive and restore-over-live is no longer deferred. The refusal of server-side retention is withdrawn with it.
- **Amends:** [ADR-0267](0267-a-workspace-exports-and-imports-as-a-legible-folder-structured-artifact.md) at its unbuilt half. Import is named `restore`, it takes a destination rather than putting an artifact back where it came from, and the authority operation it needed is specified here.
- **Relates:** [ADR-0231](0231-rebuilding-replaces-a-workspaces-current-yjs-document.md) (the document identity and the supersession this rides on), [ADR-0268](0268-a-row-exports-as-one-markdown-file-and-its-codec-is-mandatory.md) (the artifact), [ADR-0270](0270-an-application-has-two-workspaces-and-moving-a-row-between-them-is-the-primitive.md) (the additive verb this is not), [ADR-0271](0271-a-workspace-mirrors-continuously-to-the-epicenter-folder-one-way.md) (the folder this reads).
- **Built:** the artifact reader. `readArtifact` in `packages/data/src/artifact/` parses a folder into one envelope through the same codecs the export writes with, and the round trip is tested end to end through real stores.
- **Unbuilt:** the authority operation, and everything that calls it.
- **Amended by:** [ADR-0281](0281-a-generation-is-a-whole-database-and-a-device-chooses-which-one-it-holds.md) at the loss it announced. A restore discards nothing, because the old generation is retained and stays live, so the paragraph naming what a person gives up describes a cost that no longer exists.

- **Amended by:** [ADR-0289](0289-the-folder-is-where-a-generation-is-minted-from-not-a-surface-kept-current-for-its-own-sake.md) at one supporting reason. "There is no pre-restore backup feature. The mirror is already on disk and already current" is no longer true of the folder, which may be stale and which an application need not render at all. The refusal stands on ADR-0281's ground instead: the generation a restore replaces is retained, so it is the backup.
- **Amended by:** [ADR-0395](0395-restore-is-one-request-that-carries-its-own-safety-copy.md) at product recovery: old readable content is copied into the current working folder and applied through ordinary Push; recovery does not replace the document or generation.

## Context

ADR-0267 specified export and import together and shipped only export, recording why: "The replace-in-place half needs an authority verb that does not exist." That is still the gap, and it is narrower than it looked. The client half of a fleet-wide replacement already exists and is tested: a replica whose stamped document identity does not equal the identity the authority announces concludes `superseded`, discards its record whole, and refills from zero. Nothing needs building on the client at all.

Two questions had to be settled before the verb could be specified.

The first is whether a restore merges or replaces. It replaces, and the case that decides it is the one restore exists for: you delete something, then restore a backup from before the deletion. Merged, the deleted rows do not come back and rows the backup never had survive, so you get a workspace that existed at no point in time. Exactness is the only honest meaning of "restore."

The second is whether the rebuilt document may reuse its old identity. It may not. Admission is equality on the identity, and `since(cursor)` is `WHERE seq > ?` with no range check, so a device that slept through a restore and reconnects under a reused identity is admitted, asks for entries after a cursor the fresh log has not reached, receives nothing, pushes its stale outbox into the new document, and never converges again. Silently. Rotating the identity turns that device's own comparison into the instruction to reset itself.

## Decision

**Restore points at a folder and a destination workspace, and the destination becomes exactly that folder.**

**The destination is an argument, not a property of the folder.** A mirrored folder says where it came from by its path (ADR-0271), and restore does not have to obey it. This is what makes leaving the hosted service export plus restore: mirror your workspace, stand up your own server, restore the folder into it. No migration tool, no second artifact format, and nothing new on either server.

**The authority installs the envelope under a new document identity.** One operation: take the whole state, store it, and name the result something the previous identity is not. Atomic, so there is no window in which the workspace is empty for everyone, and no half-rebuilt log wearing the old name. The alternative, emptying the authority and letting the restoring client refill through its outbox, was refused for exactly that window: a client that dies mid-refill leaves every device converged on a partial workspace.

**Every other device resets itself, through machinery that already exists.** Nothing is pushed to anyone and no device registry exists. The authority names its current document on every connection, as it already does, and a replica holding a different one discards and refills whenever it next connects, a minute later or six months later. A command would require the other device to be online; a fact waits.

**Unsynced work on other devices is lost, and the person is told before they commit.** A device that was holding authored work it had not pushed discards it with the rest of its record. The dialog names this, names the destination server, and names the remedy that actually helps: open the app on your other devices and let them finish syncing first. The importing device can check its own outbox and cannot see anyone else's, and it says so rather than implying otherwise.

**There is no pre-restore backup feature.** The mirror is already on disk and already current (ADR-0271), so the state about to be replaced is sitting in a folder the person owns. Server-side retention of the previous document was considered and refused: it keeps a legible copy of everything on Epicenter's side, spends the end-to-end encryption option the authority protects by never decoding bytes, and makes "export, delete three notes, restore" fail to remove them.

**Restore shows what it is about to do, and nothing on disk vouches for a folder.** The confirmation names the tables the folder holds, the rows the destination is about to lose, and whether the two look like the same application at all. That is the guard: a preview a person reads, not a fact stored in the folder. A `.epicenter` marker file was considered and refused, because the path already carries the identity in place and nothing anywhere parses a path back into a workspace, so the file would have been a second answer to a question the path already owns. A preview also beats a refusal on its own terms: it catches a folder from a different application, it catches two vendors that both ship a table called `notes` (their field names will not line up and it can say so), and when it is wrong about you it lets you continue instead of demanding you hand-edit a file.

**Restore is not move.** Restore replaces a whole workspace and is destructive. Moving a row between workspaces (ADR-0270) adds and never deletes. Conflating them is what made an additive restore look reasonable; they are different verbs with different blast radii and different failure contracts.

## Consequences

- Export and restore together are the manual workspace reset ADR-0267 promised ADR-0256, and now both halves exist as decisions.
- A restore is visible before and after in ordinary tools, because the mirror re-renders to match and `~/Epicenter` can be a git repository.
- The artifact's losses are the restore's losses. Yjs history and identity do not survive, by construction (ADR-0267), and whatever a codec cannot express does not either. A hand-edited file that no longer conforms restores as a nonconforming row rather than being refused or silently repaired.
- `readArtifact` produces an envelope because that is the shape the authority installs. The parsing half serves any caller; the envelope half exists for this operation alone.
- The authority gains its first destructive whole-document operation. ADR-0241 reserved this precisely: it "does not expose a destructive whole-document replacement operation; any future Compact workspace feature must own that product decision explicitly." This record is that decision, and it does not reopen root-document compaction, which remains refused.

## Considered alternatives

- **Restore merges into the existing workspace.** Refused above: it cannot restore a deletion, and "absent from the folder" is indistinguishable from "your backup tool skipped a file," so delete-on-absence is unsafe and keep-on-absence is not a restore.
- **Reuse the document identity so nothing has to rotate.** Refused: it converts a self-enforcing reset into a manual ritual whose failure is silent and permanent, and it saves nothing, because minting a fresh string costs what reusing one costs.
- **A manual checklist: clear every device, then restore.** Refused. A cleared device that can still reach the authority refills from it within seconds, so the clearing undoes itself before the restore happens. Making it work requires "and keep it off the network," which is not an instruction anyone executes reliably.
- **Track which devices have acknowledged the reset.** Refused: there is no device registry, an address is per browser profile per machine, and the fact-based reset needs no acknowledgement to be correct.
- **Upload the artifact to object storage as an automatic backup.** Refused. The mirror already puts it on disk, and sending it to a server hands Epicenter readable plaintext of everything a person owns.
- **A `.epicenter` marker file in every mirrored folder, naming the workspace it was rendered from.** Refused as a second owner of a value the path already holds. The path is unique per workspace by construction (ADR-0271), and reversibility was never a requirement: the mirror writes where its own settings say, and restore takes its destination as an argument, so nothing parses a path back into a workspace. The marker's real job, refusing an obviously wrong folder, is done better by a preview. It earns a second look the day restore runs headlessly, because a preview needs someone to read it.
