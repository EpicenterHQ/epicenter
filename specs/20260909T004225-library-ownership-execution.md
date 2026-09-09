# Execute Local, Personal, and Shared libraries

Date: 2026-09-09
Status: In Progress

Each application opens Local, Personal, or Shared data through the three agreed methods, with the signed-in person and selected library kept distinct throughout storage and sync.

This is the working implementation plan for [ADR-0375](../docs/adr/0375-library-ownership-is-local-personal-or-shared-within-one-deployment.md). The public opening API is selected; the storage and self-hosted mechanisms are not implemented. Checkpoint 1 now has a reproduced race and a test-only contract slice. Its independent review is resolved; production implementation still depends on selected-runtime proof and the product choices below.

Completion means two named users have separate Personal libraries and converge on one Shared library per application on the same server, including simultaneous first opening and attachments. Matching user IDs on another server never join those libraries. Local remains usable without sign-in. Each document holds one primary App and closes before replacement.

## Read in this order

1. ADR-0375 for the product and public API decision.
2. This spec for the next checkpoint and completion evidence.
3. The [independent review](20260909T062714-library-ownership-api.review.md) when investigating a boundary or the reason for a proposed simplification.

The [original design handoff](20260909T062714-library-ownership-api.handoff.md) retains earlier context and baseline notes. Its request to choose between opening APIs has been resolved. The older one-active-account specs describe an interrupted token-selection implementation; do not resume that target by default.

## Current and target shape

Current `packages/app/src/index.ts` exposes:

```ts
application.openLocal();
application.openAccount(account);
```

The target, with each call illustrating a separate opening, is:

```ts
application.openLocal();
application.openPersonal(account);
application.openShared(account);
```

Keep the same App data methods, readiness, and close contract. `openPersonal` replaces `openAccount` without an alias. Both server-library openers receive an established Account. Shared does not change Alice into a shared principal. No public destination-object opener or LibraryManager is required.

The current implementation still derives server partitions and most local resources directly from account identity. `createSessionAuth` also supplies the fixed Cloud authority ID. The first-open flow lists generations before creating one; independent devices can both observe an empty list. The Worker self-hosted entry has store synchronization, while the Bun entry does not. These observations were checked against source on 2026-09-09; no build or behavior test was run for this planning pass.

## What is decided and what needs judgment

| Boundary | Direction | What remains |
| --- | --- | --- |
| Public API and vocabulary | Three verbs; Account is the actor; Local/Personal/Shared name libraries | Implement ADR-0375 without reopening equivalent API encodings |
| Shared access | Every admitted self-hosted user has full content read/write access | Concrete admission, sessions, removal, and recovery |
| App lifetime | One primary library per document; close before replacement | Picker and navigation integration |
| Client account selection | Many server users do not imply a credential wallet | Installation configuration and reconfiguration workflow |
| Library choice across apps | Review recommends per-window selection, with one desktop Account/server | Product choice before desktop picker behavior is implemented |
| Local Shared cache | Review recommends separate actor-bound caches/outboxes for Alice and Bob | Validate the address contract before adopting it durably |
| Server library scope | Review recommends app-scoped Shared data and blobs | Exact address/wire layout, including dataId and historical Personal storage |
| Self-host runtime | Recommend Worker for the first complete slice because it already has store sync | Product choice: Worker-first delivery or add Bun sync before completion |
| Initial/default library | No automatic copy or migration; outages never switch libraries | First-run selection and remembered-choice behavior |

The implementation agent can resolve internal mechanics from evidence. Bring product choices back with a recommendation only when dependent work reaches them. They do not block reproducing the generation race or investigating ownership. When a new ownership or protocol decision settles, record it in an ADR before building dependent waves. Do not silently turn review recommendations into accepted decisions.

## Checkpoint 1: prove the foundation

This bounded session's outcome is a reproduced failure, a concrete proposed contract, and a reviewed implementation slice. It does not require choosing a production sign-in provider.

