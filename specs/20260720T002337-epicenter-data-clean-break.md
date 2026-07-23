# Epicenter data clean break

- **Status:** In Progress
- **Date:** 2026-07-20 (rewritten 2026-07-21 from the frozen record
  architecture)
- **Program:** greenfield breaking replacement
- **Decision owners:** [ADR-0160](../docs/adr/0160-lenses-interpret-durable-namespaces-without-creating-lifecycle-scopes.md), [ADR-0161](../docs/adr/0161-each-person-has-one-epicenter-replicated-on-each-adapter-boundary.md), [ADR-0162](../docs/adr/0162-epicenter-home-owns-relational-inspection-applications-receive-no-sql.md), [ADR-0163](../docs/adr/0163-scalar-sync-separates-fact-reads-from-numbered-intent-submissions.md), [ADR-0164](../docs/adr/0164-scalar-facts-converge-independently-epicenter-refuses-distributed-transactions.md), [ADR-0165](../docs/adr/0165-browser-origins-contain-independent-epicenter-replicas.md), [ADR-0166](../docs/adr/0166-data-document-sync-and-agent-replace-workspace.md), [ADR-0167](../docs/adr/0167-a-portable-epicenter-is-an-identity-free-export-of-one-authority-cut.md), [ADR-0168](../docs/adr/0168-lenses-are-complete-pure-json-interpretations.md), [ADR-0169](../docs/adr/0169-row-references-are-non-enforcing-table-interpretations.md), [ADR-0170](../docs/adr/0170-one-live-epicenter-has-sealed-backups-and-restore-creates-a-fresh-authority-lifetime.md), [ADR-0171](../docs/adr/0171-every-durable-local-write-leaves-an-automatic-authority-obligation.md), [ADR-0172](../docs/adr/0172-sqlite-stores-convergent-facts-and-documents-raw-files-store-blob-bytes.md), [ADR-0173](../docs/adr/0173-each-row-owns-at-most-one-write-once-immutable-blob.md), [ADR-0174](../docs/adr/0174-row-documents-project-as-nullable-compact-cells-and-persist-as-bounded-live-chains.md), [ADR-0175](../docs/adr/0175-table-traversal-is-complete-and-classified-with-paging-kept-private.md), [ADR-0176](../docs/adr/0176-lenses-declare-no-query-capabilities-indexed-reads-require-separate-owners.md), and [ADR-0177](../docs/adr/0177-each-store-owner-persists-records-in-one-wide-interned-crash-state-relation.md)

## Product sentence

> Epicenter durably synchronizes records addressed by namespace, collection,
> and record key; Lenses present those records as rows or values, Home captures
> point-in-time SQL artifacts, and only ordinary typed writes or Restore can
> change the live Epicenter.

## Accepted premises

- There is no legacy user data to preserve. This is intentionally a breaking
  change. No wave adds a compatibility reader, migration bridge, dual writer,
  fallback representation, or staged product mode. Rollback checkpoints may
  retain old code on disk temporarily, but callers never use both paths
  concurrently.
- The durable platform noun is the record: one address
  `(namespace, collection, record key)` with scalar state that latently owns
  zero or one document and zero or one blob slot. No durable address or wire
  type contains a row/value kind; the table-versus-values distinction appears
  exactly once, in Lens collection definitions (ADR-0160).
- The wire has one fact shape and four operations (`patch`, `replace`,
  `tombstone`, `unset`), with tombstone absorption evaluated first
  (ADR-0163). Records converge independently; Epicenter exposes no
  multi-record transaction (ADR-0164).
- A replica record has three crash lanes (`confirmed`, `sealed`, `pending`)
  plus the `parked` overlay retaining a refused operation. Sealing persists
  the exact canonical request bytes for retry (ADR-0163).
- ADR-0177 selects the wide interned record row as the physical candidate.
  That selection is itself Proposed behind three named reversal charters; the
  accepted premise is only that one candidate is selected and that a reversal
  is a store-owner schema swap no caller-facing surface may depend on.
