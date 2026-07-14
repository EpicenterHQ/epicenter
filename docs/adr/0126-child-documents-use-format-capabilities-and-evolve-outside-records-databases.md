# 0126. Child documents use format capabilities and evolve outside records databases

- **Status:** Accepted
- **Date:** 2026-07-12
- **Amended by:** [ADR-0128](0128-tables-do-not-declare-document-edit-touch-policy-without-a-runtime-owner.md) (the inert `touchOnDocumentEdit` declaration is withdrawn; document formats, addressing, openers, and conversion ownership are unchanged); [ADR-0134](0134-application-data-generations-own-immutable-workspace-namespaces.md) (child-document formats and addresses are frozen inside one application data generation); [ADR-0138](0138-tables-declare-cells-documents-and-blobs-in-one-field-map.md) (`field.doc(format)` moves document declarations into the table field map)
- **Supersedes:** [ADR-0005](0005-child-docs-are-bound-through-the-workspace.md)
- **Relates:** [ADR-0120](0120-persisted-fields-are-atomic-cells-and-collaborative-bodies-are-yjs-documents.md), [ADR-0130](0130-records-replacement-starts-a-new-epoch-without-an-online-succession-protocol.md)

## Context

ADR-0005 correctly moved child-document identity and opening into the workspace,
but its `.docs({ field: layout })` builder accepts executable attachment
functions and leaves format compatibility implicit. The first SQLite definition
prototype replaced those functions with strings and included the strings in the
records schema hash. That makes independently stored Yjs formats depend on a
central switch and forces an unrelated records replacement whenever a
document declaration changes.

## Decision

Epicenter exposes a small closed catalog of child-document format capabilities.
Each capability owns a canonical JSON format descriptor, a framework-derived
format hash, and the function that attaches its typed handle to a supplied
`Y.Doc`. The initial catalog is plain text, an XML fragment, and validated keyed
records. An XML fragment does not claim a canonical editor node schema. Keyed
records require a runtime value schema; an erased generic is not a format
contract. Applications do not supply raw attachment functions, arbitrary
internal Yjs root keys, or custom format identifiers.

Tables use one declaration shape:

```ts
defineTable({
	fields: {
		id: field.string<NoteId>(),
		title: field.string(),
		updatedAt: field.instant(),
	},
	documents: {
		body: document.xmlFragment,
	},
	touchOnDocumentEdit: 'updatedAt',
});
```

`fields` and `documents` are separate namespaces because they expose different
authorities and access paths. A table may deliberately declare both a record
field named `body` and a child document named `body`; callers distinguish
`row.body` from `table.docs.body`. This is especially useful during an explicit
cross-plane transfer. Code that keeps both must state which plane is
authoritative. The framework does not infer that from matching names. Internal
Yjs root keys are a third, capability-owned namespace and never collide with
either declaration map.

The workspace owns the public opener path
`tables.<table>.docs.<name>.open(rowId)`. Opening owns Y.Doc creation,
persistence, synchronization, readiness, caching, and disposal through a
caller-composed `WorkspaceDocumentRuntime`. The format capability only attaches
its declared Yjs roots and typed handle after the exact room is open. The
runtime's readiness promise must cover the hydration and initial synchronization
that its caller requires before reading the document.

Child-document formats have compatibility identity independent of the SQLite
records database. The records schema hash contains record tables and fields
only. A child-document address includes its format hash in addition to the
workspace, table, document name, and a collision-resistant digest of the full
record ID, so incompatible formats cannot enter one Yjs room and record IDs do
not inherit a storage-path grammar. Table and document names are persistent
address segments, not display labels. Renaming either creates new child-document
addresses. Changing a document format also creates a new child document. An
explicit capability-specific application converter may open one old room and
initialize its new format-addressed room. This is per-document conversion, not
records replacement. Old room bytes remain retained. Version one has no
generic document migration registry, cross-format graph, or workspace-wide scan
that discovers and opens every lazy child document.

`historicalDocument({ workspaceId, table, document, format })` names one
retained old endpoint. It creates no registry and opens nothing. A workspace
with a composed document runtime can open that reference explicitly while its
current table path opens the declared target:

```ts
const previousBody = historicalDocument({
	workspaceId: 'epicenter-notes',
	table: 'notes',
	document: 'body',
	format: document.plainText,
});

using source = workspace.documents.open(previousBody, noteId);
using target = workspace.tables.notes.docs.body.open(noteId);
await Promise.all([source.whenReady, target.whenReady]);
target.content.write(source.content.read());
```

