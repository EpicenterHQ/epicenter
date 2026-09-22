# 0419. Stores open for explicit owners and compose live projections

- **Status:** Proposed
- **Date:** 2026-09-21
- **Implemented portion (2026-09-22):** `openLocal` and `openPersonal` independently own their documents. Blobs still open separately; store-owned blobs remain unbuilt. Local uses the existing no-account address; Personal captures one account.
- **Unbuilt:** Store-owned blobs and cleanup, Shared opening, space membership and synchronization, store-first persistence addresses, native document persistence, and live SQLite projections. Those examples below remain proposals, not exports. Product migration is deferred.
- **Amends:** [ADR-0406](0406-one-application-schema-is-used-by-every-store.md) at mandatory schema reuse: each opener receives its own definition; applications may reuse a schema or choose different schemas for different workflows.

## Context

Whispering needs device-local recordings and preferences alongside deliberately
saved personal or shared material. Honeycrisp can use the same note schema for
local and synchronized notes. Neither product needs an implicit destination
chosen by whether someone is signed in.

At proposal time, `packages/app/src/open.ts` opened an App with device and personal
stores sharing one definition and lifetime. Device storage was account-partitioned.
`packages/app/src/platform/documents.ts` persists documents in IndexedDB in both
the browser and desktop WebView. Native SQLite and blob capabilities already
exist separately. This record changes that model; it does not describe a shipped
filesystem layout.

## Decision

**A store opens one definition for one explicit owner.**

A definition contains a stable lowercase reverse-DNS `id`, tables, and KV.
For example, `so.epicenter.whispering.recordings` names the recordings store.
The ID is not an access grant, display label, or schema-version number. Changing
it changes the persistent address. A separate application ID is not repeated in
store-opening calls; host application identity still exists for installation
and capability authorization.

```ts
const local = await openLocal(recordingsDefinition);
const personal = await openPersonal(recordingsDefinition, { account });
const shared = await openShared(recordingsDefinition, { account, spaceId });

local.tables.recordings;
personal.kv;
local.blobs;
personal.blobs;
shared.blobs; // Future API, pending shared-owner authorization.

const localSql = await projectSqlite(local);
await localSql.close(); // Local remains usable.
await local.close();
```

Every opened store owns `tables`, `kv`, and `blobs`. Its definition ID selects
the blob namespace; its captured owner selects device-local, personal remote,
or future shared remote access. [ADR-0372](0372-local-and-remote-blobs-open-independently.md)
owns the blob operations and store cleanup contract. Bytes remain outside the
Yjs document and are transferred explicitly.

Definitions may be identical or different across openings. A Local recording
schema can keep an audio BlobId while a Personal schema stores only a transcript
or deliberately published material. The framework neither requires that local
reference in Personal nor strips it automatically. Reusing a definition retains
the same declared fields; different shapes require explicit definitions and
product mapping. Different local
stores have different definition IDs. The same complete address reopens the
same data; minting another handle never implicitly creates a new dataset.
Each local replica has one running persistence owner. Duplicate windows or
handles must not create competing owners. Agent commands route to that owner;
scripts do not open a second replica or the authoritative database directly.
The standalone Local and Personal openers refuse duplicate acquisition. Agent
routing to an existing owner remains to be designed.

Local belongs to this device and does not change on sign-in or account switch.
Personal belongs to the specified account. Shared belongs to the specified
shared owner. Each owner has at most one document per definition. Independent
projects within a store are rows; different membership boundaries use different
shared owners. This does not introduce a generic collection-instance ID.

**A space names the shared owner; a store names the developer data unit.**

Space is the naming recommendation, pending product wording review. A space can
represent a family, podcast team, or company and own stores from several apps.
It is not an additional layer beneath an organization. No organization-to-space
hierarchy is introduced. Interfaces normally show the person's chosen name,
such as “Wong Family,” and use product nouns such as notes or recordings.