- Epicenter is a curated personal universe, not an ingestion lake. The
  representative normal stress target remains 1,000,000 final-present
  addresses at the 512 MiB versioned proxy (ADR-0161), with the mobile floors.
- Applications receive no SQL. Home inspection means owner-mediated
  point-in-time snapshot capture; ad hoc SQL runs only against inert artifacts
  (ADR-0162).
- Every inert artifact self-declares its kind through `_epicenter_artifact`,
  and its lossless raw relation is `_epicenter_records` (ADR-0167). Snapshots
  have no apply meaning; Restore accepts only `kind='portable'` (ADR-0170).
- Every locally durable write leaves an automatic authority obligation drained
  by one runtime owner (ADR-0171). Only terminal tombstone reaps a record's
  document and blob capabilities (ADR-0173, ADR-0174).
- One person has one live Epicenter and zero or more sealed Backups; Restore
  creates and atomically activates a fresh authority lifetime and never emits
  ordinary intents (ADR-0170).
- A Proposal is a sealed, source-bound, externally editable artifact whose
  changes enter the live Epicenter only as ordinary typed writes. It disappears
  after complete local admission while the normal pending lane keeps any
  remaining authority obligation (ADR-0178).

If any premise changes before merge, stop. Do not hide the change behind an
alias, migration bridge, optional scope, or second runtime.

## The asymmetric refusals

**First attachment is one whole-replica choice.** Before the first successful
attachment permanently binds a nonempty unattached replica to a principal, the
person chooses `Bring local data` (converge everything through the ordinary
plane laws) or `Discard local data` (clear logical state and obligations in
the transaction that records attachment). No Device-versus-Account owners,
profile catalogs, adoption modes, per-item merge choices, or account-switch
recovery. A brought tombstone terminally deletes a shared live record; a
pre-existing remote tombstone remains final (ADR-0161).

**Permanent tombstones within one lifetime.** A small durable record per
terminal deletion deletes acknowledgment catalogs, retention floors, baseline
acquisition, and resurrection by stale replicas. Unset stays reversible.
Restore is the one deliberate escape that clears tombstones by starting a
fresh lifetime (ADR-0170).

**No live SQL for anyone.** Deleting the live inspection session, its TEMP
views, its exclusivity rule, and its busy refusals buys one capture command
and an inert artifact. The accepted loss is freshness: a snapshot is stale the
moment it is captured, and refresh is recapture (ADR-0162).

## Public destination

```ts
export const whisperingLens = defineLens({
  namespace: "so.epicenter.whispering",
  title: "Whispering",
  description: "Recordings and transcription settings.",
  collections: {
    recordings: defineTable({
      title: "Recordings",
      fields: {
        createdAt: field.instant(),
        transcript: field.string(),
        note: field.string(),
      },
      optional: ["note"],
    }),
    settings: defineValues({
      title: "Settings",
      values: {
        language: field.string(),
        theme: field.enum(["light", "dark"]),
      },
    }),
  },
});

await using epicenter = await openEpicenter(options);

const data = epicenter.bind({ whispering: whisperingLens });

const recording = await data.whispering.recordings.create({
  createdAt: Temporal.Now.instant(),
  transcript: "Hello",
}); // lowers to patch over {}

await data.whispering.recordings.update(recording.id, { note: undefined });
await data.whispering.recordings.delete(recording.id); // lowers to tombstone

const found = await data.whispering.recordings.get(recording.id);
const { rows, nonconforming } = await data.whispering.recordings.scan();
for await (const entry of data.whispering.recordings.entries()) {
  // entry is Result<Recording, NonconformingRowError>
}
const stop = data.whispering.recordings.subscribe((changedIds) => {});

await using doc = await data.whispering.recordings.openDocument(recording.id);
await data.whispering.recordings.blob.put(recording.id, audioSource);

await data.whispering.settings.language.set("en"); // lowers to replace
await data.whispering.settings.language.unset();   // lowers to unset
const stopTheme = data.whispering.settings.theme.subscribe(() => {});

await epicenter.attachSync(session);
```

