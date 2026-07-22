# One Epicenter, namespaces, and Lenses

This is the explanatory map for the greenfield One-Epicenter destination. The
record path is implemented through the W4 caller cutover and deletion; snapshot
capture, portable Backup and Restore, and Proposal remain active waves. Durable
decisions live in ADR-0160 through ADR-0177, each with its own current status.
The active replacement plan lives in
[`specs/20260720T002337-epicenter-data-clean-break.md`](../../specs/20260720T002337-epicenter-data-clean-break.md).

The whole system in one sentence:

> Epicenter durably synchronizes records addressed by namespace, collection,
> and record key; Lenses present those records as rows or values, Home captures
> point-in-time SQL artifacts, and only ordinary typed writes or Restore can
> change the live Epicenter.

## The system

```txt
typed applications ──► Lenses ──► live replica owner ──► authority
                                        │ ├── documents (bounded Yjs chains)
                                        │ └── blobs (raw immutable files)
                                        │
Home typed live surfaces ───────────────┤   (table browser, status, parked work)
Home capture ───────────────────────────┴─► inspection snapshot ──► ad hoc SQL
Backup capture (authority) ───────────────► portable Backup ──────► Restore
future Proposal (prototype-gated) ────────► reviewed semantic writes ──► live replica
```

One principal owns one Epicenter: one logical body of records, replicated
whole on every adapter boundary. Applications bring Lenses over portions of
it. Whispering, Honeycrisp, Skills, Chat, and Home do not each own a database
or synchronization stream. A Lens can disappear while the data it interpreted
remains.

## Records and addresses

The durable platform noun is the record: one durable address with scalar state
that latently owns zero or one Yjs document and zero or one immutable blob
slot.

```ts
type RecordAddress = {
  namespace: string;
  collection: string;
  recordKey: string;
};
```

There is no address kind. `notes/abc123` and `settings/theme` are both records
durably; the Lens determines how applications interpret and operate on them. A
table collection presents records as rows with runtime-minted keys; a values
collection presents records as named values with declared keys. Rows and
values are application vocabulary, not address species, wire shapes, or
storage families.

The logical hierarchy is honest and inspectable:

```txt
one Epicenter
├── namespace: so.epicenter.whispering
│   ├── collection: recordings   (a Lens interprets this as a table)
│   │   ├── record: mfyq...x2 (24-char minted key)
│   │   └── record: k3nd...9a
│   └── collection: settings     (a Lens interprets this as values)
│       ├── record: language
│       └── record: theme
└── namespace: so.epicenter.honeycrisp
    └── collection: notes
```

## A Lens is pure JSON

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

`namespace` is a durable address coordinate. `collections.recordings` and
`settings.values.language` are durable local keys, and one namespace has one
collection keyspace. They are not aliases: renaming a property or moving it to
another namespace addresses different data.

A Lens interprets exactly one namespace but may describe only part of it.
Multiple Lenses may overlap on the same namespace and address, and none is
canonical. There is no independent Lens ID. An application binds multiple
Lenses when it needs multiple namespaces; only the outer binding names are
ergonomic aliases.

The complete Lens is ordinary JSON. Authoring helpers preserve TypeScript
inference while returning that canonical JSON shape. `parseLens(unknown)` is
the one runtime validity boundary for downloaded artifacts. Validators are
derived ephemeral functions, not persisted Lens state.

Application verbs stay ergonomic and never leak the wire:

```txt
tables:  create / get / update / delete / scan / entries / subscribe
         openDocument / blob
values:  get / set / unset / subscribe
```

Reads are classified: conforming records return typed values, nonconforming
records return diagnostics with their preserved raw JSON, and unknown fields
ride along untouched through any Lens's writes.

## The namespace refusal

The invariant is stronger than the hierarchy:

> Namespace keys structure durable data addresses only. Every replica still
> stores and synchronizes the complete Epicenter, and no operation may open,
> settle, export, delete, transact, or replicate one namespace independently.

