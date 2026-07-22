# Epicenter architecture

Epicenter is one local-first body of records replicated across runtime
boundaries. Applications contribute pure Lenses that interpret those records;
they do not create independent databases, synchronization scopes, or durable
lifecycles.

This page is the five-minute repository map. Durable decisions live in
[`docs/adr`](adr/README.md), shared vocabulary lives in
[`docs/CONTEXT.md`](CONTEXT.md), and the complete data model lives in
[`One Epicenter, namespaces, and Lenses`](architecture/one-epicenter-namespaces-and-lenses.md).

## The data path

```text
Whispering Lens ─┐
Honeycrisp Lens ─┼─> one local replica owner ─> one principal authority
Home Lens ───────┘          |                         |
                            |                         +-- ordered record facts
                            +-- scalar records        +-- document publication
                            +-- Yjs documents         `-- blob publication
                            `-- immutable blobs
```

`@epicenter/data` owns the record protocol, local replica state machines,
runtime owners, and the pure Lens API. `@epicenter/field` supplies
release-local validation and projection vocabulary. `@epicenter/document-sync`
and `@epicenter/sync` own row-document publication and realtime Yjs transport.
`@epicenter/sqlite` is a domain-free adapter; consuming owners define schemas
and transactions.

Every durable record is addressed by `{ namespace, collection, recordKey }`.
A Lens presents selected records as typed tables or values. Each record may
also own one bounded Yjs document and one write-once immutable blob. Only a
terminal tombstone reaps those capabilities.

Replicas store complete Epicenters. Namespace-filtered reads are useful, but a
namespace is never a database, synchronization unit, deletion scope,
transaction, permission boundary, backup unit, or physical file.

## Runtime owners

Each adapter boundary has one owner for the complete local replica:

- browser pages coordinate behind one elected dedicated Worker, Web Lock, and
  OPFS SQLite owner;
- Epicenter desktop owns one Bun SQLite replica and raw blob directory, and
  trusted WebViews use a narrow record protocol;
- Bun applications open the same record store directly;
- hosted and self-hosted deployments expose the same authority contracts with
  different principal resolvers.

Applications bind Lenses to an existing owner. They never open another
physical store just because they interpret another namespace.

## Inspection and custody

Applications receive no SQL connection to live data. Epicenter Home requests
a point-in-time inspection artifact from the store owner and queries that inert
SQLite file separately. Snapshot capture cannot mutate the live replica.

A portable Backup is a different artifact: one complete authority cut of
record facts, self-contained document cells, and every owned blob byte.
Restore validates only that portable kind and creates a fresh authority
lifetime. Inspection snapshots, Proposals, and Backups never impersonate one
another.

## Applications and the desktop host

Whispering remains an independently hostable browser SPA. Epicenter is the
only Tauri shell and serves trusted surfaces, including Whispering, through one
loopback host. Native capabilities, credentials, recording capture files, and
the desktop record owner stay in the host; application UI receives only the
narrow capability it needs.

Home composes application verbs in process and owns approval, chat, and
inspection surfaces. A verb can operate on typed Lens data without granting an
application raw replica access or SQL.

## Server composition

One shared Hono library has two deployables:

```text
packages/server
  shared record, document, blob, session, and application routes
       |
       +-- apps/api
       |     hosted personal cloud: OAuth, billing, many principals
       |
       `-- apps/self-host
             community-operated single partition: one instance bearer
```

Hosted-only billing remains in `apps/api/worker/billing`. Self-host never
imports it. Both deployables use the same authority semantics; their principal
resolvers and operating responsibilities differ.

## Trust boundary

Hosted Epicenter is trusted infrastructure. The authority can read scalar
facts, document updates, and blob bytes. Self-hosting moves that authority onto
infrastructure the user operates; it does not add a client-side encryption
layer. See the [trust model](trust-model.md) for the full consequence map.

## Package map

| Package | Responsibility |
| --- | --- |
| `@epicenter/data` | Record protocol, replicas, authorities, Lenses, documents, blobs, and runtime owners |
| `@epicenter/document-sync` | Bounded row-document publication and realtime coordination |
| `@epicenter/sync` | Yjs wire and provider vocabulary |
| `@epicenter/field` | Runtime field recognition and projection schemas |
| `@epicenter/sqlite` | Domain-free embedded SQLite adapter contract |
| `@epicenter/agent` | UI-free agent loop and tool-catalog composition |
| `@epicenter/server` | Shared Hono server library for hosted and self-hosted deployments |

The old root-Yjs Workspace package and its compatibility API are deleted. Git
retains their history; current applications have one record path.
