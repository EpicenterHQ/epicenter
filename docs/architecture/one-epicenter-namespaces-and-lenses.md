# One Epicenter, namespaces, and Lenses

This is the explanatory map for the greenfield One-Epicenter destination. The
durable decisions live in ADR-0160 through ADR-0169 and remain Proposed until
their implementation lands. The active replacement plan lives in
[`specs/20260720T002337-epicenter-data-clean-break.md`](../../specs/20260720T002337-epicenter-data-clean-break.md).

## The system

One principal owns one Epicenter:

```txt
One principal
└── one Epicenter
    ├── scalar facts
    │   ├── typed rows
    │   └── typed values
    ├── lazy row documents
    │   └── Yjs state for merge-sensitive content
    └── blobs
        └── explicitly addressed binary data
```

Applications bring Lenses over portions of this body of data. Whispering,
Honeycrisp, Skills, Chat, and Home do not each own a database or synchronization
stream. A Lens can disappear while the data it interpreted remains.

## Structured scalar addresses

A namespace is the first coordinate of a durable address:

```ts
type RowAddress = {
  kind: "row";
  namespace: string;
  table: string;
  rowId: string;
};

type ValueAddress = {
  kind: "value";
  namespace: string;
  value: string;
};
```

The address kind distinguishes a row from a value. A row-owned document uses
the same row address and gains no independent document ID.

The logical hierarchy is honest and inspectable:

```txt
one Epicenter
├── namespace: so.epicenter.whispering
│   ├── table: recordings
│   │   ├── row: abc
│   │   └── row: def
│   └── value: language
└── namespace: so.epicenter.honeycrisp
    ├── table: notes
    └── value: appearance
```

## A Lens is pure JSON

```ts
const whispering = defineLens({
  namespace: "so.epicenter.whispering",
  title: "Whispering",
  description: "Recordings and transcription settings.",
  tables: {
    recordings: defineTable({
      title: "Recordings",
      fields: {
        transcript: field.string(),
        createdAt: field.instant(),
      },
      optional: [],
    }),
  },
  values: {
    language: defineValue({
      title: "Language",
      value: field.string(),
    }),
  },
});
```

`namespace` is a durable address coordinate. `tables.recordings` and
`values.language` are the durable local keys. They are not aliases. Renaming a
property or moving it to another namespace addresses different data.

A Lens interprets exactly one namespace but may describe only part of it.
Multiple Lenses may overlap on the same namespace and address, and none is
canonical. There is no independent Lens ID. An application binds multiple
Lenses when it needs multiple namespaces; only the outer binding names are
ergonomic aliases.

The complete Lens is ordinary JSON. Authoring helpers preserve TypeScript
inference while returning that canonical JSON shape. `parseLens(unknown)` is the
one runtime validity boundary for downloaded artifacts. Validators are derived
ephemeral functions, not persisted Lens state.

Table fields are required by default. The `optional` array names field keys
that may be absent. Missing and `null` remain different facts. Semantic titles
and descriptions belong in the Lens; viewer layout and preview policy do not.

## The namespace refusal

The invariant is stronger than the hierarchy:

> Namespace keys structure durable data addresses only. Every replica still
> stores and synchronizes the complete Epicenter, and no operation may open,
> settle, export, delete, transact, or replicate one namespace independently.

A namespace is not a database, workspace, synchronization scope, deletion
scope, transaction scope, permission boundary, encryption key, retention rule,
backup unit, quota, or physical file. Namespace-filtered reads and inspection
are useful and allowed. An application-specific clear action is a series of
ordinary per-address deletes, not an atomic namespace lifecycle.

## Independent convergence, documents, and portability

Each scalar address converges independently. A local write becomes durable and
available offline before synchronization. Transport may aggregate operations
for efficiency, but that aggregation is not an application commit and creates
no atomic remote visibility across addresses.

Epicenter refuses to become a distributed transactional database. Facts that
must change as one conceptual scalar object belong in one row. Merge-sensitive
collaborative content belongs in that row's Yjs document. A true cross-row
business invariant belongs in an application-specific semantic authority.

A portable Epicenter is the same logical body of data represented as an inert,
identity-free export of one selected authority's complete accepted state. It is
not the live replica file and it never exports one namespace independently.

## Relational inspection

Applications use the type-safe Data API and receive no SQL escape hatch.
Epicenter Home owns relational inspection for people and agents over live and
portable Epicenters. The stable logical scalar relations are:

```sql
rows(namespace_key, table_key, row_id, fields_json)
values(namespace_key, value_key, value_json)
```

These are logical relations, not a promise about a live adapter's private
physical schema. Installed Lenses let Home render the same rows and values as
typed tables.

## Still open

Three presentation and composition choices remain deliberately unfrozen:

1. Whether Home should generate friendly Lens SQL views, and how their aliases,
   collisions, quoting, and ephemeral lifetime work.
2. Whether app-bundled Lenses live only with the active app catalog or whether
   standalone installed Lenses have a separate discovery folder and lifecycle.
3. The exact pure JSON table metadata shape and typed reference-navigation
   ergonomics for the non-enforcing row references settled by ADR-0169.
   References are not field kinds or integrity constraints.

The scalar transport also remains under adversarial review. Independent
per-address convergence and whole-Epicenter scope are fixed; batches,
checkpoints, receipts, cursors, and authority sequences must still earn their
place as mechanisms.