The public opener remains `openShared`. Durable addresses use `shared/<id>`,
not `organizations/<id>` or `spaces/<id>`, so a later wording change does not
rename persisted data. `spaceId` selects a destination; the server must authorize
access. Membership grants cannot be ordinary client-mergeable store data.
Invitations, roles, revocation, and the treatment of pending edits after access
loss require a separate decision before Shared ships.

**Each store has an independent lifetime and a fixed identity.**

Account retirement ends Personal network authority but does not itself close
the cached store. Product departure owns its closure or replacement. Preserve
pending edits; sign-out and outages are not document-generation invalidation.

Opening Personal or Shared is optional. Closing one store does not close its
siblings. Account changes never retarget an existing handle. No mandatory
`createRuntime` object is introduced merely to carry an ID or collect closers.
Platform services may share engines and transports without sharing data owners.
Independent acquisition does not remove explicit dependencies: a source store
closes its projections and blobs, and its local blob destination retires
dependent recorders. Closing one store never closes a sibling store.

Agent access follows the field-only working-copy Push contract. Pull, live-store
queries, and Push require the running owner; existing files remain editable
while it is stopped. Independent application store handles do not grant
independent agent persistence ownership. Session replacement ends live handles
without changing the identity of device-local data.

**Persistence is store-first and distinguishes remote identity from local replica identity.**

```text
Remote Personal: server + account + definition ID
Remote Shared:   server + shared owner + definition ID
Local replica:  includes the accessing account for both remote kinds
```

Two members synchronize the same remote shared store but retain separate local
replicas and pending edits. Alice's unsent edits must not be submitted under
Bob's identity. Address encoding must be unambiguous, filesystem-safe, and
consistent across the opener, persistence, exclusion, and projection layers.

Native persistence is a separate storage target, not a prerequisite for agent
access. A running owner can expose Pull and Push over IndexedDB-backed state.
Do not couple the first working-copy implementation to native migration.

The target desktop layout is beneath Epicenter's OS application-data root:

```text
<application-data>/so.epicenter/
  stores/
    so.epicenter.whispering.recordings/
      local/
        state.sqlite
        derived/query.sqlite             optional
      accounts/<server>/<account>/
        personal/
          state.sqlite
          derived/query.sqlite           optional
        shared/<shared-owner>/
          state.sqlite
          derived/query.sqlite           optional
```

On macOS the default root is `~/Library/Application Support/so.epicenter`.
The platform selects its corresponding application-data location elsewhere;
an explicit root override remains possible. A user-visible working-copy folder
is a separate capability, not a second authoritative persistence root.

In the browser the same logical destinations name separate IndexedDB databases:

```text
epicenter/stores/<definition-id>/local
epicenter/stores/<definition-id>/accounts/<server>/<account>/personal
epicenter/stores/<definition-id>/accounts/<server>/<account>/shared/<shared-owner>
```

These are flat names, not directories. Each store acquires its blob namespace
with the document and owns both lifetimes. This public ownership change does
not move existing blob paths into the proposed store-first layout; those paths
remain as recorded in ADR-0426 until a separate migration is designed.
Browser persistence need not reproduce native filesystem
formats. Browser SQL can run in memory; persisted projections need a suitable
browser backing such as OPFS, not a claim that IndexedDB is a SQLite file.

**Source data survives projection disposal.**

`state.sqlite` holds durable Yjs updates, including pending synchronization work.
It is not automatically a relational representation of application tables.
Audio bytes belong to the explicit blob destination. Neither becomes disposable merely because the
store synchronizes: the only copy of an offline recording may still be local.

`projectSqlite(store)` builds and maintains a read-only relational projection.
It resolves after initial materialization, follows source changes, and owns its
subscriptions and query resources. Query freshness must be specified and tested
before implementation; the intended contract includes source changes completed
before a query begins. Projection failure does not retire the source store.
Closing the source closes its dependent live projections.

The application may expose a raw SQL console through the read-only query
interface. Agents may query the same interface, but need not: files suffice for
reading and selection. Live SQL is optional and never an agent write path.

