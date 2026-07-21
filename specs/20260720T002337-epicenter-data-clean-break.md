# Epicenter data clean break

- **Status:** In Progress
- **Date:** 2026-07-20
- **Program:** greenfield breaking replacement
- **Decision owners:** [ADR-0160](../docs/adr/0160-lenses-interpret-durable-namespaces-without-creating-lifecycle-scopes.md), [ADR-0161](../docs/adr/0161-each-person-has-one-epicenter-replicated-on-each-adapter-boundary.md), [ADR-0162](../docs/adr/0162-epicenter-home-owns-relational-inspection-applications-receive-no-sql.md), [ADR-0163](../docs/adr/0163-scalar-sync-separates-fact-reads-from-numbered-intent-submissions.md), [ADR-0164](../docs/adr/0164-scalar-facts-converge-independently-epicenter-refuses-distributed-transactions.md), [ADR-0165](../docs/adr/0165-browser-origins-contain-independent-epicenter-replicas.md), [ADR-0166](../docs/adr/0166-data-document-sync-and-agent-replace-workspace.md), [ADR-0167](../docs/adr/0167-a-portable-epicenter-is-an-identity-free-export-of-one-authority-cut.md), [ADR-0168](../docs/adr/0168-lenses-are-complete-pure-json-interpretations.md), [ADR-0169](../docs/adr/0169-row-references-are-non-enforcing-table-interpretations.md), [ADR-0170](../docs/adr/0170-one-live-epicenter-has-sealed-backups-and-restore-creates-a-fresh-authority-lifetime.md), [ADR-0171](../docs/adr/0171-every-durable-local-write-leaves-an-automatic-authority-obligation.md), [ADR-0172](../docs/adr/0172-sqlite-stores-convergent-facts-and-documents-raw-files-store-blob-bytes.md), [ADR-0173](../docs/adr/0173-each-row-owns-at-most-one-write-once-immutable-blob.md), [ADR-0174](../docs/adr/0174-row-documents-project-as-nullable-compact-cells-and-persist-as-bounded-live-chains.md), [ADR-0175](../docs/adr/0175-table-traversal-is-complete-and-classified-with-paging-kept-private.md), and [ADR-0176](../docs/adr/0176-lenses-declare-no-query-capabilities-indexed-reads-require-separate-owners.md)

## Product sentence

Epicenter persists and synchronizes one person's values and row aggregates.
Every row owns scalar fields, zero or one persisted collaborative document, and
zero or one write-once immutable blob; applications bind pure JSON Lenses over
durable namespaces in that shared data.

## Accepted premises

- There is no legacy user data to preserve.
- This is intentionally a breaking change.
- Epicenter is a curated personal universe, not an ingestion lake or a
  projection store, with an expected ceiling around one million rows.
  Ingested mirrors (mail, accounting, photos, tabs) and derived projections
  keep their own disposable app-local stores outside the synchronized plane;
  admission limits, bounded facts responses, and private runtime indexes are
  sized for curated personal scale, never for bulk ingestion throughput. These
  are not application table-query capabilities.
- Every attached replica synchronizes the person's whole Epicenter.
- One person has one logical Epicenter and one server authority.
- Each adapter isolation boundary has the complete scalar address universe and
  lazily materializes remote documents and blobs.
- Namespaces structure durable addresses only. They never create storage,
  ownership, lifecycle, transaction, export, or synchronization scopes.
- Applications receive no SQL. Epicenter Home owns human and agent relational
  inspection over the logical Epicenter.
- Scalar facts converge independently. Epicenter exposes no public
  multi-address transaction and promises no atomic remote visibility across
  scalar addresses.
- Scalar sync reads current authority facts after one sequence and submits one
  replica's numbered desired-state intents. Current facts settle submissions;
  there is no combined exchange, public digest, receipt, or checkpoint.
- Row IDs are globally unique, runtime-minted, and never reused.
- Compact row tombstones are permanent synchronization facts within one
  authority lifetime.
- One person has one live Epicenter and zero or more sealed Backups. A Backup is
  inert, immutable, byte-complete, downloadable, and never synchronizable.
- Restore creates and atomically activates a fresh authority lifetime. It never
  reactivates a superseded authority lifetime or merges into the live Epicenter.
- Every locally durable scalar, document, or blob write leaves durable evidence
  of what the authority is owed. One Epicenter runtime owner drains those
  obligations automatically and applications expose no sync or publish action.
- SQLite stores scalar state, bounded Yjs baseline-plus-tail chains, and exact
  publication retry evidence. Raw files store row-owned immutable blob bytes.
  Browser SQLite itself lives in OPFS.
- Every row has one universal undeclared zero-or-one blob slot. The row address
  is its sole identity; SHA-256 is integrity and idempotency evidence. The slot
  is write-once, and incomplete capture has no permanent identity.

If any premise changes before merge, stop. Do not hide the change behind an
alias, migration bridge, optional scope, or second runtime.

## The asymmetric refusal

Product promise:

> A person's data works locally and converges across their signed-in devices.

Refused promise:

> One physical replica can switch among several principals while preserving a
> separate anonymous dataset and offering automatic merge choices.

The first sign-in permanently attaches the current local replica to one
principal and converges its existing content. Signing out pauses sync without
changing ownership. Another principal requires a fresh replica or explicit
destructive clearing.

This refusal deletes Device-versus-Account owners, profile catalogs, adoption
modes, per-owner directories, rekeying, aliases, parallel data handles, merge
choice UI, and account-switch recovery. The user loss is that switching people
inside one installation is not a seamless toggle.

Permanent row tombstones within one authority lifetime are the companion
asymmetric trade. A small durable record per row deletion deletes acknowledgment
catalogs, deletion-retention floors, baseline acquisition, stale-replica
recovery, and the possibility that an old offline replica resurrects a deleted
row. Value unset remains nonterminal: a later set may replace it. A deliberate
Restore starts a fresh lifetime from complete logical state and invalidates
every old replica; it is the only operation that leaves the old tombstones
behind.

## Public destination

