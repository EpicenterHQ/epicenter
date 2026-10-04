# 0160. Lenses interpret durable namespaces without creating lifecycle scopes

- **Status:** Proposed
- **Date:** 2026-07-20
- **Supersedes:** [ADR-0156](0156-applications-bring-workspace-lenses-runtimes-own-workspaces-by-id.md), [ADR-0130](0130-workspace-definitions-expose-tables-with-row-owned-documents-and-a-release-local-kv-lens.md), and [ADR-0158](0158-installed-apps-declare-workspace-ids-but-run-no-bun-modules.md)

## Context

Workspace and Database are not user-visible lifecycle boundaries. One person
owns one Epicenter, but independently authored applications still need stable,
collision-resistant addresses and release-local typed interpretations. A flat
globally qualified key hides the useful hierarchy between a publisher or domain
and its local table or value name. A namespace can expose that hierarchy without
becoming another database, synchronization stream, or lifecycle owner.

## Decision

Scalar data has structured durable addresses:

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

Applications describe a partial interpretation of one namespace with a Lens:

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

`namespace` is the durable namespace key. The property names under `tables` and
`values` are the durable local keys. They are not ergonomic aliases and are not
copied into redundant `key` properties. Renaming `recordings`, moving it to
another namespace, or changing the namespace addresses different data.

A Lens interprets exactly one namespace, but it may describe only part of that
namespace. Multiple installed Lenses may interpret the same namespace and the
same table or value addresses. None is canonical or authoritative. An
application that needs several namespaces binds several Lenses; property names
in that outer binding are ergonomic aliases only.

There is no independent Lens ID. The noun Lens is intentional: this is a
partial, overlapping, release-local interpretation, not a complete schema or a
durable owner. Binding a Lens borrows typed access to an open `Epicenter`. It
creates no storage, performs no synchronization, and owns no disposal.

Table rows have runtime-minted globally unique IDs that callers cannot replace
or reuse. Every live row latently owns exactly one schema-free document and one
zero-or-one write-once immutable blob slot at the row's own address. Neither
capability has an independent public ID, Lens declaration, or lifetime.
Deleting the row, through any Lens or synchronization, revokes open handles and
terminally deletes its document and blob state.

Values are singleton values, not a second database. Row and value addresses are
distinguished by `kind`, so a namespace may use the same local name for a table
and a value without ambiguity.

Namespace keys structure durable addresses only. Every replica still stores
and synchronizes the complete Epicenter. No operation may open, own, attach,
replicate, synchronize, settle, export or import a portable Epicenter, delete or
clear as a lifecycle, transact, authorize, encrypt, retain, back up, or assign a
physical file to one namespace independently. Namespace-filtered reads and
inspection are allowed. An application-specific clear operation is an ordinary
series of address deletes and carries no atomic namespace semantics.

Lenses validate release-local reads and writes. They do not enumerate a
complete schema, migrate stored data, grant access, create indexes, or rewrite
nonconforming data.

## Consequences

- The durable hierarchy is visible in APIs, logical storage, inspection, and
  synchronization without creating per-application databases.
- Applications can share an address by declaring compatible interpretations of
  the same namespace and local key. They need not import one canonical module.
- Renaming any address coordinate creates a new data identity. No implicit
  alias or migration follows the rename.
- A Lens can be installed, removed, or replaced without owning or deleting the
  data it interprets.
- Whole-Epicenter lifecycle and synchronization remain explicit invariants,
  rather than conventions that namespaces could gradually erode.

## Considered alternatives

- **One flat globally qualified string per table or value.** Rejected because it
  hides address structure, requires prefix parsing for inspection, and repeats
  the namespace in every declaration.
- **Namespace as a database, workspace, application owner, or synchronization
  scope.** Rejected because it recreates the lifecycle boundaries removed by
  One Epicenter.
- **One canonical definition per namespace.** Rejected because release-local
  Lenses must remain partial, overlapping interpretations of schema-opaque data.
- **An independent Lens ID.** Rejected because identity would imply conflicts or
  authority that a Lens does not possess. Installation provenance may identify
  an artifact without entering data addresses.