This is a copy and initialization sketch, not a completed authority transfer.
Applications must not treat a declaration change as a completed conversion:
without explicit converter code, the new binary opens an empty new room while
old binaries may continue editing the old room. The opener does not enumerate
documents, coordinate cutover, provide cross-room atomicity, or prove the old
room is final or the target write durable. Authoritative conversion still
depends on the room fence and durability lifecycle and the application's
explicit choice of authority.

A historical reference is an authored address, not an immutable snapshot. Each
shipped format reader must remain available for as long as Epicenter promises
recovery of rooms written in that format.

Moving data between child documents and records is a different operation again:
an explicit app-owned authority transfer. Applications may use ordinary typed
readers and writers, but the maintenance operation must choose exactly one
authoritative plane after cutover. Version one provides no generic or atomic
cross-plane migration, permanent dual write, automatic rollback, generic
reconciliation, or server-executed application conversion. Transfers such as a
counter document into a SQLite cell, a SQLite cell into an initialized counter
document, or a Yjs keyed collection into a SQLite table do not enter
any shared records migration framework. Source bytes remain retained until a separate explicit
cleanup, but retention never makes the old plane authoritative after cutover.

The cohesion rule is: same plane and same authority may earn a framework
migration API. Moving between planes changes authority and remains an explicit
application operation.

This is an asymmetric refusal. Epicenter gives each storage plane one honest
evolution path while applications may explicitly transfer authority between
planes. It refuses to discover, coordinate, atomically migrate, and reconcile
arbitrary data across records and Yjs documents. That deletes the universal
migration registry, cross-plane transaction protocol, document enumeration,
dual writers, generic rollback, cross-format graph, and server-executed
application conversion. The cost is explicit application maintenance work that
cannot claim atomicity across SQLite and Yjs.

Touch policy belongs to the table-to-document relationship, not the document
format. A table may name one instant field that local edits to any of its child
documents update on a coalesced, best-effort basis. The projection is not atomic
with the Yjs edit, proof of room durability, or a complete cross-device
modification timestamp. Touch behavior enters neither records identity nor
document-format identity.

## Consequences

- `.docs(...)`, symbolic layout strings, raw table-level attachment functions,
  per-document touch objects, and the central layout switch disappear.
- Adding or changing a child document does not start a new records epoch.
- Record fields and child documents may use the same declaration name because
  their maps and public access paths remain distinct.
- Renaming a table or document changes child-document identity and requires
  explicit conversion when old content must carry forward.
- Every nonempty record ID can derive a fixed-size safe room segment without
  restricting application IDs to the room-address grammar. This relies on
  SHA-256 collision resistance, not mathematical injectivity.
- A format implementation may be refactored without changing identity when its
  accepted stored content remains compatible. A format change changes its
  descriptor and therefore its address.
- Text to rich text is document conversion. Rich text to text is a potentially
  lossy document projection. Neither operation replaces records.
- A cross-plane transfer cannot claim atomicity across SQLite and Yjs. The app
  owns its cutover and one final authority; old bytes remain retained until
  separate explicit cleanup.
- Epicenter must own the persisted node and mark vocabulary before calling a
  format `richText`; reserving a bare `Y.XmlFragment` alone is insufficient.
- The closed catalog deliberately refuses arbitrary application-defined Yjs
  layouts until another real format earns a safe descriptor and typed handle.
- Old child-document bytes remain available for explicit import or export; the
  runtime never deletes them automatically.
- Historical references name one known endpoint. They do not create a registry,
  a scan, automatic reconciliation, or conversion execution.

## Considered alternatives

- **Keep raw attachment functions.** Rejected because functions provide runtime
  behavior but no byte-stable compatibility identity.
- **Map string layout names through a central switch.** Rejected because the
  switch is manual dependency injection and makes every new format a framework
  branch.
- **Expose `defineDocumentType` publicly.** Rejected for now because the shipped
  formats form a small closed set and arbitrary descriptors let applications
  claim compatibility the framework cannot verify.
- **Keep document layouts in the records schema hash.** Rejected because Yjs
  rooms and SQLite records databases have independent storage and evolution
  lifecycles.
- **Provide one universal migration system across records and documents.**
  Rejected because it would require a migration registry, document enumeration,
  cross-plane transactions, dual writers, rollback, reconciliation, a
  cross-format graph, and server execution of application conversion code.
- **Require developers to rename a document on format change.** Rejected because
  convention does not fence stale binaries from the old room.
