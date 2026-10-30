# 0676. Structured edits share the acquired working document

- **Status:** Superseded by [ADR-0688](0688-one-folder-owned-text-document-per-path.md)
- **Date:** 2026-10-22
- **Amends:** [ADR-0668](0668-one-folder-owned-source-orders-file-publications.md) at table edits, source acquisition, and failed structured publications. Synchronous disposal remains independent.

## Context

A table set previously composed a separate publication from held text, or read
and composed inside the path lane when no text was known. Its failed payload
was not accepted into the working document. Meanwhile list, get, and raw reads
fed source acquisition through their own ordering and invalidation bookkeeping.
Ordinary structured edits therefore differed from typing followed by save.

## Decision

`table.set(id, change)` patches an acquired working document immediately. It
captures and admits that exact publication before notifying observers. Later
edits build on the accepted patch; a failed publication retains it and its
save error. The awaited result reports the captured publication, even when
newer input is pending. Before acquisition, set refuses with `NoContent`.

`table.write(id, document)` publishes a complete row from fields and body,
creating or replacing the file unconditionally. Omitted content is empty.
It accepts no pending input on failure. This is the creation path: a failed
submission with a newly chosen ID cannot later autosave into an orphan file.
Raw file writes and deletes keep the same detached command behavior.

Lists, gets, and raw reads return stored data without populating or updating
working documents. A subscribed editor acquires its own source. An action on
an unopened or inactive document explicitly awaits `edit.refresh()` before
patching. Refresh preserves dirty input. A fresh list must not be overlaid
with a clean inactive editor's stale retained text; only dirty input overrides
stored rows in relationship decisions.

All publications still share one FIFO lane per path. Success acknowledges only
the input captured at admission. Outside changes follow clean observed sources;
accepted dirty input remains local until publication or discard. Full local
publication remains last-write-wins across independent writers. Neither set nor
write provides create-only or conflict detection.

## Consequences

Cold asynchronous patch composition and read-side source ingestion disappear,
along with their cross-read observation counters and hints. The app must choose
complete submission or an acquired-document edit; cold actions perform one
explicit read. Visible editors can read a row that a list already returned.

The distinction protects failed creation retries while giving ordinary edits
one acceptance, autosave, failure, and retry workflow. It does not remove path
ordering, intent identity, atomic storage publication, or synchronous disposal.

## Amendment: Shared document handles, October 22, 2026

The original decision establishes shared working text and detached creation.
This amendment keeps those boundaries and replaces the separate table-set and
text-replacement commands with one document API. The examples in the original
decision record the API at acceptance; the contract in this amendment takes
precedence.

### Ownership and observation

Folder owns one working source and one command lane per path until
`Folder.close()`. `table.document(id)` and `files.document(path, schema?)`
return passive, stable handles by path and schema. Constructing a handle
performs no I/O and installs no listeners. Different schemas interpret the
same source. `getSnapshot()` is pure and returns the cached immutable snapshot.

Handle construction checks readable addresses before creating state.
`files.document(path)` throws `RangeError` for an unreadable relative path;
`table.document(id)` throws for an unreadable row ID, including one containing
`/`. A nested `notes/a/b.md` requires `files.document('notes/a/b.md')` rather
than `table.document('a/b')`. This is a pure structural check, not a storage or
new-name portability check. Legacy IDs such as `''` and `'a: b'` remain
addressable; publication performs its existing save checks.

`subscribe(listener)` reports that snapshot immediately and independently
observes changes. The first subscriber establishes read demand when the source
is unknown or invalidated. The last unsubscribe stops further demand after
any ongoing read; it retains acquired source, input, timers, saves, and
failures. No component owns a document session to close. Folder close releases
resources synchronously, without flushing input or draining admitted work.
Stored lists, gets, and raw reads remain independent of source acquisition.

### Commands and exact results

`replace(text)` accepts complete source, including before acquisition.
`patch(patch)` accepts `DocumentPatch<Schema>` with optional `fields` and `body`;
undefined removes a field. A patch requires acquired text and otherwise refuses
with `ChangeError.NoContent`. Both commands return synchronous
`Result<void, ChangeError>` and start autosave. Separate verbs make the input
form visible at the call site without a `{ text }` envelope or an exclusive
object union.

`save(input?)` accepts a complete source string or a structured patch. With
input, it accepts the change, captures immutable interpreted content, and admits
that publication before observer notification. It returns
`Promise<Result<MarkdownContent<Schema>, ChangeError | SaveError>>`. Success
returns the exact captured content without a row ID, even if a reentrant
observer or later typing has changed the document. Captured input identity,
including later input with equal text, prevents an older success from
acknowledging newer typing. Without input, save publishes current content even
when clean, or retries held input. Save refusal uses `ChangeError.NoContent`
or `ChangeError.Closing`; `SaveRefusal` is removed.

`document.save(patch)` replaces `table.set(id, patch)`. `document.replace(text)`
replaces `replaceText(text)`, and `document.save(text)` accepts and publishes
one exact full-source action. Controls that need synchronous acceptance check
`replace(text)` or `patch(patch)` and then call `void document.save()` to
publish the then-current source, including any observer change between those
calls. `folder.tables.notes.write(id, document)` remains the detached complete
creation or replacement command; a failed submission accepts no pending input.
No compatibility aliases retain the removed methods.

### Framework adapters and public vocabulary

`@epicenter/folder/document` owns `FileDocument`, `DocumentSnapshot`,
`DocumentPatch`, and the live-document error and status vocabulary. Its source
owner is `document-owner.ts`. The plural `@epicenter/folder/documents` remains
the independent stored Markdown utility entry.

Svelte's `reactiveDocument(handle)` and `ReactiveDocument` come from
`@epicenter/svelte/document`. Each adapter bridges tracked getters through
`createSubscriber` to one owner subscription while its effects observe it;
plain getter reads outside tracking do not subscribe. A private WeakMap reuses
the passive adapter by document handle. Repeated wrapping inside a derived
collection therefore preserves unaffected subscriptions instead of rebuilding
them on every edit. This reuse adds no public adapter identity guarantee; the
underlying document handle identifies the document. The last tracking effect
leaving releases the subscription even when the adapter remains cached. No
whole Folder wrapper or caller-managed adapter cache is needed. Derive from
a changing path prop to follow the selected handle.

A compiled Vocab derived-collection check with 40 documents and five edits
registered 240 subscriptions and performed 200 intermediate teardowns with
fresh adapters. Passive adapter reuse registered 40 subscriptions with no
intermediate teardown. Neither version leaked subscriptions. The cache removes
that churn without requiring each caller to stabilize its adapters.

React's `useDocument(handle)` from `@epicenter/react/document` reads the cached
snapshot through `useSyncExternalStore`.

The [Folder contract](../../packages/folder/README.md#working-documents) and
[Svelte adapter guide](../../packages/svelte/README.md#reactive-documents)
contain application examples. This amendment changes API ownership and
observation; durable file formats, per-path ordering, detached creation, and
synchronous Folder close retain their existing guarantees.