Values use property access (`settings.theme.set(...)`); declared record keys
make dynamic-key collection verbs pointless. Wire verbs, lanes, sequences,
submissions, and retry state never appear in the application API. Reads
classify nonconforming data and preserve unknown fields. Status is
observation, never settlement: a small state enum, pending counts, and
address-scoped parked work (which Epicenter Home must surface).

The attachment record, `Bring`/`Discard` mechanics, and the
`{ deploymentId, principalId }` invariant are unchanged from ADR-0161: the
pair persists in replica metadata in the transaction that enables
synchronization; sign-out clears credentials only; another principal requires
a fresh replica.

## Physical model

ADR-0177 owns the physical layout: one `records` relation per store owner
whose row is the whole per-address crash-state machine, with a private
`record_id` rowid interning the triple for the byte-heavy sibling relations
(document chains, frozen in-flight images), lane-shape CHECK disjunctions with
explicit NULL guards, explicit tombstone-transaction cleanup (no cascades),
and one explicit single-row `meta` table per owner. The split-relation layout
is the sole runner-up, alive only behind ADR-0177's three charters
(wide-versus-split hot paths, Durable Object billing, physical OPFS capacity
and reopen).

The four-combination relation-and-coordinate benchmark matrix that this spec
previously carried is retired. The retained 2026-07-21 Bun/native run and its
schema-v3 report remain honest historical evidence about their own fixture
under `docs/benchmarks/scalar-facts-layout/`; that run selects nothing, its
latency estimator was established to be inadequate, and its storage
observation (normalized coordinates saved about 12% on that fixture, roughly
two prefix copies) is an input the wide-versus-split charter supersedes. Do
not rerun the historical matrix; run the ADR-0177 charters.

The 24-character lowercase record-key grammar for table collections is a
permanent storage invariant. The restricted address grammar and bytewise
canonical ordering are enforced at every admission boundary (ADR-0163).

## Protocol kernel status

The executable protocol kernel lives under `packages/data/src/protocol/v1/`
behind a private barrel, with defensive RFC 8785 canonical encoding,
deep-frozen admitted requests, a pure storage-free reference authority, and
runtime-free proofs. W1A (2026-07-21) rewrote its address and shape layer to
the kindless record triple, one fact shape, and the four operations with the
absorption-first algebra (`foldIntent` plus `composeOperations`), deleting the
kinded row/value addresses and their eight shapes without aliases or a
compatibility decoder; the canonicalization, admission hardening, and
authority-fold architecture carried over unchanged. W1A also landed the
maintained lane-machine conformance suite under
`packages/data/src/store/conformance/`: the probe's reference transitions as
owner-partitioned cases over ADR-0177-shaped fixtures, with file-backed
statement-boundary crash injection, owning fixture disposal, and the
persisted first-seal request-bytes-and-hash assertions. The replica subset is
stated once, adapter-agnostically, in a parameterized case runner behind a
small binding contract (semantic lane observations plus prepared crash-probed
transitions), with the pure protocol authority as its settlement oracle; the
unexported SQLite reference driver binds to it now, and W1B/W1C bind
production replica adapters to the same cases without copying them. The
authority and document/blob subsets stay reference-bound until W2 and W3 bind
their production owners; the terminal-tombstone case proves installation,
blob-evidence clearing, and child-row deletion as one crash-injected
transaction. No production consumer imports the kernel.

## Execution waves

Work backward from the recognition tests at the end of this spec. Every
executable wave follows one rollback order:

```txt
build the new path
stop importing the old path
verify the new path
delete the old path
```

