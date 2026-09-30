# 0467. Interrupted file operations use operation-specific recovery choices

- **Status:** Proposed
- **Date:** 2026-09-30
- **Unbuilt:** Git-backed pending evidence, publication/history completion, recovery inspection, and the public resolution API.

## Context

Saving current native files and advancing Git history are separate durable
steps. A process can stop after a single file changes but before its revision
completes. A recording rename can also stop between its Markdown move, audio
move, and reference edits. Both cases need retained evidence before publication.

An atomic replacement of one file does not make the entire operation atomic.
The prototype's `keepCurrent` cannot prove that visible files and Git history
form a valid completed operation.

## Decision

**One folder publisher retains a conditional path-change plan before native
publication, then reconciles it against explicitly observed state.** Source
saves, row/attachment creation and deletion, ID rename, and restore use the same
publication mechanism. The operation planner owns source preparation and domain
requirements; message labels do not select different recovery engines.

The retained plan contains an internal operation identity, expected history
tip, touched paths with exact before/after bytes or absence, necessary observed
requirements, known intent, and intended revision. Before/after payloads remain
reachable through Git objects and pending refs until completion or reviewed
abandonment. Object IDs mentioned only in messages or metadata do not retain
those objects. A second store of completed operations is unnecessary.

Admission requirements include checks on paths not written, such as owner-row
existence, exact audio, destination availability, and the attachment candidate
set. Git adoption also identifies the source/destination history and its branch
expectations; its merge policy remains an implementation gate. The native index
is derived state, not another source of accepted data.

For each touched state, recovery distinguishes recorded before, recorded after,
and an unrelated third state. Automatic forward completion is allowed only
when the recorded plan remains valid, every touched state is recognizable,
required bytes exist, and requirements still hold. A third state, moved branch,
changed requirement, or missing payload retains the operation for review.

Observing all before-bytes does not prove publication never happened: an
external editor may have restored those bytes after the app published its save.
Retain the intended version instead of automatically discarding it. Observable
path states alone do not establish domain validity or which choices are safe.

History advancement and caller acknowledgement are separate observations.
Reconcile a lost acknowledgement using retained operation identity and actual
completion evidence before retrying. A failed branch comparison does not permit
blind rebasing or resubmission; revalidate affected paths and domain requirements
against the new observations.

**The app exposes captured evidence and choices specific to the operation.**
The inspection shows current observations beside the retained plan. A row-pair
choice accounts for both Markdown and attachment. A rename choice also accounts
for its declared reference edits. An adoption choice accounts for files and
history together. Neither a generic overwrite flag nor whole-folder acceptance
of current bytes establishes completion.

The resolver revalidates the observations used by the chosen plan before
publication. A subsequent change refuses the resolution and preserves the
retained evidence. Displaced third-state bytes remain recoverable before an
explicit choice replaces them. The operation is removed only when its completed
or abandoned state has been verified and durably recorded.

**Unresolved recovery fences the affected operation while preserving inspection.**
Readers can inspect available evidence. Writers cannot unknowingly edit the
fenced paths or continue Git adoption. Unrelated work may proceed only where
the implementation proves it independent of the pending operation. These checks
serialize participating writers; arbitrary external programs retain the native
check-to-replacement limitation.

The public method names, inspection result types, and per-kind choices remain
to be designed in the implementation plan. Internal operation identity does not
require every UI caller to implement a public replay protocol. Imported commit
metadata cannot authorize recovery writes or establish local completion.

An operation has three caller-visible outcomes: refusal before publication,
an incomplete operation with retained evidence, or completed files and history.
An incomplete operation must not be disguised as a no-write conflict. Browser
publication may use one durable transaction for logical paths and completion;
that transaction boundary must be verified before eliminating pending evidence.

## Consequences

- Recovery UI and library operations need a concrete inspection/resolution
  contract for ordinary native saves as well as multi-path publication.
- One publisher and Git-retained payloads remove per-label journals and duplicate
  byte stores. They do not remove admission guards or coherent resolution choices.
- A recovery choice can refuse when the displayed observations are stale,
  just as a normal save can refuse a stale baseline.
- Fencing and retained payloads cost storage and can delay affected actions.
  Deleting the evidence to unblock the UI would lose the reason for refusal.

## Considered alternatives

- Accept every visible file and remove the pending evidence. That can bless a
  half-published pair or history state the operation never intended.
- Roll back after advancing HEAD. Restoring old files under new history makes
  the saved states disagree and can overwrite intervening edits.
- Omit pending evidence for single-file saves. An external edit can replace the
  published bytes before history finishes, leaving no retained accepted version.