Working copies use Markdown table folders, root `kv.json`, and an authored
`epicenter.config.ts` read lens under ADR-0420. Matter supplies shared YAML
parsing; its checkout UI and indexing integration remain unbuilt. The running
Epicenter owner owns destination checks and permitted-field Push. Config changes
do not change that destination or grant writes. Standalone Matter retains its
own format and does not become a synchronized store.

An optional read-only index beside a working copy supports SQL selection of
Markdown paths. It indexes the working files through a stated refresh point;
a Pull-time snapshot is not automatically current after file edits. It is
separate from the live store projection and never participates in Push. Both
SQL surfaces are derived and disposable. Markdown plus `kv.json` remain the
only agent authoring format; editable SQLite and SQL write-back are refused.

Memory is the projection default. A requested persistent projection belongs in
that replica's `derived/query.sqlite` and records enough source progress and
projection-version information to detect staleness and rebuild. A remaining file
does not imply a running follower. Deleting `derived/` loses no user data.
Deleting source state or audio may. SQL writes do not flow back into Yjs.

**Copying between stores creates independent destination data.**

A product that promises a complete recording copy must explicitly make its
referenced audio available to the destination. Copying transcript-only rows
does not upload or share private audio. The store engine copies no payloads
implicitly. Move is a
successful copy followed by source deletion, not an atomic transaction across
documents. Initial storage does not require global blob deduplication or
cross-owner reference counting.

## Consequences

Applications compose only the handles they need. Same-schema editors can accept
a concrete store; mixed-ownership applications name both stores explicitly.
Store-first paths make a definition's replicas discoverable. Account-wide local
removal must enumerate store directories rather than delete one account root.
Directory order itself provides no authorization boundary.

Agent access needs store discovery and a supported query or mutation surface.
Readable paths alone do not make a Yjs log editable. A query tool can use a live
projection or build one from a consistent source snapshot. External readers of
a persistent projection must account for freshness. Mutations use store
operations inside the application; agent mutations go through working-copy
Push. Neither writes through the derived database.

The new openers and layout require changes to admission, native persistence,
and migration. Existing bytes must not be silently orphaned, adopted under a
different account, or deleted. Migration is not specified or authorized by this
record. Shared authorization remains unbuilt.

The legacy server-wide Shared removal remains independent of future spaces.
Generation removal preserves current addresses; a later store-first migration
is separate and preserves lineage and pending work. File Push submits ordinary
field edits to that same document. Live SQL follows it without a write-back path.

Proceed with owner routing and field-only Pull/Push, including crash recovery.
Native storage migration, live SQL, and space membership are independent work,
not prerequisites bundled into agent access.

## Considered alternatives

- `center` or `epicenter` for a store: overlaps the product name and says little
  about tables, KV, persistence, or lifetime.
- `organization` for every shared owner: implies an institution where a family
  or small collaboration suffices. Separate organizations are not introduced
  without a concrete administration requirement.
- Owner-first directories: simplify account-wide removal but scatter one
  definition's replicas. Store-first favors inspection and store maintenance.
- One global SQL projection: couples ownership, cleanup, and source lifetimes.
- Persistent projections by default: create files that go stale after close
  even when the application only needs in-process queries.
- A required runtime with every store attached: imposes another lifecycle
  before a shared resource has earned that boundary.

## Verification required before implementation lands

- Local data stays the same across sign-in, sign-out, and account switch.
- Same-definition Local, Personal, and Shared addresses never collide.
- A member never inherits another member's pending shared edits.
- Closing a projection preserves its source; closing a source ends followers.
- Store close fences both document and blob access, releases playback, retires
  dependent recorders, and drains admitted publication without deleting bytes.
- Removing derived state preserves recordings and allows projection rebuild.
- Duplicate acquisition, partial-open failure, and account-wide removal have
  explicit tested behavior across browser and native owners.
- Copy failure never triggers source deletion or leaves destination audio
  references presented as successfully available.
