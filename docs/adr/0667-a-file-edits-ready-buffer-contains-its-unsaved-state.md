# 0667. A file edit's ready buffer contains its unsaved state

- **Status:** Accepted
- **Date:** 2026-10-22
- **Amends:** [ADR-0666](0666-one-source-draft-per-path-saves-against-its-observed-source.md), the public state vocabulary. Exact-source saving and conflict guards remain unchanged.

## Context

A file edit exposes displayed text, storage read status, and pending input as
separate reads. Callers reconstruct whether the editor is loading, unavailable,
or ready, then interpret a saving boolean and optional save error. The fields
allow combinations that the owner cannot produce: unsaved input necessarily
supplies readable text. Pending input also repeats the path and displayed text.

The editor contains one buffer. That buffer can hold unsaved work, including
work whose save is running, failed, or conflicted. Availability and saving are
related lifecycles, with saving nested inside a readable buffer.

## Decision

**Expose one immutable buffer snapshot, with unsaved state only on its ready
variant.** Vanilla code reads `fileEdit.getBuffer()`. The Svelte adapter exposes
`fileEdit.buffer`; it adds reactivity and automatic initial reads, not messages
or another state model.

```ts
type BufferSnapshot = { error?: BufferIssue } & (
  | { status: 'unread' | 'loading' }
  | { status: 'unavailable'; error: BufferIssue }
  | { status: 'ready'; text: string; unsaved?: Unsaved }
);

type Unsaved =
  | { status: 'dirty' | 'saving' }
  | { status: 'failed'; error: SaveFailure }
  | { status: 'conflict'; error: SaveConflict };

type Recovery = { path: string; text: string } & Unsaved;
```

`unread` means no source is known and no read is active. `loading` means
a read is active without retained text.
`unavailable` requires a failed read or known missing or non-text storage, with
no text retained. A ready buffer can coexist with a failed refresh or deleted
stored file. Held input keeps it ready, so a read never replaces accepted
input. `getText()` remains a scalar convenience; `getMarkdown()` interprets the
same text through the handle's schema.

`buffer.unsaved` is absent when no input is held. Its presence covers all
outstanding work. `dirty` and `saving` distinguish waiting input from a running
write; discard refuses the latter. `failed` and `conflict` distinguish retry
from a whole-source choice. The live value carries no path or duplicate text.
Detached recoveries add both for discard, aggregate failures, settle, and close.
Snapshots retain identity while their fields are unchanged.

**The vanilla owner records command refusals and read feedback.** `buffer.error`
projects a scoped refusal, otherwise the last read failure, otherwise derived
`SourceUnavailable` with a missing or non-text reason. These causes remain
separate internally so clearing a refusal reveals an underlying read failure.
Save failures and conflicts stay in the nested unsaved lifecycle. The owner
publishes feedback before commands return their Results. UI labels remain at
the call site. Domain validation that happens before an edit command remains
with its domain owner.

`save()` and `resolveConflict()` return Results. `discard()` returns
`Result<Recovery | undefined, ActionError>`, distinguishing no held input from
a refused discard. Owner methods act on the current path state. This decision
adds no expected-snapshot parameter or commands attached to snapshots.

**Preserve automatic content reads and passive metadata observers.** Observing
Svelte `.buffer`, `.text`, or `.markdown` starts the first read when the source
is unread. Views need no duplicate mount-time read. Existing queries can still
start or join that read and retain their refresh or size-classification policy.
A failed first read waits for an explicit retry. Vanilla reads remain explicit.
Lock observers and aggregate save indicators request no content. React retains
its automatic first-read lifecycle and explicit snapshot read methods.

## Consequences

- Remove public `Pending`, `ReadStatus`, `getPending()`, `getReadStatus()`, and
  their framework projections. The path owner still retains storage knowledge
  and submitted source internally to preserve exact-source guards and races.
- Source templates first narrow the outer buffer and then check nested
  unsaved presence before branching on save status. No text fallback is needed
  to turn unavailable content into an editable empty string.
- Ordinary command feedback no longer needs a local `report()` wrapper or a
  mirrored refusal message. Precommand domain validation and rich-text
  serialization errors still belong to their existing owners.
- Save indicators observe Folder aggregate metadata. A file view can classify
  size before demanding content, preserving binary and large-file controls.
- In-memory retained source remains recoverable after view departure and save
  failure. This decision adds no crash recovery or durable draft store.

## Considered alternatives

- **Separate buffer and unsaved namespaces.** Callers must reconcile two public
  values. Nested containment expresses that held input supplies readable text.
- **One root status for availability and saving.** A combined union can model
  the valid states, but detached recoveries still need their own save lifecycle.
  Keeping that discriminator on the nested value carries it into recovery
  results without another conversion.
- **Presentation state in the Svelte adapter.** It gives vanilla and Svelte
  callers different failure ownership and encourages adapter-specific messages.
- **Infer loading from absent text and error.** It conflates an untouched edit
  with an active read and prevents direct union narrowing.