- [x] Re-read live symbols and relevant nested instructions. Inventory current changes and establish an exact baseline; HEAD alone does not establish authorship in this worktree.
- [x] Trace Account through app construction, sync, blobs, SQLite, library claims, recording recovery, and local erasure. Update the review's caller map where live work changed it.
- [x] Reproduce concurrent first opening with two independent device caches. Do not use two calls sharing one browser Web Lock as the decisive test.
- [x] Specify the server operation that selects one initial generation atomically, separately from explicit imports. Name the owner of reservation, initialization, admission, retry, and crash recovery. Preserve offline cache-first opening and established generation history.
- [x] Show concrete actor, remote library, and local replica addresses for Alice and Bob on servers A and B. Include document, blob, SQLite, recording, and lock scopes. Preserve existing Cloud authority bytes and explicitly identify any other durable-address change.
- [x] Exercise proposed library authorization with a test-only principal resolver using named Alice/Bob identities. Reject anonymous Shared, unsupported Cloud Shared, and another user's Personal destination. This is contract evidence, not completed named-user authentication.
- [x] Obtain an independent design review of this concrete slice through `design-review`; adjudicate its findings and record the next implementable checkpoint. Keep new public contracts out of production until their ownership is resolved.

Exit evidence: the cross-device race is reproduced, the proposed initial-generation operation cannot publish two defaults or a partial default under the tested failures, and the address examples keep actors and destinations distinct. Record which evidence comes from a test-only prototype and which from production code. A passing mocked resolver test does not complete the self-host sign-in requirement.

## Checkpoint 2: named users on one server

- [ ] Reconcile `apps/self-host/AGENTS.md` with the accepted named-user direction as part of the implementation; its token-only prohibitions describe the previous target.
- [ ] Choose the first complete runtime and a concrete self-host admission/sign-in/recovery flow. Present the minimum operator setup and a user's first sign-in before selecting infrastructure.
- [ ] Separate generic Account/session lifetime from Cloud issuer identity and dashboard links. Verify external authentication-library behavior against installed code/types or official documentation before relying on it.
- [ ] Implement user-bound sessions and removal without importing Cloud billing into self-hosting. Preserve the actor during Shared access.
- [ ] Define and test removal for new requests, existing sockets, issued blob tickets, and in-flight operations. Do not claim immediate invalidation or remote erasure of offline copies without those guarantees.
- [ ] Preserve same-owner credential repair, offline identity restoration, Account retirement, and host credential brokerage.

Exit evidence: actual sessions for Alice and Bob authorize the expected destinations on the selected runtime. Removing Alice blocks future authorized access according to the documented lifetime; Bob remains admitted. Server B with matching IDs retains a separate identity namespace.

## Checkpoint 3: one library binding across resources

- [ ] Record the reviewed foundation decisions in ADRs before dependent production work. Implement the atomic `/initial` operation in the selected runtime, including authority initialize-if-absent and canonical-snapshot fetching. Add the missing socket-admission check before forwarding to the authority; preserve the existing bootstrap GET gate. Prove it with independent clients submitting different seed bytes, both caching the canonical winner, restart/failure injection, rejected sockets never reaching the authority, payload limits, offline opening, and explicit import history.
- [ ] Implement the selected address contract at App construction. Thread it through data and every capability that stores or recovers library-owned state.
- [ ] Use the same authorized destination for generation operations, live sync, blob upload/read/delete, and their desktop forwarding paths.
- [ ] Keep Account-bound inference and Cloud billing attached to the actor. Library selection must not impersonate a different customer.
- [ ] Prove Alice's pending Shared outbox cannot be submitted as Bob after account replacement. Prove local cache removal addresses only the selected replica.
- [ ] Preserve historical data bytes. Prepare an explicit `instance` export/import boundary with referenced attachments and source preservation; do not execute a migration or assign that data to the first named user.

Exit evidence: two independent clients converge on Shared rows and attachments; Personal, Local, other apps, and other servers stay at their intended addresses. Storage locks, physical closure, recording recovery, and erasure agree on the selected library.