```ts
export const whisperingLens = defineLens({
  namespace: "so.epicenter.whispering",
  title: "Whispering",
  description: "Recordings and transcription settings.",
  tables: {
    recordings: defineTable({
      title: "Recordings",
      fields: {
        createdAt: field.instant(),
        transcript: field.string(),
        note: field.string(),
      },
      optional: ["note"],
    }),
  },
  values: {
    language: defineValue({
      title: "Language",
      value: field.string(),
    }),
  },
});

export const homeLens = defineLens({
  namespace: "so.epicenter.home",
  title: "Epicenter Home",
  description: "Conversations and Home-owned data.",
  tables: {
    conversations: defineTable({
      title: "Conversations",
      fields: { title: field.string() },
      optional: [],
    }),
  },
  values: {},
});

await using epicenter = await openEpicenter(options);

const data = epicenter.bind({
  whispering: whisperingLens,
  home: homeLens,
});

const recording = await data.whispering.tables.recordings.create({
  createdAt: Temporal.Now.instant(),
  transcript: "Hello",
});

await data.whispering.tables.recordings.blob.put(recording.id, audioSource);
const audio = await data.whispering.tables.recordings.blob.open(recording.id);

const found = await data.whispering.tables.recordings.get(recording.id);
const { rows, nonconforming } = await data.whispering.tables.recordings.scan();
for await (const entry of data.whispering.tables.recordings.entries()) {
  // entry is Result<Recording, NonconformingRowError>
}
await data.whispering.tables.recordings.update(recording.id, {
  note: undefined,
});

const stopRecordings = data.whispering.tables.recordings.subscribe(
  (changedIds) => {
    // fires after committed local or synchronized changes
  },
);
const stopLanguage = data.whispering.values.language.subscribe(() => {});

await using document =
  await data.home.tables.conversations.openDocument(conversationId);
await data.whispering.values.language.set("en");
await data.whispering.values.language.unset();

await epicenter.attachSync(session);
```

The exact environment factory may be `openEpicenter`, `openBrowserEpicenter`,
or `openBunEpicenter` depending on adapter packaging. There is one returned
runtime shape. There are no Device and Account runtime types.

`attachSync` is allowed only when the replica is unattached or already attached
to the same stable principal identity. Credentials may rotate; the attachment
does not. The call starts or resumes background synchronization and returns no
second Epicenter.

The attachment record is exactly `{ deploymentId, principalId }`, persisted in
the local replica's metadata inside the same durable transaction that enables
synchronization. `deploymentId` is the canonical deployment base URL (the full
`new URL(...).href`, never the bare host). `principalId` comes only from the
authenticated session endpoint: Better Auth's stable `user.id` on hosted Cloud,
the literal `instance` principal on self-host. Tokens, email, and provider
account IDs never enter the record. Enforcement is the local replica boundary:
compare before installing credentials into sync; refuse a differing pair before
any push. Sign-out clears credentials only, never the attachment. A self-host
deployment that moves to a new URL is a different deployment identity; the
replica refuses it rather than silently rebinding. Server-side replica
enrollment is not built: a modified client uploading its own data into a
different principal it holds valid credentials for is self-harm confined to
that principal's data, matching the existing non-conforming-client stance.

### Lenses and definitions

`defineLens`, `defineTable`, and `defineValue` return canonical pure JSON. A
Lens interprets one durable namespace; its `namespace`, `title`, and
`description` are required. The property names under `tables` and `values` are
the durable local keys. There is no redundant definition `key`, independent
Lens ID, database ID, workspace ID, schema registry, or complete model.

The property names under a table's `fields` object are likewise the exact
permanent field keys. The nested field value is only its JSON Schema and
semantic annotations; a `field.*` schema alone is not an identified field and
has no redundant `id` or `key`. This key comes from the Lens definition even
when an optional row does not contain a value for it. Changing `title` is a
display rename. Changing the object key addresses a new field and any data copy
or removal is explicit application work. Row ID remains separate runtime-minted
structural identity and cannot be declared in `fields`.

One identity rule holds throughout: the containing owner supplies identity. A
Lens supplies its namespace, definition maps supply durable table, value, and
field keys, and the runtime supplies row IDs. A Lens interprets these names; it
does not rename them. Only the outer multi-Lens binding uses ergonomic member
aliases because those names identify no durable data.

One application may bind several Lenses. Property names in that outer binding
are ergonomic aliases only. Multiple partial Lenses may interpret the same
namespace or address; none becomes canonical. Binding validates each Lens,
performs no I/O, creates no durable state, and returns synchronous borrowed
typed access.

The authoring helpers constrain `optional` entries to the table's field keys.
`parseLens(unknown)` validates the same closed JSON shape, supported field
vocabulary, and semantic cross-field rules for artifacts read from disk. It
rejects a nested field `id` or `key` rather than accepting a second identity
namespace. A runtime validator is derived and ephemeral, never persisted as
Lens state.

Namespace keys use collision-resistant reverse-domain naming. Table and value
keys are short local identifiers. Freeze their bounded grammar once at the
shared protocol boundary without concatenating them into one prefixed string.

### Tables and values

Rows have `id` plus definition fields. The runtime mints a 24-character NanoID
or another collision-equivalent ID. Callers cannot supply `id` to `create`.
Optional field `undefined` means remove the field and is lowered before JSON
serialization. `null` remains an ordinary accepted value.

Expose one complete classified traversal through two consumption forms.
`entries()` streams `Result<Row, NonconformingRowError>` values in stable row ID
order. `scan()` consumes that traversal to completion and groups it as
`{ rows, nonconforming }`. The runtime uses bounded internal batches, but
callers neither construct nor donate cursors. Traversal observes continuing
live state rather than a snapshot.

There is no public filter, arbitrary field order, limit, cursor, or page shape.
Every current production read is exhaustive, and application-specific sorting
and substring search stay client-side. Lenses currently declare no indexes or
query capabilities. A future index-backed read requires a separate decision
that assigns semantic access-pattern declaration and disposable physical-index
lifecycle to explicit owners before freezing any query syntax.

`entries()` bounds repair traversal only. It supplies no snapshot, durable
checkpoint, compare-and-set, revision check, or write precondition. Repair
idempotency, observability, interruption, and concurrent-write policy remain
application responsibilities.

Tables and values expose committed-change observation: `subscribe` on a bound
table receives the changed row IDs after a committed local write or an
installed synchronized change, and `subscribe` on a value fires on committed
set or unset. Both return an unsubscribe function. This is the only data
observation primitive; there are no live query objects, projections, or cache
runtimes. Evidence: Whispering bridges three observable domains into Svelte
through `createSubscriber` today; a replicated store without invalidation
cannot support any live UI.

