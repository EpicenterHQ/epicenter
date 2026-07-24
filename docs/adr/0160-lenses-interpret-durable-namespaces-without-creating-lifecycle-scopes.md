# 0160. Lenses interpret durable namespaces without creating lifecycle scopes

- **Status:** Proposed
- **Date:** 2026-07-20 (revised 2026-07-21: one kindless record address, one
  `collections` map, and the record as the durable platform noun; revised
  2026-07-22: single-Lens `bind`)
- **Supersedes:** [ADR-0156](0156-applications-bring-workspace-lenses-runtimes-own-workspaces-by-id.md), [ADR-0130](0130-workspace-definitions-expose-tables-with-row-owned-documents-and-a-release-local-kv-lens.md), and [ADR-0158](0158-installed-apps-declare-workspace-ids-but-run-no-bun-modules.md)
- **Amended by:** [ADR-0168](0168-lenses-are-complete-pure-json-interpretations.md) (the pure JSON Lens grammar)
- **Relates:** [ADR-0163](0163-scalar-sync-separates-fact-reads-from-numbered-intent-submissions.md), [ADR-0177](0177-replica-and-authority-owners-use-role-specific-wide-record-relations.md)

## Context

Workspace and Database are not user-visible lifecycle boundaries. One person
owns one Epicenter, but independently authored applications still need stable,
collision-resistant addresses and release-local typed interpretations. A flat
globally qualified key hides the useful hierarchy between a publisher or domain
and its local collection name. A namespace can expose that hierarchy without
becoming another database, synchronization stream, or lifecycle owner.

Earlier drafts split addresses into row and value species with a durable
`kind` discriminator. That split leaked an application interpretation into
every durable address, wire shape, and storage relation, and it forced eight
kinded wire shapes where one suffices.

## Decision

The durable platform noun is the **record**: Epicenter's independently
convergent unit, one durable address with scalar state that latently owns zero
or one document and zero or one blob slot. Every record has one structured
address:

```ts
type RecordAddress = {
  namespace: string;
  collection: string;
  recordKey: string;
};
```

There is no durable or wire address kind. How applications interpret a
collection's records is Lens vocabulary: a table collection presents records
as rows, and a values collection presents records as named values. `notes/abc`
and `settings/theme` are both records durably; the Lens determines how
applications operate on them.

Applications describe a partial interpretation of one namespace with a Lens:

```ts
const whispering = defineLens({
  namespace: "so.epicenter.whispering",
  title: "Whispering",
  description: "Recordings and transcription settings.",

  collections: {
    recordings: defineTable({
      title: "Recordings",
      fields: {
        transcript: field.string(),
        createdAt: field.instant(),
      },
      optional: [],
    }),
    settings: defineValues({
      title: "Settings",
      values: {
        language: field.string(),
      },
    }),
  },
});
```

`namespace` is the durable namespace key. The property names under
`collections` are the durable local collection keys, and one namespace has one
collection keyspace: two collections in one namespace never share a local key,
regardless of kind. Inside a values collection, the property names under
`values` are the durable record keys. These names are not ergonomic aliases and
are not copied into redundant `key` properties. Renaming `recordings`, moving
it to another namespace, or changing the namespace addresses different data.

A Lens interprets exactly one namespace, but it may describe only part of that
namespace. Multiple installed Lenses may interpret the same namespace and the
same addresses. None is canonical or authoritative. Independently installed
applications that disagree about a collection's kind are tolerated, because
storage carries no kind to corrupt: each writer harms at most its own payloads,
and Epicenter Home classifies the disagreement. `bind` accepts exactly one
Lens, inside which every collection carries exactly one kind; an application
that needs several namespaces binds several Lenses, and the variables it binds
them to are ergonomic only.

There is no independent Lens ID. The noun Lens is intentional: this is a
partial, overlapping, release-local interpretation, not a complete schema or a
durable owner. Binding a Lens borrows typed access to an open `Epicenter`. It
creates no storage, performs no synchronization, and owns no disposal.

Table collections mint globally unique 24-character record keys that callers
cannot replace or reuse; values collections declare their record keys in the
Lens. Every record latently owns exactly one schema-free document and one
zero-or-one write-once immutable blob slot at the record's own address,
whether or not any Lens exposes those capabilities. Neither capability has an
independent public ID, Lens declaration, or lifetime. Only terminal deletion
(tombstone), through any Lens or synchronization, revokes open handles and
terminally deletes the record's document and blob state; reversible absence
(unset) does not. ADR-0173 and ADR-0174 own the blob and document lifecycle
laws this sentence summarizes.

Namespace keys structure durable addresses only. Every replica still stores
and synchronizes the complete Epicenter. No operation may open, own, attach,
replicate, synchronize, settle, export or import a portable Epicenter, delete or
clear as a lifecycle, transact, authorize, encrypt, retain, back up, or assign a
physical file to one namespace independently. Namespace-filtered reads and
inspection are allowed. An application-specific clear operation is an ordinary
series of per-record deletes and carries no atomic namespace semantics.

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
- Storage, the wire, and artifacts need no kind column, kind-split relations,
  or kinded shape unions; the table-versus-values distinction appears exactly
  once, in Lens collection definitions.
- Rows and values remain honest application vocabulary without becoming
  address species.
- Whole-Epicenter lifecycle and synchronization remain explicit invariants,
  rather than conventions that namespaces could gradually erode.

## Considered alternatives

- **One flat globally qualified string per collection.** Rejected because it
  hides address structure, requires prefix parsing for inspection, and repeats
  the namespace in every declaration.
- **Row and value address species with a durable `kind`.** Rejected because the
  kind is Lens interpretation, not address identity: it doubled every wire
  shape, forced kind-split storage and artifact relations, and gave the
  authority a branch it has no business taking. Its one convenience, reusing a
  local name for a table and a value, is not worth a second address species;
  one collection keyspace per namespace keeps names unambiguous.
- **Namespace as a database, workspace, application owner, or synchronization
  scope.** Rejected because it recreates the lifecycle boundaries removed by
  One Epicenter.
- **One canonical definition per namespace.** Rejected because release-local
  Lenses must remain partial, overlapping interpretations of schema-opaque data.
- **An independent Lens ID.** Rejected because identity would imply conflicts or
  authority that a Lens does not possess. Installation provenance may identify
  an artifact without entering data addresses.
- **`object` or `entry` as the platform noun.** Rejected as vaguer than
  `record`, which already names one addressed, independently convergent unit
  in ordinary database vocabulary without implying a schema.