This is a rollback checkpoint, not a compatibility mode: while the old path
remains on disk, no retained caller imports both.

### W0: durable contracts

- Amend and replace the owning ADRs so the record model, lanes, artifacts,
  and physical selection each have one durable owner (done in this revision:
  ADR-0160 through ADR-0177).
- Align `docs/CONTEXT.md`, the architecture guide, and this spec (this
  revision).
- Preserve the disposable lane probe as evidence only. It proved transaction
  rollback and logical-state equivalence in memory; it did not prove
  file-backed crash and reopen behavior. W0 is documentation only; W1 begins
  by promoting and strengthening its transition proofs in the maintained
  repository suite. The maintained harness, not the probe, is the shipping
  gate.

Rollback point: docs only.

### W1: replica records and lanes

W1 is deliberately serial at its foundation. Do not fan out into the replica,
authority, browser, and Cloudflare stacks before the shared semantics and
maintained proof surface exist.

#### W1A: shared semantics and maintained harness

- Rewrite the private protocol kernel's address and shape layer to the record
  triple, one fact shape, and four operations; keep the hardened canonical
  encoder and admission architecture.
- Land the four-operation composition tests, including randomized sequential
  equivalence and tombstone absorption evaluated before any payload logic.
- Promote the disposable probe's transition cases into a permanent conformance
  suite: preserve all eleven transition scenarios as reference fixtures,
  partition them by replica, authority, and document/blob owner, and retain
  statement-boundary fault injection. One unexported test-only SQLite driver
  may execute the reference cases; it is an oracle, not a second product
  store. Strengthen the old in-memory rollback probe to file-backed close and
  reopen coverage, and add the new assertion that persisted first-seal
  canonical request bytes and their hash survive every retry. Shape the
  replica subset so adapters can run it without copying the cases; W2 and W3
  bind the authority and document/blob subsets to their production owners.
- Stop for an independent review before implementing a production replica
  store. Blob staging write-order cases join the same maintained suite in W3,
  when the blob foundation gives them a real adapter to exercise; do not add
  skipped or stubbed tests in W1A.

#### W1B: Bun replica store

- Implement the replica store on the ADR-0177 schema: lane transitions,
  composition and compaction under the one algebra, seal with persisted
  request bytes, settle, monotonic fact installation, tombstone dominance,
  parked retention and consumption, erase and reacquire.
- Run the maintained harness against the Bun adapter and complete the
  wide-versus-split hot-path evidence that can be measured on Bun.

Implementation checkpoint (2026-07-22): the private production store now owns
the ADR-0177 wide relation and passes the shared replica conformance cases
through a Bun binding whose crash injection stays entirely test-side. The Bun
store recognizes only its exact dedicated schema, and facts-feed pages are
admitted against the exact durable request inside the installation transaction;
the cursor is derived rather than supplied independently. Sealing takes the
largest admissible canonical-address prefix while leaving overflow pending,
and erase retains a lifetime fence so the same authority ledger cannot be
rebound behind a reset submission number. The full
Bun charter slice then exercised exactly 1,000,000 final-present records at the
536,870,912-byte V1 proxy. Its stop rule fired with mixed material directions:
wide won point-read and median feed-install work, while split won traversal,
lane-write, and feed-install tail latency; reopen was equivalent under the
stop rule. The report lives under
`docs/benchmarks/replica-layout/`; W1C and W2 still own the browser and Durable
Object slices before ADR-0177's Proposed selection can be accepted or reversed.

#### W1C: browser replica adapter

- First pass W1C0, the browser-owner topology admission checkpoint. Each live
  page starts one dedicated-worker candidate; one exclusive origin Web Lock
  elects the only worker allowed to open the OPFS SAH pool and SQLite replica;
  waiting candidates own no store or semantic cache. A versioned
  BroadcastChannel carries addressed RPC, replies, and invalidations only.
  Prove in maintained Chromium and WebKit evidence that the actual owner
  context admits the SAH pool, two tabs observe at most one SQLite owner,
  owner-page close and forced worker termination promote a waiting candidate,
  reopen passes integrity and accepts another write, profile relaunch preserves
  the semantic witness, and a mutating request pending across owner loss fails
  explicitly rather than replaying. Do not begin the browser layout charter
  until W1C0 passes.