A value is a typed singleton at one structured value address. Its surface is `get`, `set`,
`unset`, and `subscribe`. Do not call it KV: the public object does not expose
an arbitrary key-value collection.

Row-owned Yjs documents are universal: every live row latently owns exactly
one document at the row's own address, and every table lens exposes
`openDocument(rowId)`, which checks liveness, returns a revocable handle, and
lazily attaches the realtime collaboration overlay when synchronization is
attached. Durable outbound publication does not depend on that handle or
connection remaining open. Row deletion,
through any lens or through synchronization, revokes open handles and removes
document bytes in the same transaction. The document is schema-free Yjs
infrastructure with no document IDs and no layout or touch policy. There is no
per-definition `document` declaration: definitions are borrowed release-local
lenses, and both storage authorities already enforce the document lifecycle
purely by row address and liveness, so a definition flag could only gate
client-side API visibility while letting independently authored definitions
sharing one structured row address disagree about a capability neither owns. Opening a
document on a table that never uses one is inert: no bytes exist until the
first update is persisted, and the row tombstone deletes whatever exists.

Row-owned blobs are also universal and undeclared. Every live row latently owns
one zero-or-one write-once immutable blob slot. Table lenses expose a singular
`blob` surface addressed only by row ID. The first finalized byte stream records
its SHA-256 and schedules automatic authority publication. The same digest is
idempotent; a different digest at that live row is refused or parked. New bytes
require a new row. Several attachments therefore use several ordinary asset
rows with non-enforcing references and no atomic parent cascade.

### Status and errors

Expose only states a maintained UI actually distinguishes. A starting candidate
is `local`, `syncing`, `idle`, `offline`, and `authentication-required`, plus a
generic last error, pending counts, and address-scoped parked work for
diagnostics. Document-bound parked work identifies the row address, whether
encoded bytes or decoded structs crossed the bound, and the measured value and
limit. Epicenter Home must surface it; applications may observe the same Data
status, but locally accepted editor mutations do not become write errors. Status
is observation, not settlement. Do not expose `settle`,
`synchronizeThrough`, protocol floors, lineage recovery, database transitions,
or storage migration errors.

The protocol and persistence path may land before the polished status surface.
During that interval, the durable dirty or in-flight obligation remains the
source of truth and the runtime must not report the address as synchronized.
Structured parked details and Home presentation complete the wave; they do not
justify a second publication path, a thrown editor mutation, or a manual retry
button.

Ordinary `get` absence is `undefined`; ordinary delete reports whether a row
was deleted. Use typed Results at unsafe storage, validation, auth, and network
boundaries, not around every expected collection operation by reflex.

## One logical address space

```txt
table row  (namespace key, table key, row ID)
value      (namespace key, value key)
document   (namespace key, table key, row ID)
blob       (namespace key, table key, row ID)
```

Address kind distinguishes rows from values, so their local keys need not share
one flat key space. Two applications compose by declaring or installing Lenses
that name the same structured address. Different Lenses may interpret that
stored state differently across releases. Lens validation never rewrites
canonical state.

## Minimal physical model

Relation names below describe responsibilities, not a public SQL contract. The
implementation should collapse relations further when constraints and adapter
support permit it.

Authority responsibilities:

```txt
metadata
  physical format version, immutable authority lifetime identity,
  next authority sequence

replicas
  replica ID, last completed submission number, internal request hash,
  bounded parked results for exact retry

state
  address kind, namespace key, table-or-value key, optional row ID,
  present-or-absent state, JSON payload when present, authority sequence

document state
  row address, zero-or-one compact gc:true baseline, bounded ordered V2 tail

blob slot
  row address, nullable accepted SHA-256

blob bytes
  at most one immutable byte file per live row, stored outside SQLite
```

Local responsibilities:

```txt
metadata
  physical format version, replica ID, optional attached principal,
  attached authority lifetime, after sequence, next submission number

state
  confirmed authority facts in the same present-or-absent scalar shape

outbox
  compacted pending scalar intents, at most one per address, plus at most one
  immutable sealed submission and address-scoped parked work

document state
  row address, zero-or-one compact gc:true baseline, bounded ordered V2 tail

document publication
  row address, revision and dirty state,
  optional frozen inflight update, digest, and captured revision,
  optional parked reason

blob publication
  row address and SHA-256 for the one immutable byte stream awaiting authority acceptance

blob bytes
  at most one row-scoped immutable file per live row outside SQLite
```

Do not create `__epicenter_databases`, database aliases, retired-row tables,
catalog generations, protocol floors, transition tables, capture sessions, or
migration registries. The one metadata responsibility exists because adapters
must reject unknown physical formats and a local replica must remember its
principal attachment. It is not an application-facing catalog and does not
make the store portable SQL.

The logical facts feed does not freeze one physical state relation. Before the
replica and authority format break, benchmark two independent physical-layout
axes for each owner at the million-address envelope:

```txt
relation layout
  one checked facts table
    one sequence index and direct global uniqueness
    address-kind checks and a private missing-row representation

  separate row_facts and value_facts tables
    no mixed status, payload, or row-ID sentinels
    ordered UNION over two sequence indexes

coordinate layout
  inline structured address coordinates

  normalized coordinates
    dictionary-encode repeated kind, namespace, and local-key prefixes
```

Run all four combinations. Reject any candidate that fails the scan, install,
reopen, integrity, or constraint proofs. Define fixed material performance and
storage thresholds before running and retain the raw samples and query plans.
Treat measurement instability as a reason to add repetitions or refuse a
recommendation, never as permission to widen equivalence. A replica winner
requires both native SQLite and browser SQLite/OPFS evidence. An authority
winner requires both Bun SQLite and Cloudflare Durable Object SQLite evidence,
including Cloudflare rows-read, rows-written, row-size, parameter, and CPU
limits. A result from only one runtime is explicitly provisional and cannot
freeze the owner's universal format.
When candidates are materially equivalent, break the tie in this order:
direct SQLite enforcement of address and global-sequence uniqueness, fewer
relations, indexes, and feed branches, then fewer sentinel, nullable, and
mixed-shape clauses. Freeze one winner per owner; replica and authority may
choose different layouts. Do not retain losing layouts or add a compatibility
reader. The authority transaction owns global sequence allocation under every
layout.

