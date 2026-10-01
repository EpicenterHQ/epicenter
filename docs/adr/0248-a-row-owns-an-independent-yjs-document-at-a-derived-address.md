# 0248. A row owns an independent Yjs document at a derived address

- **Status:** Superseded
- **Date:** 2026-08-19
- **Superseded by:** [ADR-0295](0295-a-database-is-one-yjs-document-and-a-row-holds-its-rich-content.md), which makes a database one Yjs document and puts a row's rich content in the row.
  open ADRs before merge.
- **Supersedes:** [ADR-0215](0215-an-application-is-one-document-and-a-row-owns-a-nested-container.md)
  at the index/document split. Withdrawn: the row's rich document as a nested
  `!doc` container in the application's Yjs document, and the synchronous
  document handle that shape required.
- **Amends:** [ADR-0212](0212-a-row-is-a-yjs-type-and-its-prose-is-a-lazily-loaded-document.md)
  at the document split. The row remains scalar state in the application
  document, and its rich document is again an independent Yjs document loaded
  on demand.
- **Amended by:** [ADR-0250](0250-a-database-exposes-documents-as-first-class-members-and-applications-compose-their-lifecycles.md)
  at the public namespace and lifecycle owner. Withdrawn: intrinsic
  table-owned retirement and `table.document.open`; the independent document,
  derived address, and opaque manager remain.
- **Relates:** [ADR-0214](0214-one-sqlite-file-holds-the-update-log-and-the-projection-and-history-lives-outside-the-crdt.md),
  [ADR-0238](0238-the-live-document-is-the-truth-while-open-and-persistence-is-a-visible-debt.md),
  and [ADR-0241](0241-a-store-is-truth-plus-debts-and-sql-is-a-composed-follower.md).
- **Built:** `documentAddress` in `packages/app/src/data/definition/addresses.ts`, the
<!-- doc-path-check: ignore-next-line (a file this superseded record described, since deleted) -->
  document manager in `packages/app/src/data/store/documents.ts`, the composed
  row-deletion path in the table verb, and the multiplexed envelope payload in
<!-- doc-path-check: ignore-next-line (a file this superseded record described, since deleted) -->
  `packages/app/src/data/store/envelope.ts`. The nested `!doc` container is
  deleted.
- **Amended by:** [ADR-0284](0284-the-application-document-is-an-index-and-a-rows-remaining-fields-live-in-its-own-document.md) at what the document at the derived address holds: a row's non-index scalars as well as its prose.

## Context

Scalar row fields and rich collaborative content have different access and
loading needs. Lists need titles and previews without hydrating every body, and
rich content needs its own persistence, synchronization, and lifetime. The
current nested `!doc` container couples those concerns inside one application
document and makes lazy loading impossible without reintroducing a second
runtime model.

The repository already has one structured `RowAddress` grammar for database ID,
table name, and row ID. Those coordinates reject empty or slash-bearing values
when they are declared or admitted. The document address can therefore be a
simple derived string without escaping arbitrary input.

## Decision

**Each row owns one independent Yjs 14 document. The database layer derives its
address from the row's structured coordinates, and a document manager accepts
that address as an opaque string.**

The canonical address is the fixed-depth string:

```text
{databaseId}/{tableName}/{rowId}
```

The application or database layer owns the one-way composer:

```ts
function documentAddress(address: RowAddress) {
	return `${address.databaseId}/${address.tableName}/${address.rowId}`;
}
```

The composer does not encode, parse, or revalidate coordinates. Coordinate
validation remains at the existing name-creation and admission boundaries. A
future coordinate that cannot satisfy a slash-free grammar must earn a new
grammar or be refused; it must not be silently escaped. The composer has no
inverse, and the document manager never scans or interprets prefixes.

The manager's public boundary is string-based:

```ts
const address = documentAddress({ databaseId, tableName, rowId });
const document = await documents.open(address);
```

The manager owns full hydration before `open` resolves, local persistence,
synchronization, in-memory reuse, and unloading after the final handle is
durable. It does not know what a database, table, row, preview, schema, or root
means. One row address maps to one Yjs document; applications may place several
named roots inside that document.

The database/table layer composes row deletion with document retirement. A row
delete derives the same address, records the row deletion, and records a durable
document tombstone. The manager may garbage-collect the document bytes later,
but a late update must not resurrect a retired address. Callers do not manually
coordinate two independent delete calls.

The structured `RowAddress` remains the canonical coordinate object for scalar
data. Its internal `addressKey` remains an internal structured-identity key and
is not reused as the document address.

The composer intentionally returns the interpolated value without an explicit
`string` annotation or `as const`. An interpolated template with runtime values
has a `string` result, and TypeScript cannot make `as const` preserve a runtime
address. The document manager needs an opaque string, so adding a generic
template-literal return type or a nominal wrapper would add type machinery
without adding a product invariant.

## Consequences

- Lists can read scalar fields and previews without loading rich documents.
- Rich documents can hydrate, persist, synchronize, and unload independently
  while remaining logically owned by their rows.
- Row deletion has one application-owned composition point and cannot leave a
  live document behind through a missed notification.
- The manager stays reusable because it has no database schema or row model.
- The document address remains readable in logs and storage keys. It is not a
  URL, a parser grammar, or a prefix namespace.
- The current nested `!doc` path must be deleted when this decision is built;
  compatibility readers and dual document shapes are not part of the design.
- Cross-plane row and document deletion requires a durable tombstone protocol;
  independent physical documents do not provide distributed transaction
  semantics for free.

## Considered alternatives

- **Encode every segment:** refused because the existing coordinate grammar
  already guarantees safe segments. Escaping would hide invalid inputs and
  create a second address spelling.
- **Let every caller delete the row and document separately:** refused because
  omission creates orphaned documents. The table/database lifecycle owns the
  composition.
- **Let the manager parse database, table, and row coordinates:** refused
  because it gives the manager schema knowledge and revives prefix semantics.
- **Use `as const` on the interpolated template:** refused because it is not a
  valid or useful way to infer a runtime template address in TypeScript.