- Implement the browser OPFS adapter behind the same store boundary and run
  the maintained harness unchanged.
- Complete the browser slice of the wide-versus-split hot-path charter.
- Complete the physical OPFS capacity and reopen charter on physical iOS
  Safari and Android Chrome. Keep honest quota refusal outside the semantic
  store API.

Implementation checkpoint (2026-07-22, partial): the production browser
replica runs the W1B store behind sqlite-wasm's OPFS SAH-pool VFS in one
dedicated Worker holding the exclusive origin Web Lock. Waiting page
candidates open no database. The versioned candidate protocol retries lost
discovery, idempotent reads, replies, and invalidation heartbeats within a
fixed bound. It never replays a mutation after owner loss. Maintained tests
cover takeover fencing, lossy coordination, bounded failure, and the unchanged
replica contract.

The browser layout harness also completed full headless Chromium and WebKit
profiles at 1,000,000 records and the exact 536,870,912-byte proxy. Both
profiles passed integrity and reopen checks and materially favored split for
traversal and lane writes; the remaining hot metrics stayed inside the stop
rule's neutral band or tied at engine timer resolution. Raw reports live under
`docs/benchmarks/replica-layout/` and remain explicitly provisional and
decision-ineligible.

W1C remains incomplete. Physical iOS Safari and Android Chrome still owe the
250,000-address and 128 MiB floor, the conditional full-envelope run,
quota-refusal prefix and durable-progress proof, and hidden-owner suspension
and eviction qualification. No physical result is inferred from Playwright.

W1 does not migrate retained callers or delete Workspace. W4 owns the point at
which every replacement capability exists, callers stop importing the old
path, verification passes, and `packages/workspace` can be deleted.

### W2: authority records and retry witness

- Implement the authority on the ADR-0177 schema: one current-fact lane,
  `next_sequence`, the per-replica witness (number, canonical hash, bounded
  parked results), the one-transaction submission fold, and the facts feed
  with same-snapshot `hasMore`.
- Mount `GET /api/sync/v1/facts` and `POST /api/sync/v1/submissions` after
  in-process conformance passes; Bun and Durable Object adapters share one
  suite.
- Derive and freeze the inclusive V1 constants from the settlement-response
  inequality plus measured browser, Bun, and Cloudflare evidence, including
  the DO 2 MB row ceiling and the combined-replica-row bound.
- Complete the Durable Object slices of ADR-0177's wide-versus-split hot-path
  and billing/write-amplification charters.

Implementation checkpoint (2026-07-22): the production scalar V1 authority
now owns the wide relation, monotonic sequence allocator, per-replica retry
witness, atomic submission fold, and same-snapshot facts paging. Bun SQLite and
Durable Object adapters run the same maintained authority cases. Strict bounded
HTTP routes are mounted beside the legacy caller path in the hosted,
self-hosted Cloudflare, and self-hosted Bun deployments. That path remains live
until W4B migrates its callers and unmounts it; no caller uses both. V1 limits are frozen
from the settlement-response inequality and keep authority, witness, replica,
and sealed-request rows below Durable Object SQLite's 2 MB row ceiling.

The full Durable Object charter used two opposite candidate orders, each with
1,000,000 records at the exact 536,870,912-byte proxy and 128 measured
64-address batches. Wide used 6.52% less storage, kept write amplification
identical, and materially won the authority feed, fact write, and settlement
paths; split won only the isolated accepted-blob write. Wide paid
one extra low-priced row read per touched address for its secondary address
index. Current Cloudflare allowances and rates make shared row writes the
governing billing term, so that read delta does not reverse the selection.
Both layouts reopened with complete row counts. The raw reports, pricing
calculation, and limitations live under `docs/benchmarks/authority-layout/`.
ADR-0177 remains Proposed because the mixed Bun replica evidence and unfinished
browser OPFS charters still own the cross-owner decision.

