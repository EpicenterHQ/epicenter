# 0257: The application document has named `kv` and table roots

- **Status:** Accepted
- **Date:** 2026-08-20
- **Amends:** [ADR-0212](0212-a-row-is-a-yjs-type-and-its-prose-is-a-lazily-loaded-document.md) at the scalar application-document grammar; [ADR-0216](0216-a-name-addressed-location-is-the-only-safe-place-for-a-write-two-devices-both-make.md) at the physical KV root; [ADR-0252](0252-kv-is-one-structured-value-with-whole-value-reads-and-conformance-results.md) at the KV root's name and ownership
- **Relates to:** ADR-0248, [ADR-0258](0258-row-documents-are-opened-through-their-owning-table.md), [ADR-0255](0255-data-definitions-use-one-data-first-public-vocabulary.md)

## Decision

The scalar application document is the one Yjs document persisted under the
application log name `app`. Its current physical grammar is deliberately
small and name-addressed:

```text
Y.Doc "app"
├── get("kv")
│   ├── <field> → one KV attribute
│   └── ...
├── get("tables:<tableName>")
│   ├── <rowId> → nested Y.Type
│   │   ├── <field> → one row attribute
│   │   └── ...
│   └── ...
└── ... another get("tables:<tableName>") root
```

For example, an application with `theme` and `fontSize` settings and `pages`
and `folders` tables is physically:

```text
Y.Doc "app"
├── get("kv")
│   ├── theme
│   └── fontSize
├── get("tables:pages")
│   ├── pageId1 → { title, ... }
│   └── pageId2 → { title, ... }
└── get("tables:folders")
    └── folderId → { name, ... }
```

The row values in this compact example mean nested Yjs types with attributes;
they are not ordinary JavaScript objects and they do not contain a rich row
document.

The grammar has these invariants:

- The settings root is the bare named root `kv`. It is not `!kv`, and there is
  no top-level `tables` container.
- Each declared table owns one named root, `tables:<tableName>`.
- A scalar row is a nested Yjs type stored as an attribute on its table root.
  The row's fields are attributes on that nested type; the physical value is
  not a second map or a JavaScript object embedded in the document.
- Rich row content is not nested under a row attribute. A row's rich content
  lives in an independent Yjs document at its derived address, as decided by
  ADR-0248.
- A current definition always declares `kv`, even when the application has no
  settings beyond the empty object. The application owns any initialization or
  recovery values; the storage layer does not invent defaults.

This is the set of roots the current model mints. It does not promise that a
document created by an older or unknown writer contains no other roots; such
roots are historical or foreign state and are not part of the current model's
write surface.

## Consequences

The application document can be inspected directly: `doc.share` shows the
settings root and one table root per declared table, while row existence is
represented by the row attribute on its table root. The root names are stable
storage addresses, so this grammar is part of the persistence contract rather
than an implementation detail.

The physical grammar does not describe every public API. `data.kv` and
`data.tables` are the data-first runtime surfaces from ADR-0255; this ADR
explains what those surfaces persist and how the scalar application document
is laid out. Row documents live beside the scalar document at derived addresses
and open through their owning table, as decided by ADR-0258.

## Alternatives rejected

- A top-level `tables` map was rejected because the table name is already a
  sufficient address and the extra container adds no storage meaning.
- `!kv` was rejected in favor of the ordinary named root `kv`, which matches
  the current implementation and keeps the reserved root readable in a
  document dump.
- A nested `!doc` container on each row was rejected because creating a nested
  root is operation-addressed. Two devices could first create different
  nested containers for the same row and lose one branch; independent row
  documents give the rich-content root a name-addressed home.