The 24-character lowercase row-ID grammar remains a permanent storage invariant;
no private sentinel or nullable column escapes into protocol or public types.
The fold distinguishes terminal row deletion from nonterminal value unset
through the typed fact shape rather than relying on physical coincidence.

Each store's metadata is one explicit single-row table with named columns, not
`PRAGMA user_version` (unsupported on Durable Object SQLite) and not key-value
rows. The structured representation must be measured at the one-million-address
conformance envelope. Do not carry forward the earlier byte estimate for a flat
qualified key or treat dictionary encoding as an unmeasured afterthought.

Row deletion changes the latest state to a terminal tombstone and removes the
payload and row-document bytes. Later row-present intents for that address
settle to the existing tombstone. They do not resurrect it. The tombstone does
not append to a separate retired-row family. Value-absent stores payload-free
latest state that a later value-present intent may replace.

## Scalar synchronization

The semantic contract is fixed at independently convergent addresses and one
whole-Epicenter synchronization scope. One automatic runtime coordinates two
bounded scalar operations:

```txt
GET  /api/sync/v1/facts
POST /api/sync/v1/submissions
```

The facts operation returns current authority facts whose `sequence` is greater
than one replica-owned `afterSequence`, ordered by sequence. Each response is
the largest prefix that fits its byte and execution budget. `hasMore` means the
same read snapshot contained another qualifying fact. The replica atomically
installs the prefix and advances `afterSequence` to the final returned sequence.
No `next`, `through`, `position`, opaque cursor, completed checkpoint, or
separate acquisition state exists.

A fresh replica begins from zero and binds the response's authority lifetime.
Every later facts request and every submission carries that lifetime. Restore
causes a terminal mismatch, local erasure, and reacquisition from zero. A
sequence ahead in the same lifetime is corruption rather than a recovery mode.

Typed table create and update both lower to a row-present intent containing
top-level `set` and `unset` fields. Delete lowers to row-absent. Value set and
unset lower to value-present and value-absent. The replica compacts pending work
to at most one intent per address before sealing one numbered submission. It
never has more than one submission in flight.

The submission request carries authority lifetime, replica ID, submission
number, and bounded intents. An exact retry repeats those semantic fields. The
authority privately hashes the canonical parsed request to distinguish an
exact retry from a fork; no digest appears on the wire. A skipped submission
number is refused. One authority transaction owns lifetime and number
admission, intent folds, assigned fact sequences, the canonical request hash,
bounded parked results, and result-fact reads.

RFC 8785 canonical UTF-8 bytes of the validated semantic request own retry
hashing and semantic size admission across runtimes. V1 separately bounds every
string coordinate, identity, sequence, array, parked result, and envelope. Raw
HTTP body caps protect parsing but do not define semantic equality.

The submission response returns the current authority fact for every touched
address. Those facts are the settlement proof. Inside one local transaction,
the replica verifies that the response lifetime still equals its attached
lifetime, then installs facts monotonically per address: higher sequence
replaces, lower sequence is ignored, and equal sequence with different content
is corruption. It retires the sealed submission and normally keeps explicit
address-scoped parked work as a visible but non-retrying local overlay. After
monotonic installation, it inspects the resulting stored confirmed fact. A
terminal row tombstone discards a remembered parked row overlay as superseded,
including when the returned live fact was older and therefore ignored.
Otherwise, a later local write compacts with parked work and requeues it. There
is no receipt, applied flag, learned-through watermark, or authority touch.
Submission facts never advance `afterSequence`.

The local truth model is:

```txt
confirmed authority facts
+ compacted pending intents
= visible local state
```

Every learned fact is stored even when its address remains pending. A private
visible materialization may optimize reads but cannot discard or replace the
confirmed authority fact beneath the overlay. A learned terminal row tombstone
immediately supersedes unsealed row intents. An already sealed intent remains
immutable for exact retry but stops overlaying the tombstone.

V1 bounds fact size, facts-response bytes, submission bytes, and distinct
submission addresses. At least one maximum-size fact must fit. Because
submission settlement is not paged, the final constants must satisfy:

```txt
maxSubmissionAddresses * maxEncodedFactBytes
+ maxSubmissionAddresses * worstCaseParkedEntryBytes
+ worstCaseResponseEnvelopeBytes
<= maxSubmissionResponseBytes
```

The worst case includes both one current fact and one bounded parked entry for
every touched address. Parking does not replace settlement facts.

The current 64-fact page cap is transitional and must not become wire
semantics. Browser, Bun, and Cloudflare scale tests choose the inclusive V1
constants before ADR-0163 becomes Accepted.

Both endpoint routes carry scalar protocol version `v1`. Document publication
and any row-document realtime connection negotiate their own versions.
Physical SQLite format versions remain adapter-local. Do not persist a
cross-product of protocol floors.

## Row-document synchronization

Local document durability and authority publication are separate facts. Every
local Yjs update appends its V2 bytes and advances a lightweight dirty revision
in one SQLite transaction. It does not duplicate each offline edit into a
continually merged pending BLOB. A runtime-owned background drain enumerates
dirty addresses without requiring an application handle, reads the document
chain and revision in one snapshot, hydrates the current document, and uses the
authority state vector only as a transfer hint. It freezes the resulting exact
V2 payload, digest, and captured revision only if the revision still matches,
then retries those immutable bytes until it receives a post-commit receipt bound
to the active authority lifetime, row address, document protocol version, and
payload digest. The owner marks the row clean only if its revision still equals
the captured revision; a racing edit remains dirty for the next attempt. State
vectors never prove durability because delete-only updates need not advance
their struct clocks, but the frozen V2 payload still carries the delete set.
Closing a document destroys its live `Y.Doc` and any realtime connection but
never deletes the publication obligation.

Inbound document state stays lazy. An unopened document is not eagerly
hydrated merely because another device changed it. Opening the document
performs state-vector exchange and may attach a realtime collaboration overlay
for low-latency peer edits. That overlay carries no awareness or presence and
cannot be the only authority-publication path. Connection or initial-sync
status cannot stand in for a durable authority acknowledgement.

