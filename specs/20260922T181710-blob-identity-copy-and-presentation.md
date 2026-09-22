# Store-owned blobs, immutable copy, and private presentation

- **Status:** Draft
- **Date:** 2026-09-22

## Assignment and scope

Implement the API described by ADR-0372, ADR-0380, ADR-0419, ADR-0423,
ADR-0426, and ADR-0427. Do not migrate Whispering or other product workflows.
Server/client/native transport changes needed to implement this API are in
scope. Product recording schemas, layouts, contexts, and inference are not.

The checkout contains substantial concurrent work. Capture status, diffs, and
untracked files before edits. Work in an isolated implementation checkout with
the required reviewed baseline, not merely a clean HEAD that omits uncommitted
dependencies. Do not overwrite, commit, or stage unrelated changes.

The API ownership cut breaks current app composition: Whispering opens Local
and LocalBlobs separately. Keeping a second public opener or a registry-backed
compatibility wrapper would preserve two ownership models. Complete the API
without that bridge; list deferred consumer failures explicitly. This milestone
is not application-integrated or merge-ready. If a green whole-repo build is
required, obtain authorization for a separate atomic product composition cut
rather than silently migrating apps or stopping at internal preparation.

## Settled contract

- Every Local and Personal store owns tables, KV, and blobs under one captured
  scope. Different definitions may declare different schemas. A Personal
  recording can contain only text; it need not contain a Local audio BlobId.
- Local is device-profile-owned across account changes. Personal captures its
  account before asynchronous work. Shared is deferred with no exports or
  speculative types.
- Borrowed blobs have no public close or separate admission signal. The store
  owns joint readiness, admission, and terminal shutdown.
- Recorder construction is independent and borrows local.blobs. Its destination
  must already be acquired; capture cannot outlive it.
- add creates an ID. copyFrom preserves exact bytes and ID. Local accepts Local
  or Personal sources; Personal accepts Local. Personal-to-Personal is deferred.
  Sources must be real supported handles, not structural get-method objects.
- get reads complete bytes, open returns a disposable BlobSource, and delete
  removes one placement. Local retains stat/list; no symmetry-driven remote list.
- No public put, upload/download aliases, destination-ID override, automatic
  sync, row-delete cascade, generic transfer engine, or compatibility registry.
- Row creation/copy and blob publication are not atomic. Copied bytes can survive
  row failure. Uncertain publication preserves the ID and destination scope for
  reconciliation, including add when a response is lost.

## Evidence at handoff

Current source still has standalone openLocalBlobs/openRemoteBlobs, a private
publication path for recorder Stop, and remote upload that asks the server to
mint a fresh ID. Remote open buffers the complete Blob. The server GET does not
deliver Range. S3 conditional create rejects occupied keys but does not establish
byte equality. These are implementation gaps, not spelling changes.

Current store opening captures account transport and preserves namespace claims
on uncertain cleanup. createMemoryStoreRuntime isolates fake IndexedDB without
global mutation. StoreRuntime is already concrete, not runtime-generic.

Read the relevant READMEs and source:

- packages/app/src/{open.ts,open-store.ts,store-runtime.ts,testing.ts,blobs.ts,
  blob-destination.ts,recorder.ts}
- packages/app/src/{open-store.test.ts,independent-blobs.test.ts,
  import-boundaries.test.ts,blobs.test-d.ts,recording.test.ts,blob-retirement.test.ts,
  product-startup.test.ts}
- packages/blobs/src/{owner.ts,blob-local.ts,blob-remote.ts}
- packages/client/src/index.ts
- packages/server/src/routes/blobs.ts and its concrete object-store adapters
- Native recorder/file-copy/relay implementations reached from those entrypoints
- apps/whispering/src/lib/whispering/resources.ts as read-only consumer evidence

Commands run during the design review:

```sh
bun test --isolate packages/app/src/open-store.test.ts packages/app/src/independent-blobs.test.ts packages/app/src/import-boundaries.test.ts
bun scripts/check-doc-hygiene.ts
```

The first passed: 25 tests, 89 assertions, zero failures. This proves only the
old implementation. The second reported 65 issues at the task-start baseline.
Re-run and attribute differences; do not promote Proposed ADRs to hide failures.

## Execution stages

At each gate apply adversarial-review to the cumulative implementation and
remaining plan. Use two independent read-only reviewers with raw source,
callers, the task-start baseline, and verification. A lighter reviewer is
permitted. Keep the surface stable until both initial verdicts, adjudicate
against live evidence, repair within scope, update this plan, then continue.
Ask what stronger invariant removes code, not merely whether tests pass.

### 0. Pin contracts and prove risky transport assumptions