## Checkpoint 4: application callers and selection

The current Honeycrisp and Vocab declaration tails in `apps/honeycrisp/src/lib/application.ts` and `apps/vocab/src/lib/application.ts` are:

```ts
}).openAccount(account);
```

Their Personal path becomes:

```ts
}).openPersonal(account);
```

Their Shared path uses `.openShared(account)` with that same captured Account. Both apps currently gate opening on identity; delivering Local availability requires an explicit signed-out boot path as well as this rename. Preserve the current application declaration and platform composition rather than copying older constructor examples from the review.

Whispering's current choice in `apps/whispering/src/lib/bootstrap.ts` is:

```ts
account === null
  ? application.openLocal()
  : application.openAccount(account);
```

Once the boot path has parsed and validated the chosen library and required identity, its corresponding calls are:

```ts
application.openLocal();
application.openPersonal(account);
application.openShared(account);
```

These are three separate branches, not three concurrent primary Apps. An unavailable Account for Personal or Shared leads to the appropriate sign-in/recovery state, never an implicit Local fallback. Remove obsolete `auth.method` recovery assumptions as the real startup contract is integrated.

- [ ] Resolve picker scope and first-run/default behavior before implementing the selection UI.
- [ ] Expose the selected library through document bootstrap. Feature code continues to borrow the same concrete App.
- [ ] Reuse departure for producer drain, physical close, and fresh navigation. A library change need not retire an unchanged Account.
- [ ] Keep host-wide account/server replacement behind all affected windows' close barrier. Callback and auxiliary routes open no primary library.
- [ ] Test preflight refusal, failed close, failed navigation/relaunch, unexpected Account retirement, and same-person credential repair.

Exit evidence: a person can deliberately open each offered library in each store app, restart into the intended library, and change libraries without mixing data or replacing an App in place.

## Checkpoint 5: prove, remove, and document

- [ ] Run the focused tests, relevant package/app typechecks, browser storage tests, Worker integration tests, and desktop smokes appropriate to the implementation. Discover current scripts through package manifests and the `monorepo` skill; record exact commands and results.
- [ ] Stop importing the old `openAccount` and token-selection paths. Verify all affected consumers on the replacement path while the unused code remains available for comparison.
- [ ] Delete the obsolete public name, token-entry branches, expected-`instance` assertions, and stale UI only after the replacements pass. Preserve baseline lifecycle tests and adapt them to the new composition.
- [ ] Update package READMEs and runtime instructions to describe shipped behavior. Reconcile the interrupted specs without attributing or deleting unrelated user work.
- [ ] Apply `post-implementation-review` locally. Use `design-review` for materially new ownership questions, following `spec-execution` checkpoint cadence rather than requesting repeated reviews of the same settled decision.

Completion is local implementation plus verification on the explicitly selected supported runtime(s). Deployment, data migration, source erasure, and automated account/deployment deletion are separate operations. If Bun support remains deferred, the final report and self-host README must say so. Whole-library physical purge and later Shared rebuild policy must not be presented as completed merely because normal shared content deletion works.

## Carry the work across sessions

Use this file as the single working plan. At each checkpoint, replace the short progress entry below with the completed slice, exact verification evidence, unresolved decision, and next concrete action. Keep explanations of durable decisions in ADRs and detail needed only for investigation in the review. A handoff should point here and state the current checkpoint; it should not duplicate the plan.

Current checkpoint: 1 complete as test-only foundation evidence. Independent design review resolved. Next: checkpoint 2; production Shared and named-user authentication remain unbuilt.

Baseline: HEAD `2dee4a2cbea98c02f5d22bff7a6a25a9a7929def`, plus the pre-existing dirty worktree. Before editing, recorded status, tracked binary diff, and SHA-256 hashes of tracked/untracked files in `/tmp/library-checkpoint-1/{status.txt,baseline.patch,files.json}`. Task ownership is the two new evidence directories below and updates to this spec and the existing review. No production files were edited or staged by this task. Hash comparison also detected concurrent edits outside this task, including recorder lifecycle files, related ADRs, and Local Mail specs; they were left intact. The caller map was rechecked against the changed recorder ownership.

