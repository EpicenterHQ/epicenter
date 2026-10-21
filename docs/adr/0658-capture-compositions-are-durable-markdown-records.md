# 0658. Capture compositions are durable Markdown records

- **Status:** Proposed
- **Date:** 2026-10-21
- **Relates:** [ADR-0656](0656-a-folder-owns-typed-input-from-open-to-close.md), Folder input ownership, and [ADR-0657](0657-departure-prompts-only-for-pending-folder-saves.md), departure based on pending saves.

## Context

Capture kept New capture text in page state until Add created a file. Closing
the dialog retained it, but restarting the app lost it. This duplicated content
ownership beside the Folder edit that already provides autosave and recovery.

Compositions must accept unfinished Markdown and pasted text with its own
Thoughts headings. Structured capture editing cannot always represent that
writing without refusal. Creating a completed capture immediately would remove
Add but change those existing input semantics.

## Decision

New capture first creates an ordinary capture-table Markdown record with an
optional boolean `draft: true` field and an empty raw body. Its Folder row edit
owns all subsequent writing. Drafts are discovered from the regular rows query,
with no durable pointer, form-content cache, registry, or separate draft table.
The full-page composition view replaces the modal.

Add promotes the same file and identity. An exclusive Folder action flushes raw
input, reads the current file, validates its frontmatter and nonblank body, then
writes `composeBody(raw)` and removes `draft` together. `capturedAt` becomes the
time of Add, preserving the existing timeline meaning. A failed promotion keeps
the raw draft; an already-promoted file succeeds without composing twice.

Discard uses the existing confirmed, guarded deletion. Failed input must save
before deletion can proceed. If saving or deletion fails, keep the composition
and report the failure rather than discard its only unsaved copy.

## Consequences

Unfinished compositions recover after restart once saved. Empty drafts remain
visible until explicitly discarded. Draft bodies bypass capture-body decoding
in listing, opening, confirmation excerpts, and repair paths. The optional field
preserves existing files without a marker; a previously custom nonboolean
`draft` value now needs repair.

Pending composition input participates in ordinary Folder departure prompts.
Saved drafts do not prompt. Forced termination can still lose keystrokes not
yet stored. Multiple tabs retain Folder's existing merge and unseen-deletion
behavior; this adds no distributed lock or automatic submission on restart.

Unfinished thought forms remain page state. Making those durable would require
a separate decision about positional targets and conflict protection.