A namespace is not a database, workspace, synchronization scope, deletion
scope, transaction scope, permission boundary, encryption key, retention rule,
backup unit, quota, or physical file. Namespace-filtered reads and inspection
are useful and allowed. An application-specific clear action is a series of
ordinary per-record deletes, not an atomic namespace lifecycle.

## One wire, four operations, three lanes

Each record converges independently. A local write becomes durable and
available offline before synchronization, and Epicenter refuses to become a
distributed transactional database: facts that must change together belong in
one record, merge-sensitive content belongs in that record's document, and a
true cross-record invariant belongs in an application-specific authority.

The wire (ADR-0163) has one fact shape, `{ address, sequence, state,
payload? }`, and four discriminated operations:

```txt
patch       make or keep present by folding set/unset fields
replace     make or keep present by replacing the complete value
tombstone   terminal absence within one authority lifetime
unset       reversible absence
```

Tombstone absorption is evaluated first, so a deleted record cannot be
resurrected, even by independently installed Lenses that disagree about a
collection.

A replica record carries three crash lanes plus one overlay: `confirmed` (the
latest authority truth learned locally), `sealed` (the immutable in-flight
desire, with its exact canonical request bytes persisted for retry), and
`pending` (the mutable compacted current desire), plus `parked`, which retains
a refused operation as a visible, non-retrying overlay until a later write
consumes it. ADR-0177 owns physical layout by semantic role. Authorities use
the wide interned record row. Replicas target split confirmed-fact and sparse
intent relations behind a complete production acceptance charter; relation
shape remains private to the store owner.

## Inspection is capture

Applications receive no SQL, ever. Epicenter Home owns relational inspection
for people and agents, and inspection means capture (ADR-0162): the store
owner produces a point-in-time inspection snapshot, an inert SQLite artifact,
and Home queries that file in its own context. Nothing runs SQL on the live
connection; there is no inspection session, TEMP view, or busy refusal. Live
jobs (table browsing, sync status, parked work) use typed owner surfaces.

Every inert artifact self-identifies through its `_epicenter_artifact`
metadata row, and its lossless raw relation is `_epicenter_records`, one
kindless relation, because storage does not know which records are rows and
which are values. Three artifact kinds have distinct promises, and none is
ever accepted as another:

```txt
inspection snapshot   point-in-time query artifact; scalar visible state plus
                      document/blob metadata; never applyable

Proposal              source-bound editable artifact; compiles reviewed
                      semantic changes into ordinary local typed writes; ends
                      after local admission (prototype-gated, no ADR yet)

portable Backup       complete custody artifact: records, self-contained
                      composed V2 documents, and every owned blob byte at one
                      authority cut; Restore creates a fresh authority lifetime
```

Selected Lens views inside a snapshot are persisted SQL views over
`_epicenter_records`, so `recordings` or `notes` can be queried without JSON
extraction while the raw relation stays the one truth in the file.

## Documents, blobs, Backup, and Restore

Every record latently owns zero or one document and zero or one blob slot;
typed APIs expose them where the Lens makes them meaningful. Only terminal
tombstone reaps those capabilities; reversible unset does not. Live documents
are bounded Yjs baseline-plus-tail chains in SQLite (ADR-0174); blob bytes are
raw immutable files published through a staged write order with idempotent
debris sweeps (ADR-0172, ADR-0173).

A portable Backup owns a consistent authority cut with a durable pin manifest
and the pin/copy/verify/seal blob sequence (ADR-0167, ADR-0170). Restore
validates only a portable artifact, constructs a successor authority with a
fresh lifetime, and never emits ordinary intents; superseded replicas erase
and reacquire.

## Still open

1. Whether app-bundled Lenses live only with the active app catalog or whether
   standalone installed Lenses have a separate discovery folder and lifecycle.
2. The exact pure JSON table metadata shape and typed reference-navigation
   ergonomics for the non-enforcing record references settled by ADR-0169.
3. The realtime row-document topology for the live-collaboration overlay.
4. The physical layout charters of ADR-0177 (wide versus split hot paths,
   Durable Object billing, physical browser OPFS capacity and reopen); their
   outcome can swap the store schema without touching any public contract.
5. The Proposal prototype (nine bounded tests); its ADR and product build wait
   for that proof.