The exact realtime topology remains open for the live-collaboration dialectic.
One fixed-address socket per open row is the leading candidate; multiplexing
must replace it rather than coexist if measured browser socket limits earn the
extra subscription machinery. The authority stores no permanently live
`Y.Doc`. It is the trusted Yjs joiner, validator, and compactor, but never an
editing peer. Every live owner privately stores zero-or-one compact `gc: true`
baseline plus a tail bounded by both entry count and total encoded bytes.
Crossing either threshold atomically compacts the covered chain. A wire-valid
update too large for one physical tail row is applied directly into a new
compact baseline when the resulting canonical document remains within product
bounds. Derived live-document caches are adapter tuning. Compaction preserves
convergence but shares no scalar cursor or transport-batch semantics.

## Blob synchronization

Every live row has one universal undeclared zero-or-one blob slot. Finalized
immutable bytes live as one raw row-scoped file. SQLite records the accepted
nullable SHA-256 and, while publication is owed, one small row-addressed
obligation. The runtime publishes those bytes automatically, retries the same
digest idempotently, and clears the obligation only after the active authority
accepts matching bytes at the live row address. A different digest at an
occupied live row is refused or parked. Other replicas fetch the row's bytes on
demand; they do not mirror every authority blob eagerly.

There is no blob metadata store, application upload state, explicit remote
copy API, or generic outbox payload. Row deletion installs terminal scalar
deletion state, removes document and publication records transactionally, and
then reclaims the row's blob file idempotently. The runtime never scans
schema-opaque citations for garbage collection. Multiple assets use multiple
rows; reference updates and asset-row deletion remain non-atomic.

## SQL, inspection, and export

Applications have no SQL surface. Remove application-facing raw connections,
CTE injection, guarded SQL, projection DTOs, and dependencies on private
physical relation names.

Epicenter Home owns trusted human and agent relational inspection. It reaches a
live Epicenter through the storage owner, or opens an inert portable artifact,
and presents the stable logical relations:

```sql
rows(
  namespace_key,
  table_key,
  row_id,
  fields_json,
  document_update_v2 BLOB NULL,
  blob_sha256 TEXT NULL
)
values(namespace_key, value_key, value_json)
```

`document_update_v2` is one self-contained compact V2 update for the complete
Yjs document, never a state vector or copied live log. The two nullable columns
are platform-owned row structure outside Lens fields. This logical projection
does not replace the private live bounded chain or exact publication retry
evidence.

Installed Lenses provide typed interpretations for Home's table browser. The
naming, collision behavior, and lifetime of optional Lens-generated friendly
SQL views remain open and are not implementation prerequisites for raw logical
inspection.

ADR-0167 defines portability as an identity-free artifact containing one
selected owner's complete accepted current logical state. It represents the
same logical Epicenter but is not the live replica file. Do not implement
export or initialization in this wave. When implementation is authorized, it
must not resurrect database scope, generic merge, or synchronization lineage.

## Backups and authority replacement

ADR-0170 turns the portable representation into one recovery model:

```txt
One principal
├── one live Epicenter
│   └── one active authority lifetime
└── zero or more sealed Backups
```

Backups are host-visible, immutable portable Epicenters. They are complete
through the selected authority cut, including every blob byte that authority
owns. They may be listed through metadata, downloaded, restored, and deleted.
They are never live databases, synchronization targets, browsable host-side
application stores, partial exports, or merge inputs.

Backup capture snapshots the accepted logical rows, derives byte membership
from non-null `blob_sha256`, pins the selected external files against deletion,
copies and verifies them, and seals the artifact only after every selected byte
is present. There is no document inventory, blob relation, blob metadata JSON,
or blob-membership `manifest.json`. A generic container seal may still prove
artifact completeness without becoming another logical inventory.

The host control plane owns active-lifetime selection and Backup lifecycle
outside the replaceable authority. Hosted, self-hosted, and local-only hosts
provide the same conceptual owner without sharing a physical schema.

Restore accepts one Backup or validated uploaded portable Epicenter, builds a
fresh authority, and atomically replaces the active pointer only after complete
validation and construction. Every old replica is refused and must erase and
reacquire. Restore does not automatically preserve the outgoing authority; the
person chooses Back up first when that state should survive.

Work backward in these dependency-ordered waves. Container encoding, registry
schema, object-store layout, physical deduplication, quotas, and UI texture stay
open until their owning wave proves them:

1. **Prove the portable substrate.** Specify and round-trip one complete logical
   artifact across scalar rows, values, compact documents, and authority-owned
   blobs. Validate integrity and stream the 512 MiB conformance envelope without
   exposing a live private SQLite schema.
2. **Bind synchronization to one authority lifetime.** Introduce one opaque,
   equality-only lifetime identity and refuse every scalar, document, and blob
   operation from a superseded lifetime. Do not expose lifetime order or history
   as product API.
3. **Build sealed Backups.** Capture a stable authority cut, publish registry
   metadata only after the artifact is complete, and implement list, download,
   and independent deletion. A deleted Backup must affect neither the live
   Epicenter nor another Backup.
4. **Build Restore beside the active path.** Validate a Backup or uploaded
   portable artifact, construct the successor without mutating the current
   authority, then atomically close acceptance against the outgoing lifetime and
   activate the successor under a fresh lifetime identity. Every in-flight
   scalar, document, or blob operation is either durably accepted before this
   linearization point or refused; none may acknowledge success afterward.
5. **Stop the old lifetime before deletion.** After activation, route all new
   work to the successor and prove old replicas receive the lifetime-mismatch
   refusal. Keep the superseded private authority only as a temporary cleanup
   hold during verification. It can never become active again and is never a
   user-visible Backup.
6. **Verify before physical deletion.** Inject failures during capture,
   validation, blob streaming, successor construction, pointer activation,
   replica reset, and full reacquisition. Race in-flight scalar writes, document
   updates, and blob operations against activation. Only then delete the
   superseded private authority and prove that an explicitly retained Backup
   still restores.

The user-visible product needs only `Back up`, `Download`, `Restore`, and
`Delete`. Clearing tombstones, destructive rollback, edited-artifact
replacement, and synchronization reset are consequences of Restore, not
separate protocols.

## Target package graph

```txt
field -----> data <----- document-sync -----> sync
                \
                 +-----> sqlite

agent -----> small data interface

portable scalar/document protocols -----> server -----> api, self-host
```

Candidate packages:

