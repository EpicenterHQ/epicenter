# 0138. Tables declare cells, documents, and blobs in one field map

- **Status:** Accepted
- **Date:** 2026-07-14
- **Amends:** [ADR-0120](0120-persisted-fields-are-atomic-cells-and-collaborative-bodies-are-yjs-documents.md), [ADR-0126](0126-child-documents-use-format-capabilities-and-evolve-outside-records-databases.md), [ADR-0089](0089-the-blob-store-is-a-presigned-s3-kernel-and-the-bucket-is-its-only-index.md), [ADR-0091](0091-blobs-trade-a-file-for-a-durable-content-addressed-url-documents-are-the-only-manifest.md)

## Context

The current SQLite definition splits one row's durable shape across `fields`,
`documents`, and a workspace-level blob-plane registry. That split hides
document relationships from the row schema and gives blobs a second registry
even though both are values reached through a table row.

## Decision

A table declares every row-owned value in one `fields` map:

```ts
defineTable({
	fields: {
		id: field.string<RecordingId>(),
		title: field.string(),
		audio: field.blob(),
		transcript: field.doc(document.plainText),
	},
});
```

A cell field emits a SQLite column and record-wire cell. `field.blob()` emits a
SQLite column whose value is an immutable `BlobRef` containing `hash`, `size`,
and `mediaType`; the bytes live in content-addressed blob storage. Blob bytes
must be durable before a mutation may publish their reference. There is no
workspace blob registry and no application delete operation. Initial retention
is indefinite; platform garbage collection may be added only when its
reachability and safety contract is proven.

`field.doc(format)` emits no SQLite column. It declares one lazy child document
whose address is derived from the workspace ID, table name, SHA-256 digest of
the complete row ID string, field name, and format hash. No other row content
enters that address. The row and declared field own its identity and lifecycle.
There is no first-class relocatable document ID.

Deleting a row makes its derived documents and blob references unreachable from
the live workspace and from new exports. Physical bytes may remain. The platform
does not coordinate cross-plane deletion, call an application cleanup hook, or
check row existence on every document session. A stale update to an absent row
is an idempotent no-op and never resurrects it. Fresh public creation uses a
fresh random ID; the platform does not retain a permanent deleted-ID set.

The composed `field` catalog belongs to `@epicenter/workspace/sqlite` because
document formats are workspace capabilities. `@epicenter/field` remains the
lower-level catalog for persisted cell schemas.

## Consequences

- The declaration is the manifest for export, inspection, addressing, and
  lifecycle. Exporters never scan SQLite metadata to guess special columns.
- A document field appears in table tooling even though it has no cell value.
- Documents and blobs remain separate storage planes with separate conflict and
  transfer behavior; only their declaration ownership is unified.
- A blob URL is derived at access time from its hash and authenticated service
  endpoint. The durable value is the reference, not a deployment-specific URL.
- Removing the last live reference does not promise immediate physical deletion.

## Considered alternatives

- **Keep separate `documents` and workspace `blobs` maps.** Rejected because
  they duplicate the row's durable manifest and force export-specific discovery.
- **Store blob bytes in SQLite.** Rejected because large immutable bytes should
  not ride row synchronization, SQLite snapshots, or ordinary table queries.
- **Store a blob URL.** Rejected because URLs contain deployment and access
  policy while a content hash is stable and portable.
- **Give documents independent IDs.** Rejected because relocation, orphaning,
  and another registry buy no current product behavior.
- **Synchronously delete every physical child on row deletion.** Rejected
  because SQLite, Yjs, and blob storage do not share one transaction.