Evidence:

- `packages/data/evidence/library-ownership/device.ts` runs the live `resolveGeneration` in its own process with independent fake IndexedDB and Web Locks. Two processes reach the live `mountStoreSyncApp` through loopback HTTP with test storage, both observe an empty list, receive generations 1 and 2, and reopen those separate caches offline. This reproduces the production algorithm's race; it is not a deployed Worker test.
- `packages/server/evidence/library-ownership/initial-generation.ts` is a two-SQLite-file prototype. Twelve interleaved initializers select one generation. Reopening the files after reservation, snapshot, and admission preserves one default, rejects absent/empty snapshots, hides unadmitted state, and refuses late overwrites. It preserves historical admitted generations and abandoned import numbers. This models durable boundary failures; it does not prove workerd crash behavior.
- `contract.ts` and `foundation.test.ts` exercise named Alice/Bob authorization and the actor/library/replica address matrix. Cloud authority and historical Personal bytes remain unchanged in the candidate. Test-only bearers are not named-user sign-in.
- `bun test packages/server/evidence/library-ownership/foundation.test.ts packages/data/src/store/browser.test.ts packages/server/src/store-sync/browser-dial.test.ts`: 51 passed, 0 failed, 210 assertions. Includes nine new foundation tests and the existing discovery/dial coverage.
- From `packages/server`: `bun x tsc --noEmit --strict --noUncheckedIndexedAccess --skipLibCheck --target esnext --module preserve --moduleResolution bundler --types bun,@cloudflare/workers-types --lib esnext,dom,dom.iterable evidence/library-ownership/foundation.test.ts ../data/evidence/library-ownership/device.ts`: passed. This explicitly checks the new evidence entrypoints, which the package's normal `src` include does not cover. Preliminary invocations omitted strict checking or Worker types; the corrected command above passed.
- `bun x biome format packages/server/evidence/library-ownership packages/data/evidence/library-ownership`: four files checked, no fixes needed. The transaction API was checked against installed `bun-types/sqlite.d.ts`; failures inside an uncommitted SQL transaction were not injected.
- `bun scripts/check-doc-hygiene.ts`: exit 1, 39 ADR issues outside the task-owned files. No spec was retired in this checkpoint. No task-start hygiene run exists, so this is a current repository result rather than a claimed baseline comparison.

Review adjudication: accepted the missing WebSocket-admission finding and added a live-route reproduction; accepted the distinction between server storage namespaces and HTTP paths and repaired the prototype/documentation. The independent reviewer retained the three openers, ledger/authority ownership split, and App-bound resource addressing. No further structural rewrite was justified. Local post-edit inspection covered all four evidence files and both documents. Production socket gating, canonical-seed adoption, actual runtime crash behavior, and sessions remain explicit dependencies rather than implied by the prototype.

The [checkpoint investigation in the review](20260909T062714-library-ownership-api.review.md#checkpoint-1-investigation-2026-09-09) holds the live caller map, proposed wire operation, failure owners, exact address templates, durable-byte exceptions, and evidence limits. It is supporting investigation; this spec remains the execution plan.

Next checkpoint: 2, named users on one server. Start by presenting the minimum operator setup and first sign-in flow, recommend Worker-first delivery because Bun still lacks store sync, and obtain the product choice before dependent auth implementation. Do not pick a provider silently. Before integrating the foundation into production, record its reviewed decision in ADRs and prove it on the selected runtime; checkpoint 3 now explicitly includes this missing production operation. Picker scope/defaults remain checkpoint 4 choices.

After the implementation is complete, move any remaining durable decisions into ADRs, record the completed spec in `docs/spec-history.md`, and delete spent planning artifacts. Leave no second competing execution plan.