```txt
@epicenter/data
  defineLens, parseLens, defineTable, defineValue, bind, local replica, sync attachment

@epicenter/document-sync
  row-document protocol, persistence, connection

@epicenter/agent
  agent loop over an explicit table/value capability

@epicenter/sqlite
  domain-free adapters only
```

Do not create packages for database address, database control, database
migration, inventory, capture, or lifecycle. `row-sync` does not earn a
package: the caller map found 17 server files and zero client files importing
it outside the legacy Workspace tree. The portable scalar wire schemas, folds,
admission limits, and canonical semantic encoder live in `@epicenter/data`
under a protocol subpath export that `@epicenter/server` consumes; the MIT leaf
direction is already how server consumes `@epicenter/sqlite` and
`@epicenter/identity`. The authority's private submission request hash remains
server retry metadata. Delete `packages/row-sync` after both sides import the
new protocol leaf.

`@epicenter/server` owns the authority schema and transactions. It must not
import application definitions or the local Data runtime. MIT code may not be
copied from AGPL owners without an explicit relicensing decision.

`@epicenter/workspace` is obsolete. Migrate retained callers to Data, Document
Sync, or Agent. Stop all imports while Workspace remains on disk, verify the
required graph, then delete it and sweep stale exports, tests, examples, docs,
and manifest dependencies. Do not leave a compatibility barrel.

## Execution waves

### Wave 1: freeze proof contracts

- Replace the database ADR/spec vocabulary with the decisions above. Done in
  this spec revision.
- Freeze the scalar V1 model-test matrix for facts-feed progress, direct
  settlement facts, numbered exact retry, deletion, and first attachment. Wave
  2 implements it in the owning protocol package.
- Inventory exact retained Workspace callers and classify each as migrate,
  delete, or temporarily break. Done; the caller map, schema inventory, API
  evidence, and identity trace live in `tmp/architecture-evidence/`.
- Freeze the structured namespace/local-key grammar and local
  principal-attachment invariant.

Rollback point: docs and tests only.

### Wave 2: build the new scalar core

#### Wave 2a: executable protocol kernel

- Add structured row and value address schemas, the four fact shapes, the four
  intent shapes, both operation schemas, RFC 8785 canonical semantic encoding,
  and pure authority folds under the protocol owner.
- Keep typed application create and update while lowering both to row-present.
- Prove sequence-prefix learning, concurrent rewrites, direct settlement facts,
  exact retry, fork and gap refusal, lifetime mismatch, terminal tombstones,
  parked stability, parametric admission validators, and the
  settlement-response inequality in runtime-free model tests. Exact inclusive
  constants wait for adapter measurements in Wave 2e.
- Import none of this path from production yet. It is a complete executable
  contract and the first standalone implementation commit, not a compatibility
  adapter over the old exchange.

Done (2026-07-21). The kernel landed under `packages/data/src/protocol/v1/`
behind a private barrel that the package `exports` map does not reference, so no
production consumer imports it and the old combined-exchange protocol is
untouched. It provides structured addresses, the four fact and four intent
shapes, both operation schemas, the pure authority fold, and a pure
storage-free reference authority.

Hardened across four fresh-context review passes:

- The canonical encoder implements RFC 8785 defensively (lone surrogates, sparse
  or extended arrays, symbol, accessor, and non-enumerable properties rejected),
  with Appendix B number coverage and round-trip proofs. Every complete protocol
  input passes a non-throwing, iterative canonical-JSON-tree gate (explicit stack
  and one monotonic visited set, so tens of thousands of levels cannot overflow
  the stack; cycles and shared references both rejected, because wire JSON is a
  tree and the canonical encoder would expand a shared subtree exponentially)
  before schema and semantic admission, so exotic outer shapes return a typed
  error instead of being silently dropped.
  Every admission boundary additionally catches any residual reflection or
  `structuredClone` failure and returns a typed refusal, so a throwing Proxy, a
  transparent Proxy (which `structuredClone` cannot own), or any host exception
  becomes `Invalid` rather than escaping.
- Every admitted request and every validated limits value is a detached,
  deep-frozen sealed value, so a caller cannot mutate a parsed request (push an
  intent, edit a nested payload) and then submit unadmitted input.
- The authority takes only opaque admitted requests and validated limits, so an
  in-process call cannot bypass admission; a duplicate-address submission or a
  lifetime-less non-zero read is impossible to construct. Authority construction
  admits its opaque lifetime and returns a Result, so it never emits a response
  its own parser rejects.
- The limits validator derives (never trusts) the response envelope purely
  arithmetically from fixed canonical skeleton costs plus the byte ceilings, with
  checked safe-integer math: it models the worst-case six-byte canonical
  expansion of a control-character lifetime and the terminal `hasMore:false`
  spelling, allocates nothing proportional to a ceiling (so a
  `Number.MAX_SAFE_INTEGER` ceiling refuses instead of exhausting memory), and
  reports a non-representable minimum as infinity so its capacity check fails.
  A maximum-size terminal fact fits at the exact derived minimum, and readFacts
  therefore never returns empty facts with hasMore true.
- Settlement retirement uses context-aware admission (one fact per intent in
  sealed order, globally distinct sequences, parked entries an ordered distinct
  subset of touched *row-present* addresses with valid measurements).
- The authority deep-detaches every retained input, every carried ledger, and
  every response, so no response, ledger entry, or successor state aliases
  another; and it refuses before assigning a sequence past the JSON-safe range.

Admission is fully parameterized; no numeric V1 constant is frozen (those wait
for Wave 2e). Only the 24-character lowercase row id is frozen; namespace,
local-key, and replica-id grammars are labeled V1-local. All proofs pass
runtime-free: `bun run --cwd packages/data test` (all green), `typecheck`, and
biome lint/format are clean.

#### Wave 2b: local replica format

- Benchmark all four combinations of relation layout (one checked facts table
  or separate row and value fact tables) and coordinate layout (inline or
  normalized) against both replica and authority workloads. Freeze one layout
  per owner only after the required native/browser or Bun/Cloudflare evidence;
  choose the same layout only if evidence earns the shared shape.
- Replace flat scalar and document address columns together. The physical-format
  break carries structured identity through confirmed facts, pending intents,
  sealed submission state, parked diagnostics, and document liveness joins.
  Refuse the old format; do not add a migration reader.
