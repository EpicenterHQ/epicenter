# Store-owned blob API review

Date: 2026-09-22. Design and documentation review; no runtime implementation.

## Evidence inspected

```text
docs/adr/
  0149, 0173 metadata; 0349, 0366, 0372, 0373, 0375, 0376, 0380,
  0392, 0393, 0399, 0401, 0406 metadata, 0419, 0421, 0423, 0426, 0427
packages/app/
  README.md, ARCHITECTURE.md, package.json
  src/open.ts, open-store.ts, store-runtime.ts, testing.ts
  src/blobs.ts, blob-destination.ts, recorder.ts, platform/documents.ts
  store/blob/recorder/type/import-boundary/product-startup tests
packages/blobs/
  README.md, src/owner.ts, blob-store.ts, blob-local.ts, blob-remote.ts
  concrete browser/native adapters and remote tests
packages/auth/src/
  auth-contract.ts, create-session-auth.ts
packages/client/src/
  index.ts, index.test.ts
packages/server/src/
  routes/blobs.ts, routes/blobs.test.ts, s3-blob-store.ts
apps/
  epicenter native recorder/upload relay
  whispering resource composition, read-only
specs/
  blob-identity-copy-and-presentation plan and handoff
  page-owned-resources plan and handoff
  whispering-recording-workflow
```

Two fresh read-only reviewers examined the same design independently. One used
the default model, one a lighter model as permitted. Neither changed files or
ran tests. The coordinator checked their findings against source and applied
documentation repairs.

## Decision

Retain store-owned blobs. One scope and terminal store lifetime removes public
blob constructors, child close/signal ownership, repeated namespace selection,
and duplicate product teardown. The cost is that document acquisition failure
prevents blob access, and store close ends dependent capture and presentation.

Strengthen joint acquisition: settle all started work, including late success,
preserve primary and cleanup errors, fence children before awaiting cleanup,
and retain exclusion after uncertain release. Personal opening must not gain a
remote health probe. Extend isolated test bindings, not ambient global storage.

Distinguish Account network retirement from cached Personal lifetime.
Product departure owns closure; generation invalidation is a different event.
Neither account change nor outage deletes pending edits or retargets handles.

Narrow copying to Local <- Local/Personal and Personal <- Local. Remove
speculative remote-to-remote and Shared types from initial implementation.
Retain real-handle provenance and native streaming. Preserve the definition
generic needed for tables/KV; introduce no blob/runtime/source generics.

The remote protocol must change beyond method renaming: destination-selected
IDs, atomic immutable publication, verified occupied-key equality, and uncertain
outcome receipts. Private presentation requires a proven authorization and
Range path; current buffering does not satisfy the target.

## Disagreement and adjudication

Both reviewers recommended internal-only preparation until an atomic app
cutover. That would preserve green existing consumers but leave the user's
requested public API unfinished. The handoff instead permits an isolated API
milestone with explicit deferred consumer failures, no Whispering edits, and
no merge-readiness claim. If an integrated green build is required, a separate
authorization for the consumer composition cut is necessary. This is a rollout
constraint, not a reason to retain duplicate public owners.

One reviewer would relocate owner.ts and retain the provenance module; the
other would retain owner.ts and inline provenance. Neither file deletion is
mandated. Co-locate only when the implementation clarifies ownership while
preserving validation and admitted-work tracking. Forwarding-only open.ts is
a candidate, not a goal measured by file count.

Authenticated streaming remains in the target. Deferring its proof would leave
ADR-0427 unimplemented; the staged plan starts with a focused harness and a
policy gate instead of silently dropping it.

## Documentation repairs

Current ADRs now name joint store lifetime, the source matrix, account versus
store retirement, and current implementation gaps. Older active records 0375,
0376, 0399, and 0401 no longer prescribe aggregate App acquisition, account-
partitioned Local, schema-free public blob opening, or same-schema row copying.
Accepted/historical records receive metadata corrections only.

The blob execution plan and handoff now exclude product migration. Older
Whispering plans are marked separate assignments; their blob target sketch
uses local.blobs. Product runtime code is unchanged.

## Verification

The coordinator ran the existing focused suite: 25 passing tests, 89 assertions,
zero failures across open-store, independent-blobs, and import-boundaries.
This validates current behavior only. Initial and final doc hygiene each
reported 65 issues; the repository-wide check remains failing. Scoped
`git diff --check` passed. Relative-link validation covered 28 affected
documents with zero broken links. The stale-contract scan left only historical
or rejected-alternative mentions of aggregate opening.

## Remaining proof obligations

- All partial-acquisition orderings and uncertain cleanup.
- Supported copy pairs, exact bytes/IDs, source snapshots, conflict/equality,
  acknowledgment loss, cancellation, and native descriptor release.
- Browser/WebView private presentation, later ranges, expiry, retirement, safe
  untrusted content, and no full-body completion or retention prerequisite.
- Precise inventory of deferred product consumers after the public ownership cut.

Follow specs/20260922T181710-blob-identity-copy-and-presentation.md. Review after
each stage, resolve findings before dependent work, and end with cumulative
adversarial and local post-implementation review.