Capture the baseline and write an acceptance matrix. Prototype private media
delivery through a package-level browser/WebView harness, without Whispering.
Select an object-addressed immutable publication protocol and a concrete
occupied-ID equality mechanism. Existence alone never proves equality.

Choose and record a private media mechanism for each supported runtime. Prove
how later HEAD/Range requests retain the original account, expiry, disposal,
and retirement policy. Account has no public retirement signal today. Do not
invent one in examples or promise revocation that the transport cannot enforce.
If a policy would permit access after sign-out or change privacy semantics,
stop for that decision before dependent work. Do independent publication work
while unrelated proof is pending.

Gate: challenge protocol complexity, source matrix, retained compatibility
promises, account authority, and which abstractions the evidence actually needs.

### 1. Put acquisition and terminal lifetime on stores

Implement required blobs on Local and Personal. Capture scope once before await.
No store escapes until its document and required Local blob storage are ready.
Personal acquires captured remote access without a network health probe.

On failure settle every started acquisition, including late success, preserve
opening and cleanup errors, and release claims only when known safe. Fence
document and blobs synchronously before awaiting close; preserve committed
bytes and pending cached edits. Unknown cleanup retains exclusion. Preserve
recorder admitted Stop and private publication during drain.

Account retirement ends network authority, not the cached Personal store.
The product owns departure/closure; do not invalidate document generation on
sign-out or outage. Never retarget handles to a successor account.

Extend the concrete isolated test runtime with required blob bindings. No
ambient production fallback, global fake storage, fake microphone success, or
universal resource container. Remove standalone public blob ownership. Record
deferred app import/startup failures instead of editing those apps.

Gate: test both acquisition orderings, late completion, cleanup rejection,
retained methods, close idempotence, recorder Stop, and two-runtime isolation.

### 2. Implement immutable creation and explicit copying

Wire add and copyFrom end to end through adapters, server, client, and native
transport. Mint IDs before publication. Atomic create must never replace an
occupied identity; verified identical retries succeed and different bytes
conflict. Preserve source snapshots and complete publication under deletion
races, cancellation, and acknowledgment loss.

Track transfer against both owning stores. Closing one settles its admitted
transfer but leaves the other usable. Preserve real source provenance and
native file streaming; a custom binding cannot select a same-named native file.
Never forward destination credentials to a source server.

Gate: verify all three supported directions across namespaces, occupied keys,
exact bytes and ID, interrupted publication, uncertain outcomes, account
retirement, source deletion races, and native descriptor cleanup. Review error
types and helper organization for unnecessary generic/wrapper layers.

### 3. Finish private presentation

Use the stage-0 mechanism. open returns usable disposable access without a
persistent Local copy or full-body completion prerequisite. Verify subsequent
requests, seek, pause/expiry, 206/416, HEAD, lengths, object-version consistency,
and closure/account behavior in actual target browser/WebView environments.

Preserve authorization, nosniff, safe untrusted content handling, and the
distinction between temporary playback credentials and durable references.
Do not relax attachment/sandbox protections indiscriminately. Keep payload
limits explicit; the current 25 MiB cap and full-body upload are not proof of
large-video support. Measure first-play latency and buffering, not just URL shape.

Gate: challenge whether delivery accidentally introduced a cache manager,
persistent copy, unbounded memory path, or successor-account access.

### 4. Collapse, verify, and hand off integration

Keep the definition generic for inferred tables/KV. Do not add runtime/schema
generics to blobs, abstract source stores, generic transfer graphs, or Shared
placeholders. Inspect forwarding-only open.ts and helpers. Relocate or inline
only when ownership becomes clearer. Preserve provenance checks, admitted-work
tracking, raw adapter contracts, and administrative listing used by real callers.

Sweep active ADRs, package exports, examples, type tests, and plans for the old
ownership model. Historical/rejected ADR bodies stay historical. Accepted
decisions change through amendment metadata and new records. Do not change
statuses automatically. Keep READMEs accurate about what now exists.

Run relevant package tests/typechecks and browser/native evidence. Separate
API failures from named deferred app consumers; do not delete integration tests
to manufacture a green result. Complete a cumulative adversarial review and
local post-implementation review. Report evidence, deferred integration, and
any real blocker. Delete spent specs per repository policy only after completion;
preserve durable decisions in ADRs.

## Done

The concrete API, immutable protocol, and private presentation satisfy their
acceptance evidence; public aliases and duplicate owners are gone; review
findings are resolved or named with their smallest missing decision. Whispering
is untouched and its follow-up composition cut is explicit. No deployment,
commit, PR, data migration, Shared implementation, or privacy-policy expansion
is authorized by this plan.