- Persist confirmed authority facts independently from compacted pending and
  parked overlays. Persist the bound authority lifetime, `afterSequence`, and
  next submission number.
- Prove lifetime-gated monotonic fact installation, confirmed-plus-pending
  visible state, terminal tombstone dominance, per-prefix atomic watermark
  advancement, crash recovery, and reopen.
- Do not combine this address-only document-column break with the later Yjs
  baseline, tail, compaction, or publication redesign.

#### Wave 2c: authority format and operations

- Make the host control plane supply the authority lifetime identity. Persist
  and check it inside the authority; the replaceable authority constructor does
  not mint, select, or own active Restore state.
- Persist structured current facts, one global sequence, and each replica's last
  submission number, canonical request hash, and bounded parked results.
- Implement `readFacts` and `submit` as separate authority transactions. The
  submission transaction owns admission, folds, sequences, retry metadata,
  parked results, and result-fact reads.

#### Wave 2d: in-process conformance

- Connect the replica capability directly to authority operations before adding
  HTTP. Prove lost responses, fork and gap refusal, concurrent rewrites, direct
  settlement replay, delayed older facts, equal-sequence corruption, stale
  lifetime reset, same-lifetime sequence-ahead corruption, and fault-injected
  transaction boundaries.
- Prove `hasMore` comes from the same authority snapshot and no fixed `through`,
  `position`, or count enters wire semantics.

#### Wave 2e: wire, adapters, and supervisor

- Mount authenticated `GET /api/sync/v1/facts` and
  `POST /api/sync/v1/submissions` only after in-process conformance passes.
- Implement Bun and Cloudflare authority adapters, then browser and desktop
  transports, against the same schemas and state-machine suite.
- Build a new supervisor capability with independent fact and submission drains
  under one lifecycle owner for auth, wakeups, backoff, status, and disposal.
  Do not switch production composition roots yet, and do not recombine the
  operations behind an exchange-shaped helper.
- Derive and freeze inclusive V1 fact, response, submission, raw-body, identity,
  and distinct-address limits from the settlement-response inequality and
  measured browser, Bun, and Cloudflare evidence.

Rollback point: the old path still exists and no caller imports the new core.

### Wave 3: build typed Data

- Implement pure JSON `defineLens`, `parseLens`, nested table/value definitions,
  structured addresses, and one multi-Lens `bind` convention.
- Implement table CRUD, classified `scan` and `entries`, value operations,
  observation, and
  nonconforming read behavior.
- Prove compact Yjs baseline-plus-tail equivalence in a runtime-independent
  model, then persist the bounded chain in each SQLite adapter.
- Implement atomic count-and-byte compaction and the direct-to-baseline path for
  transient updates too large for one physical tail row.
- Add the local dirty revision and immutable in-flight publication image. Prove
  its crash and racing-edit transitions against a fake authority before adding
  networking.
- Implement one authority document-acceptance transaction: check row liveness,
  apply the candidate, enforce post-candidate bounds, compact when required,
  commit, and return the exact payload receipt.
- Attach the runtime-owned background drain to that operation without depending
  on open handles. Then route the realtime overlay through the same operation;
  it earns no second acknowledgement or persistence path.
- Preserve structured parked refusal details and expose them through Data and
  Epicenter Home. This presentation may follow the core protocol, but no
  intermediate implementation may report refused work as synchronized.
- Replace browser IndexedDB blobs with one write-once OPFS file per owning row,
  nullable SHA-256 state, and durable automatic publication records.
- Bind open row documents through the separately owned realtime collaboration
  overlay.
- Add browser and native adapter conformance tests.

Rollback point: production callers still use Workspace.

### Wave 4: migrate retained callers