W2 may begin after W1A passes independent review while W1B and W1C continue
against the frozen shared kernel and conformance contracts.

### W3: document and blob foundations

- Persist bounded baseline-plus-tail chains keyed by `record_id`, the frozen
  in-flight publication image, dirty revisions, and receipts (ADR-0174,
  ADR-0171).
- Implement the record-wide latent capabilities with the only-tombstone-reaps
  law and the typed per-record `exportDocument` operation.
- Implement the blob staging write-order law and both idempotent sweeps
  (ADR-0172, ADR-0173); replace browser IndexedDB blobs with OPFS raw files.
- Enable the maintained blob staging write-order fault cases now that they
  exercise real storage owners.
- Route the realtime overlay through the same authority acceptance operation;
  it earns no second acknowledgement path.

### W4: Lens API, complete caller migration, and Workspace deletion

W4 has three standalone rollback checkpoints. Do not combine import cut,
verification, and deletion into one commit.

#### W4A: build the complete replacement and migrate callers

- Implement `defineLens`, `defineTable`, `defineValues`, `parseLens`, `bind`,
  classified reads, value property access, subscriptions, and the status and
  parked observation surface, including the W3 document and blob operations.
- Build the runtime supervisor: one lifecycle owner for attachment,
  credentials, wakeups, independent fact and submission drains, backoff,
  status, and disposal. Implement the one-time first-attachment gate.
- Migrate retained callers from their composition roots inward: apps/epicenter,
  apps/whispering, packages/skills, apps/honeycrisp, packages/chat,
  packages/app-shell, packages/svelte-utils, packages/ui, packages/server,
  packages/cli (decide data-backed mounts versus retirement before this wave
  ends).

#### W4B: stop imports and prove the replacement

- Stop every import of `@epicenter/workspace` and the old exchange path while
  leaving the old code on disk. Verify typechecks, maintained suites, and the
  retained application smoke paths against only the replacement.

#### W4C: remove the old path

- After verification passes, delete `packages/workspace` and the old exchange
  path, then sweep stale exports, tests, examples, docs, and manifest
  dependencies.

Implementation checkpoint (2026-07-22): the retained Epicenter, Honeycrisp,
and Whispering composition roots now use only record Lenses and the Data-owned
scalar, document, blob, attachment, status, and disposal surfaces. The API
package stopped declaring the old dependency before deletion. The repository
then deleted `packages/workspace`, its lockfile and patch residue, obsolete
current guides and examples, and the Workspace-specific agent skills. Package
tests pass against the replacement; the sole full-suite failure is the
compiled-host smoke fixture's fixed port being occupied by an installed
Epicenter process, not a data-path failure. No compatibility barrel remains.

### W5: snapshot capture and the Home query artifact

- Ship snapshot capture in the first Home release. The release includes
  `captureSnapshot` plus a minimal way to open or query the artifact; a
  polished SQL console is explicitly deferred.
- Implement `captureSnapshot` on the store owner: one read transaction, the
  visible-state fold in owner code, `_epicenter_records`, document and blob
  metadata columns, `_epicenter_artifact(kind='snapshot')`, and selected-Lens
  views with the capture-time collision refusal.
- Desktop Home queries the artifact through a separate read-only handle;
  browser Home receives transferred bytes and never opens a second OPFS
  connection.
- Home live surfaces (table browser, status, parked work) use typed
  operations only. Delete every live-session, TEMP-view, and busy-refusal
  surface from Home plans.
- The snapshot capture probe (capture time and one-transaction consistency at
  the 100k envelope) gates this wave; it is a product charter, not a physical
  layout selector.

