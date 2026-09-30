# 0467. Interrupted file operations report partial results

- **Status:** Proposed
- **Date:** 2026-09-30
- **Implementation:** ordered native partial results, including interrupted moves, in the experimental file folder.
- **Unbuilt:** released application presentation and recovery for multi-file failures.

## Context

The retained file-foundation prototype demonstrates native intents and process
interruption recovery under a stronger contract. The earlier proposal required
pending evidence, fenced writers, and completed history for every save.

The chosen model permits concurrent filesystem editing, history gaps, and
partial multi-file checkpoints. It does not require an application-wide lock
or a general transaction and recovery framework around ordinary files.

## Decision

**Report what reached the filesystem independently of Git history.** A failed
commit after file publication is a saved change with pending history, not an
incomplete file save. The app offers commit-and-push through history/sync status.
It does not roll back saved files or replay an old operation merely because
history failed.

**Native related-file operations are ordered filesystem steps, not atomic
transactions.** Creation, deletion, and ID rename prepare their known paths,
ownership checks, and scoped reference edits, then attempt those changes.
An interruption can leave only some steps applied. Report known partial results
when the app can observe them, retain caller input still available for review,
and do not claim the operation completed merely because a commit exists.

Do not blindly retry destructive work. Current ownership, destinations, and
references may have changed, including a row recreated at the same ID. A renewed
attempt reads current source and applies the operation's checks again.

There is no mandatory crash-durable journal, pending ref, automatic roll-forward,
global fence, or per-kind recovery UI for this model. Process termination can
lose the intended operation description. Current files remain inspectable, and
a commit can record their partial state. An optional repair must not assume
that ordinary visible path states reveal another writer's original intent.

Browser transactions may provide stronger visibility for logical file changes
without imposing that guarantee on native folders. Media capture still must
deliver the bytes identified by its captured version or refuse; relaxing history
does not authorize substituting different audio during transcription or export.
Remote adoption must separately address dirty files and merge conflicts.

## Consequences

- The prototype's intent machinery is evidence, not a requirement to port it
  into every save. Retain only mechanisms needed by a separately justified
  operation guarantee.
- Source save failure, partial file operation, commit failure, and push failure
  remain distinct outcomes. A warning about history cannot conceal lost input
  or failed file publication.
- Concurrent writers may overwrite source or introduce unrelated changes during
  an operation. No application-wide isolation is promised.
- Without retained history or another byte owner, overwritten intermediate
  source can be unrecoverable. Editor buffers are not durable recovery.

## Considered alternatives

- Retain a durable conditional plan for every operation and block affected
  writers until recovery. It preserves stronger guarantees at the cost of the
  coordination and blocking the user declined.
- Treat a successful Git commit as repair. Git records paths and bytes; it does
  not finish missing moves, media publication, or reference edits.
- Retry the original plan against whatever files now exist. It can delete a
  recreated row or overwrite an intervening edit.
