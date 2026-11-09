# 0523. Applications own drafts in edit sessions and leave one open item

- **Status:** Superseded
- **Superseded by:** [ADR-0528](0528-applications-edit-files-through-the-query-cache.md)
- **Date:** 2026-10-11
- **Supersedes:** [ADR-0483](0483-honeycrisp-shares-one-canonical-editor-per-open-row.md) (one retained canonical editor per open row)
- **Relates:** [ADR-0515](0515-snapshot-saves-serialize-writes-and-retain-only-the-latest-pending-text.md) (the autosave each session runs), [ADR-0518](0518-a-row-is-read-through-one-pipeline-and-repaired-as-text.md) (what a session reads and repairs)
- **Unbuilt:** acceptance on a real storage host with a person editing. The keyed slot for pages with several items open at once is built (`createOpenItems`); Whispering keeps a slot per open file on it.

## Context

ADR-0515 and ADR-0518 removed the retained row editor from `@epicenter/folder`:
a row is read through one pipeline, and an editing session is a guarded
autosave the caller drives. Todos, Vocab, Capture, Honeycrisp, and Whispering
each rebuilt their editing on that. Written per app, the same lifecycle (wait
for saves before leaving, release the session, ask before discarding a failed
draft, admit a command before its first await so close waits for it) diverged
within one pass: a late load left unreleased, a discard bound to a session
guessed before the open, a delete that close could overtake, and the same
conflict prompt copied five times.

## Decision

**An application owns each open file's draft in an edit session from
`@epicenter/svelte/edit-session`, and a page that shows one file at a time
keeps it in the slot from `@epicenter/svelte/open-item`; a page with several
open at once keeps a slot per key (`createOpenItems`).**

- A session saves each edit at once through the folder's autosave and never
  assigns the draft. A change made elsewhere, or a deleted file, is a conflict
  the person resolves: Reload theirs, or Keep mine, which creates a deleted
  file again unless the app refuses to restore it.
- Keep mine, Reload theirs, and rename run one at a time with input locked.
  A released session takes no input and starts nothing after its next await.
- Leaving an item waits for its saves and releases its session. A failed save
  answers `unsaved` with that session, and only that session's discard lets
  the open proceed. Opening the shown item does nothing.
- A row whose text is not valid opens as text, repaired in place, and opens as
  a row again once it reads as one (`keyOf`).
- Commands count from their call (`@epicenter/svelte/admissions`), so close
  and quit wait for all of them.
- Lists and items are read when a view opens, after the app's own actions,
  and when the person returns. Whether an idle item adopts a newer version on
  return is the app's choice.

Listings, loaders, refusals, departure, and what a person is told stay with
each app.

## Consequences

The retained editors, handoffs between list and file views, path
reservations, hint-following rereads, and per-app save bars are gone. An app
shows one open item, so unsaved input does not outlive leaving it without the
person discarding it. Hand-written frontmatter loses its comments on the first
save (ADR-0518).

## Considered alternatives

- **One owner per app with no shared slot.** Simpler to start; the five
  copies diverged into the bugs above within one pass.
- **A shared owner that also lists, loads, and words refusals.** Rejected:
  those differ by app, and owning them would make the helper a framework.
