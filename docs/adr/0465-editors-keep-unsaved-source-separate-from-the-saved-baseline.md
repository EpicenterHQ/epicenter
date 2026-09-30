# 0465. Editors keep unsaved source separate from the saved baseline

- **Status:** Proposed
- **Date:** 2026-09-30
- **Unbuilt:** the file-backed editor controller, shared source preparation, and conflict/disposal integration.

## Context

The file-foundation demo coordinates debounce, save queues, selection, and
refresh in `apps/whispering/dev-files/main.ts`. Release Honeycrisp's
`openContent` derives title and timestamp from its live body through separate
row updates. A migrated source editor must not turn those controls into writers
that compete with its own unsaved typing.

Saving is asynchronous. Acknowledging saved text A cannot prove that newer text
B reached storage. A subscriber that advances B's baseline to another writer's
C would let B replace C without a conflict.

## Decision

**An open editor owns one source buffer and one accepted baseline entry.**
The buffer is the editor's current text, including unsaved changes. The
baseline is the captured entry used by the next conditional save. They are
different states; the baseline adds no public wrapper around the entry.

Body editing, frontmatter controls, and complete-source editing change that
same buffer. Derived title and timestamp changes enter the generation that
contains their body change. They do not independently update the saved row.
An editor adapter reuses the source-preparation implementation used by table
updates; UI handlers do not splice YAML or encode files.

The controller submits complete captured source through `writeSource`. Mode
and frontmatter validity do not select a different persistence policy.
Structured controls refuse unsupported transformations without modifying the
buffer. Source editing remains available when YAML is invalid. Invalid UTF-8
uses explicit byte repair rather than a text buffer.

**A save captures one generation and runs in a serialized queue.** On success,
the returned entry advances the baseline, while input that arrived during the
save stays in the editor and remains dirty. On conflict, the controller retains
the baseline and input, pauses automatic saving, and offers the saved state for
an explicit choice. An uncertain file publication retains input for review.
A failed Git commit does not pause autosave or prevent the file-save result
from advancing the baseline. A renewed save uses the
version actually reviewed and can conflict again. Reloading saved text is an
explicit discard when input is dirty.

Subscribers invalidate saved observations. A clean editor may reload source
and baseline together. After an asynchronous read, it rechecks editor identity,
generation, cleanliness, and pending saves before installing the result. A
dirty editor keeps its baseline. Notifications received during a save are
rechecked after acknowledgement: another writer's C may have followed A.

**The app owns draft retention and disposal before closing folder I/O.**
Selection changes retain the old draft, settle all remaining input, or obtain
an explicit discard. Saving an earlier captured generation is insufficient for
disposal if newer typing exists. Folder teardown must account for remaining
drafts; unsubscribing is not evidence that input was saved.

The controller stays in the editor layer. There is no mandatory folder-owned
document registry, public `notes.open`, or universal `flushAll`. Git, shell,
sync, and saved-file export do not flush arbitrary buffers. The editor batches
typing before saving; there is no second Git checkpoint schedule. Explicit Save
requests a captured generation through the same publisher as autosave. Success
means file publication, independently of commit or push success. History status
and the commit-and-push action operate on saved files and do not flush drafts.

## Consequences

- The existing text editor can supply the buffer; no second text model is
  required merely to invoke a table method.
- Baseline, generation, in-flight save, deferred invalidation, conflict, and
  disposal state remain necessary. A shared controller centralizes that state
  without making it disappear.
- An action for an already open note routes into that editor. Independent
  drafts can conflict. A global guarantee that every pane shares a draft would
  require a separate registry and ownership decision.
- Crash recovery of unsaved typing is a separate product promise. Saved-file
  correctness does not establish durable draft storage.

## Considered alternatives

- Refresh the baseline on every notification. Dirty input could then overwrite
  an external edit without detecting that it began from older bytes.
- Give storage a permanent document handle. It couples editor retention,
  subscriptions, and disposal to folder lifetime and adds work to closed-row
  actions that need only an entry and one conditional save.