Implementation checkpoint (2026-07-22): the replica now captures one coherent
visible-state cut into a self-identifying SQLite artifact, with raw records,
document and blob metadata, and optional Lens views. The 100,000-record probe
completed repeatedly in under one second while a concurrent source mutation
proved the read cut stayed coherent. Desktop publishes artifacts by atomic
rename and reaps ephemeral crash debris. The browser owner transfers inert
bytes without exposing capture on the application Epicenter API; Chromium and
WebKit OPFS evidence pass. Home holds only opaque artifact IDs, runs bounded
read statements in a disposable child process with a two-second deadline, and
offers the first-release capture and query sheet. The sheet passed typecheck,
build, and UI-boundary gates; visual browser inspection was unavailable in the
current Codex environment and remains a manual presentation check rather than
a storage correctness gap.

### W6: portable Backup and Restore

- Implement the authority-side capture: bounded catch-up then brief quiesce,
  the durable pin manifest with explicit success/cancel/crash transitions,
  authority-side document composition, pin/copy/verify/seal for blobs, and
  publish-only-when-complete (ADR-0167, ADR-0170).
- Implement Restore: validate only `kind='portable'`, construct the successor
  authority, atomically activate, refuse the superseded lifetime, and prove
  replicas erase and reacquire. Restore never emits ordinary intents.
- Inject failures during capture, validation, streaming, construction,
  activation, and reacquisition; race in-flight operations against
  activation.

Implementation checkpoint (2026-07-22): Bun and Cloudflare now capture sealed
accepted authority cuts into portable artifacts, stream records and verified
blob bytes through bounded materializers, publish only complete registry
entries, and stage resumable uploads. Restore validates only portable
artifacts, constructs a fresh authority lifetime, atomically activates it, and
refuses the superseded lifetime. Failure injection covers capture, staging,
validation, materialization, activation, idempotent retry, cleanup, and the
outgoing-lifetime race. Bun supports both directory and tar transport;
Cloudflare materialization runs through the Container boundary without giving
the application data plane an artifact protocol.

### W7: Proposal prototype, then ADR, then product

- Durable decision:
  [ADR-0178](../docs/adr/0178-proposals-are-source-bound-artifacts-that-disappear-after-local-admission.md).
- Run the bounded nine-test prototype (scratch code, bun:sqlite, no UI): a
  ~20-address proposal over one table and one values collection with
  creations, deletions, unknown fields, and a filtered base ledger;
  disjoint-versus-same-field concurrency; crash-at-every-k Apply resume from
  the lagging watermark; the parked-overlay trap that kills any
  skip-if-matches optimization; duplicate Apply convergence; consumption
  while the pending lane still owes; source-fence refusal (Restore and
  replica remint) before and during Apply; creation idempotency under
  interleaved deletion plus collision refusal; tamper refusal via schema and
  HMAC verification.
