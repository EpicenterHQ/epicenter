# 0782. A waiting write the folder will not make rejects

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Amends:** [ADR-0775](0775-a-write-never-fails-the-folder-keeps-it-until-it-lands.md) at "When the folder moves to `failed` or `closed`, the writes waiting then are not made": each one rejects.

## Context

Under ADR-0775 a write answers once it has landed and never fails while the
store is out of reach. A write still waiting when the folder failed or
closed was dropped, and its promise never answered. Code awaiting it waited
forever, and code that had moved on could not tell: the conversation showed
a sent message whose write was dropped and could ask the model about it, so
an answer could be saved without its question.

## Decision

**A write never fails while its folder lives; when the folder fails or
closes, every write still waiting rejects with `FolderClosed`.** The folder's
state already says why (`<WhenOpen>` shows it), so the rejection is for the
code that awaited the write, not for a person: it stops what depended on
the write. The conversation asks the model only after its message's `set`
has answered.

## Consequences

- No write's promise is left unanswered.
- Code that awaits a write stops when its folder goes away, instead of
  waiting forever or acting on a write that was never made.