The maintained migration surface from the caller map: apps/epicenter (3
runtime files SQLite family, 8 agent files), apps/whispering (7 runtime
files), packages/skills (5 runtime files), apps/honeycrisp, packages/chat
(delete `legacy-root-yjs.ts`), packages/app-shell (delete the sign-in
migration and workspace-gate adoption surfaces outright; migrate agent-chat),
packages/svelte-utils (`from-table`/`from-kv` become Data-backed), packages/ui
(relocate the natural-language date-input's Workspace utility imports),
packages/server (the legacy room presence path is deleted), and
packages/cli (daemon/mount: six runtime files; decide migrate-to-data-backed
mounts versus explicit retirement before this wave ends; it migrates last
either way).

- Migrate Epicenter, Whispering, and other maintained applications from their
  composition roots inward.
- Switch production Data and Server composition roots to the V1 authority,
  transports, and supervisor. Stop every import of the old exchange path, but
  leave its files on disk until Wave 5 proves the replacement.
- Migrate Agent through its explicit data interface.
- Remove imports of database-address, database-control, database-migration, and
  provisional database inventory/scheduler code.
- Remove application SQL callers and examples. Route Home's trusted inspection
  through the live storage owner instead of a public application API.

At the end of this wave, no retained manifest or source file imports Workspace.
Workspace remains on disk but unreachable.

### Wave 5: verify before deletion

- Run targeted package tests and typechecks after each migrated owner.
- Run the complete monorepo tests, typechecks, lint/format, licenses, package
  graph, docs hygiene, and API path checks.
- Reuse one document state-machine suite across Bun SQLite, browser OPFS SQLite,
  the Cloudflare Durable Object authority, and the self-host authority. Add
  adapter-specific tests only for storage and lifecycle behavior the shared
  suite cannot express.
- Cover the document protocol with the following canonical narratives. Do not
  multiply every data shape, crash point, topology, and adapter into a full
  Cartesian product: use property tests for update shapes, deterministic fault
  injection for transaction boundaries, and pairwise adapter coverage around
  these end-to-end stories.

  | Narrative              | Required proof                                                                            |
  | ---------------------- | ----------------------------------------------------------------------------------------- |
  | Ordinary edit          | Local commit survives closure; authority commit precedes receipt and fanout               |
  | Delete-only edit       | Exact receipt proves the submitted delete set even when the state vector does not advance |
  | Racing local edit      | Receipt clears only its captured revision; later work remains dirty                       |
  | Lost acknowledgement   | Exact bytes retry idempotently without permanent request history                          |
  | Concurrent clients     | Reordered valid updates converge through the authority join                               |
  | Compaction failure     | Reopen sees the old chain or new baseline, never a partial state                          |
  | Oversized tail entry   | Valid bounded state stores directly as a compact baseline                                 |
  | Product-bound refusal  | Below, at, and above byte and struct limits are deterministic and visibly parked          |
  | Row deletion race      | Neither publication nor fanout resurrects the document                                    |
  | Hibernation and reopen | SQLite alone reconstructs state and outstanding publication work                          |
  | Restore race           | Work commits before activation or receives lifetime mismatch; it never crosses lifetimes  |
  | Backup cut             | The nullable compact cell decodes to exactly the accepted authority document              |

- Prove the whole-replica trade at 1,000,000 live scalar addresses and 512 MiB
  of canonical encoded logical state. Measure authority scan, transfer,
  browser and native installation, reopen, and peak memory. Inject crashes
  between fact prefixes and prove `afterSequence` resumes without reinstalling
  committed facts. Prove concurrent rewrites remain discoverable without a
  frozen `through` ceiling. Treat this as a conformance envelope, not a hard
  product limit or a protocol constant.
- Exercise sparse and dense zero-or-one blob fixtures inside that envelope.
  Prove same-digest retry, different-digest refusal, row-terminal cleanup,
  byte-complete Backup capture, crash recovery during pin/copy/verify/seal, and
  round-trip restoration without consulting a membership manifest.
- Smoke first sign-in with local data, sign-out/reopen, same-principal sign-in,
  wrong-principal refusal, two-device convergence, offline deletion, and browser
  multi-tab writes.
- After the realtime topology dialectic freezes, verify its chosen shape on
  iPhone Safari and an installed PWA at realistic simultaneous document counts.

Rollback point: restore imports to the old on-disk path if proof fails.

### Wave 6: delete the old graph

- Delete `packages/workspace` and its compatibility exports.
- Delete provisional database packages, inventory, control, migration,
  scheduler, floors, aliases, rekeying, capture, SQL projection, and per-database
  lifecycle code.
- Delete or explicitly retire deferred apps that have not migrated.
- Re-run stale-name searches for Workspace and Database platform nouns, allowing
  only unrelated SQL/database terminology and historical superseded ADRs.
- Delete this spec after the implementation lands and mark its ADRs Accepted.

## Deletion ledger

```txt
defineWorkspace, WorkspaceId, workspace prefixes
defineDatabase, defineDatabaseModel, DatabaseId, DatabaseModel
epicenter.database(...), per-database sync/status/lifecycle
Device and Account parallel local stores
database catalogs, inventory, aliases, grants, generations
rekeying, bridge layouts, protocol floors, offline migrators
push, pull, acquire as separate public/network operations
retention floors, acquisition scratch, lineage recovery
per-database clear, capture, merge, reset, export state machines
permanent retired-row relation separate from latest state
application SQL escape hatches, private-schema dependencies, projection DTOs
flat qualified data keys, redundant table/value/field key properties
generic authority scheduler
workspace compatibility barrel
```

## Recognition criteria

The destination is recognizable when a new reader can answer these questions
without learning historical vocabulary:

- What data do I define? A pure JSON Lens for one namespace, with tables and
  values whose property names complete durable addresses.
- Where does field identity live? In each member name of a table's `fields`
  object, never in a nested `id` or `key`.
- Does a Lens rename durable data? No. Application-local projection owns private
  code-facing names.
- How do I use several namespaces? Bind several borrowed Lenses.
- Who owns the data? One person through one Epicenter.
- Where is it stored? One complete replica per adapter isolation boundary.
- What happens on first sign-in? The current replica permanently attaches and
  converges.
- How does deletion survive an offline device? The latest state is a permanent
  compact tombstone within the active authority lifetime.
- How is state preserved over time? As sealed, byte-complete Backups, never as
  additional live Epicenters.
- What does Restore do? It creates a fresh authority lifetime from one complete
  Backup or uploaded portable Epicenter and invalidates every old replica.
- How does scalar sync work? The runtime reads current authority facts after one
  sequence and submits one replica's numbered desired-state intents. Current
  facts are both learned state and submission settlement proof.
- How do documents sync? Local updates publish automatically after handles
  close; remote state hydrates lazily when a document opens.
- How are documents represented portably? As one nullable self-contained Yjs
  V2 update on the logical row, never the private live update log.
- What are document WebSockets for? Optional low-latency collaboration, never
  awareness, presence, or the sole durability path.
- How do blobs sync? Each row's zero-or-one write-once immutable byte stream
  publishes automatically and downloads on demand.
- What identifies a blob? Its owning row address. SHA-256 proves the accepted
  bytes and makes retries idempotent; it is not a separate BlobId.
- How do several attachments work? As several ordinary asset rows with
  non-enforcing references and no generic cascade.
- What inventories a Backup? Its logical row relation. Nullable document and
  blob columns replace separate inventories and membership manifests.
- Can applications run SQL on the live store? No.
- Who can inspect relationally? Epicenter Home, for people and agents, over one
  stable logical model.
- What replaces Workspace? Data, Document Sync, and Agent.

If an answer needs database IDs, workspace IDs, prefixes, catalogs, acquisition,
protocol floors, migration, or two local owners, the clean break is incomplete.

## Open decisions after the destination freeze

These questions must be resolved before their implementation wave. They do not
weaken the ADR destination above:

1. **Friendly Lens SQL views.** Decide whether Home needs generated SQL names in
   addition to the raw `rows` and `values` relations, and if so how installation
   aliases, collisions, quoting, and ephemeral lifetime work.
2. **Lens discovery and activation.** Decide whether app-bundled Lenses live only
   in the active app catalog, whether standalone Lens artifacts have a separate
   folder, and what uninstall removes. Discovery provenance must not enter data
   addresses or make a Lens authoritative.
3. **Structured row references.** ADR-0169 fixes references as non-enforcing
   table interpretations and removes them from the destination field
   vocabulary. Decide the exact pure JSON table metadata shape, typed
   reference-navigation ergonomics, and Matter replacement before deleting the
   current shared `field.reference()` implementation.
4. **Realtime row-document topology.** Decide whether the live overlay uses
   one fixed-address WebSocket per open row, one multiplexed connection, or no
   dedicated overlay until a concrete collaborative surface ships. Preserve
   automatic background publication, lazy inbound hydration, post-commit
   authority proof, and the refusal of awareness and presence under every
   option.