- Record keys for proposal-created records are minted at draft time (the
  friendly table's key column defaults to a 24-character lowercase hex mint),
  so drafts self-reference and Apply re-emits stable keys idempotently.
  Apply re-emits every manifest change unconditionally as ordinary typed
  writes; review classification never changes Apply semantics.
- If the prototype passes, write the Proposal ADR (artifact kind, lifecycle,
  compiler boundary, fences, refusals), then build the product. If any test
  demands per-change receipts, a second outbox, or proposal state that
  outlives local admission, the design is falsified; stop and redesign.
- Scheduling: after W6. Nothing in W1 through W6 depends on its outcome.

Implementation checkpoint (2026-07-22): the bounded SQLite prototype passed
its concurrency, crash-at-every-boundary, duplicate admission, parked-overlay,
source-fence, creation-collision, consumption, and tamper cases without needing
a Proposal replica, receipt log, or second outbox. `@epicenter/data` now owns
sealed draft compilation, authenticated incremental admission, recovery, and
artifact cleanup. Desktop Home publishes a closed compiled-Lens catalog and an
explicit create, compile, review, Apply, and Delete sheet. Failed incremental
Apply refreshes authenticated progress before another action, or invalidates
the catalog when that refresh fails. [ADR-0178](../docs/adr/0178-proposals-are-source-bound-artifacts-that-disappear-after-local-admission.md)
is Accepted. The sheet passes typecheck, build, UI-boundary, service, and host
tests; visual browser inspection remains a manual presentation check in the
current Codex environment.

## Deletion ledger

```txt
row/value address kinds, two-address wire unions, eight kinded shapes
flat qualified keys + prefix parsers, redundant key properties
reserved __epicenter_kv giant row, installed_guards relation
outbox append log, negative-row witness, in-memory sealBatch
hasPendingAddress discard branch, fork-recovery renumbering
document_updates unbounded log, separate facts/intents/parked relations
coordinate-normalization dictionary + joins, 4-layout benchmark matrix
defineValue-per-singleton + anonymous values bag
the live SQL inspection session and its owner-side executor
TEMP friendly views + create/drop lifecycle + owner-side identifier quoting
one-active-session exclusivity + typed busy refusal
_epicenter_rows / _epicenter_values (collapsed into _epicenter_records)
document composition duty on ordinary inspection
the materialized visible-state column (refused with a recorded reason)
ambiguous applyable-snapshot semantics (artifact kinds are structural)
the Workspace/SQLite experiment stack and its inspection hooks
defineWorkspace, WorkspaceId, defineDatabase, database catalogs and aliases
Device/Account parallel stores, adoption modes, rekeying, protocol floors
push/pull/acquire as public operations, retention floors, lineage recovery
application SQL escape hatches, projection DTOs, workspace compatibility barrel
```

## Recognition criteria

The destination exists when:

- Either owner's database shows the ADR-0177 relations plus `meta`, and one
  `SELECT` by triple answers: authority truth, in flight, wanted, refused,
  owed.
- Killing any process at any statement boundary and reopening never scans
  visible state to rebuild an obligation, never re-adjudicates, and never
  mints a new replica ID.
- A new write during an in-flight submission provably cannot change that
  submission's retry bytes.
- The wire carries one fact shape and four operations; no kind, no flat key,
  no sentinel.
- Home renders live tables and parked work with zero SQL; ad hoc SQL happens
  only against a file whose `_epicenter_artifact.kind` says what it is; no
  artifact is ever accepted as a different kind.
- An agent bulk edit reaches the live store only as ordinary typed writes
  admitted from a sealed, source-bound, reviewed manifest, and the proposal
  file is gone afterward while the pending lane still owes the authority.
- Restore is the only operation that replaces the Epicenter, and it never
  emits an intent.

Violations proving drift:

- A guard, receipt, checkpoint, or batch relation reappears; any relation
  repeats the triple that `records` owns; an authority branch on collection
  kind.
- A TEMP view, inspection session, or second live SQL surface reappears.
- A materialized visible-state column appears without a non-inspection buyer.
- A snapshot gains apply semantics, or a Proposal survives its consumption.
- A compatibility reader for any pre-destination schema outlives its wave.

## Open decisions after the freeze

1. **Lens discovery and activation.** Where app-bundled and standalone Lens
   artifacts live, and what uninstall removes. Provenance never enters data
   addresses.
2. **Structured record references.** The exact pure JSON table metadata shape
   and typed navigation ergonomics for ADR-0169's non-enforcing references,
   plus the Matter replacement, before deleting `field.reference()`.
3. **Realtime row-document topology.** Fixed-address socket per open record,
   multiplexed connection, or no dedicated overlay until a collaborative
   surface ships.
4. **Physical layout charters (ADR-0177).** Their outcome can swap the store
   schema in W1/W2 without touching W4+ surfaces.
