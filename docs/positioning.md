# Positioning

This document owns Epicenter's public claims and the rules for deriving copy
from them. Finished copy belongs to the surface that ships it: the README,
landing page, package metadata, or a launch plan.

## The destination

One person has one Epicenter: one local-first body of records replicated in
full across their browser, desktop, and trusted server boundaries. Purpose-built
applications contribute Lenses that interpret durable namespaces as typed
tables and values. A Lens does not create another database, synchronization
scope, identity, or lifecycle.

Every record has bounded scalar JSON and may own one collaborative document
and one immutable blob. Ordinary typed writes are the only application path to
live data. Epicenter Home owns inspection, status, parked work, Backup, Restore,
and reviewed agent changes. SQL runs only against inert point-in-time artifacts,
never against the live store.

The product is personal infrastructure, not a general multi-tenant database.
Complete replicas, record-independent convergence, permanent tombstones within
one authority lifetime, and an app-blind trusted authority pay for a small and
explainable system.

## The spine

One line, for link cards and short descriptions:

> Local-first apps over one body of data you control.

The hero cut:

> **One local-first Epicenter for every app you trust.** Your apps share a
> complete record replica on your devices. Lenses give each app typed tables,
> values, documents, and blobs without creating another data silo.

The thirty-second cut:

> Most apps create another private database. Epicenter keeps one complete
> local record universe and lets purpose-built apps interpret it through typed
> Lenses. Writes work offline, synchronization catches up automatically, and
> inspection happens through inert SQLite snapshots rather than a second live
> data path. Start with Whispering in the browser or inside the Epicenter
> desktop host.

The developer cut:

> A local-first record engine for TypeScript apps: pure JSON Lenses over
> complete replicas, bounded Yjs documents, and immutable blobs.

The public cut:

> Your apps should work together without pooling their data in somebody else's
> cloud. Epicenter keeps a complete local copy on your devices and gives every
> app one typed path into the same personal data.

No shorter cut may promise something a longer cut withdraws. If a new surface
needs a claim the spine does not support, fix the spine first.

## The hook

Whispering can capture a transcript, Honeycrisp can turn it into a note, and
Home can inspect both without either app owning the other's database. Their
Lenses name different namespaces inside the same Epicenter. Records synchronize
as one complete personal replica; documents and blobs follow the lifecycle of
the record that owns them.

Home is the custody and inspection surface. It browses live data through typed
operations, captures a point-in-time SQLite artifact for ad hoc queries, and
creates a portable Backup for Restore. A snapshot is deliberately stale and
never applyable. A Backup is complete and may replace the live authority only
through Restore. A reviewed Proposal ends after compiling to ordinary typed
writes.

Trust follows topology. Hosted Epicenter can read synchronized records,
documents, and blobs. Self-hosting moves the authority onto infrastructure you
operate. Local-only use sends no data to an authority. This is a direct trust
choice, not client-side encryption disguised as one.

## Proof line

Every shipped public surface longer than one line names Whispering and shows
how to run it: as a browser speech-to-text app or as a native surface inside
Epicenter. Platform claims must match the release artifacts that exist at the
time the copy ships.

Roadmap language stays out of the hero. A surface may describe unfinished Home
or Backup work in a status section, but it must not imply that a planned
capability is already available.

## Earned vocabulary

Use internal nouns only after the reader has seen the thing they name.

| Term | Earned by |
| --- | --- |
| Epicenter | explaining the one complete personal record universe |
| Lens | showing an app's pure namespace and collection definition |
| record | showing `{ namespace, collection, recordKey }` |
| authority | explaining the trusted owner that orders synchronized facts |
| snapshot | showing a captured, inert SQLite query artifact |
| Backup | distinguishing the complete portable artifact from a snapshot |
| Proposal | showing reviewed changes that compile to ordinary typed writes |

Do not use `workspace` as the data-platform noun. It may still mean an ordinary
development folder or user-facing layout where that local meaning is explicit.
Do not revive `database`, `mount`, `daemon`, or `materializer` as synonyms for
the Epicenter record path.

Avoid hype words such as `AI-native`, `agentic`, `next-gen`, `revolutionary`,
or `game changer`. State the capability and the refusal that makes it credible.

## What Epicenter is

- An open-source local-first personal data platform.
- A desktop host and Home surface for trusted application capabilities.
- A TypeScript toolkit, led by `@epicenter/data`, for typed Lenses over records,
  documents, and blobs.
- One shared server library with hosted and self-hosted deployment seams.

## What Epicenter is not

- Not a per-app database catalog: applications share one complete replica.
- Not a general collaborative database: there is no partial replication,
  record-level permission system, or cross-record transaction.
- Not a live SQL server: Home queries inert capture artifacts only.
- Not zero-knowledge hosting: the authority operator can read synchronized
  content.
- Not a compatibility shell for the deleted Workspace API.

## Core claims

Every public claim must be provable from the repository.

| Claim | Proof |
| --- | --- |
| Local-first writes | Replica stores durably admit writes before remote settlement and retain exact retry obligations. |
| One complete replica | Namespaces are interpretation boundaries, never synchronization or physical storage scopes. |
| Typed applications | `defineLens`, `defineTable`, and `defineValues` bind release-local schemas to durable record addresses. |
| Collaborative content | A record may own one bounded Yjs document with durable publication state. |
| Immutable media | A record may own one write-once blob whose bytes are stored and published separately from scalar JSON. |
| Trusted sync | Hosted and self-hosted authorities share record semantics and differ in principal resolution and operator. |
| Inert inspection | Home capture creates a self-identifying SQLite artifact and receives no live SQL handle. |
| Portable custody | Backup captures one complete authority cut and Restore creates a fresh lifetime. |

If a proof has not landed, copy must describe it as direction rather than
shipped behavior.

## Competitive frame

Against cloud-first suites, Epicenter wins on complete local ownership and an
open implementation; it loses on mature collaboration and distribution.

Against file-first tools such as Obsidian or Logseq, Epicenter provides typed
records, automatic synchronization obligations, documents, and blobs; it loses
the radical simplicity and ecosystem of plain files.

Against local-first databases such as Jazz, Epicenter chooses a much narrower
personal scope: one complete replica, no row permissions, and no partial sync.
Jazz is the better fit for a large multi-user application database. Epicenter
is the fit when several trusted personal apps should share one coherent local
universe.

Against encrypted note products, Epicenter offers a broader app platform but a
more explicit trust cost. Hosted authorities are trusted with content;
self-hosting is the privacy topology.

## Package copy

Each package's `package.json` owns its npm description and keywords. Public
packages derive from the relevant user cut; `@epicenter/data` derives from the
developer cut. Descriptions lead with what the package does, not its category.

Revisit this document when a shipped surface needs a claim not represented by
the spine, or when package descriptions drift away from it.
