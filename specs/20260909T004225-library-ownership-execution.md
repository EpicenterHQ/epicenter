# Execute Local, Personal, and Shared libraries

Date: 2026-09-09
Status: In Progress

Each application opens Local, Personal, or Shared data through the three agreed methods, with the signed-in person and selected library kept distinct throughout storage and sync.

This is the working implementation plan for [ADR-0375](../docs/adr/0375-library-ownership-is-local-personal-or-shared-within-one-deployment.md). The public opening API is selected. Checkpoint 1 reproduced the generation race. Checkpoint 2 now has real Worker WebAuthn enrollment and authentication evidence against a transactional admission owner. The production credential owner, HTTP session/handoff routes, shared passkey page, Bun and Worker operator commands, and browser/desktop Account composition now work. Optional passwords and library ownership remain incomplete. Storage integration is paused at the overlap with the current-generation task described below.

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

The current implementation still derives server partitions and most local resources directly from account identity. `createSessionAuth` now requires an explicit authority ID; Cloud compositions retain the fixed Cloud identity. The first-open flow lists generations before creating one; independent devices can both observe an empty list. The Worker self-hosted entry has store synchronization, while the Bun entry does not. Checkpoint evidence below records the source checks and behavior tests run on 2026-09-09.

## What is decided and what needs judgment

| Boundary | Direction | What remains |
| --- | --- | --- |
| Public API and vocabulary | Three verbs; Account is the actor; Local/Personal/Shared name libraries | Implement ADR-0375 without reopening equivalent API encodings |
| Shared access | Every admitted self-hosted user has full content read/write access | Concrete admission, sessions, removal, and recovery |
| Self-host sign-in | Passkeys by default; operator-enabled passwords; recovery preserves the same user ([ADR-0383](../docs/adr/0383-self-hosted-sign-in-defaults-to-passkeys-with-optional-passwords.md)) | Prove enrollment and recovery on Worker, then implement complete optional password setup/reset |
| App lifetime | One primary library per document; close before replacement | Picker and navigation integration |
| Client account selection | Many server users do not imply a credential wallet | Installation configuration and reconfiguration workflow |
| Library choice across apps | Review recommends per-window selection, with one desktop Account/server | Product choice before desktop picker behavior is implemented |
| Local Shared cache | Review recommends separate actor-bound caches/outboxes for Alice and Bob | Validate the address contract before adopting it durably |
| Server library scope | Review recommends app-scoped Shared data and blobs | Exact address/wire layout, including dataId and historical Personal storage |
| Self-host runtime | User selected Worker first, then Bun, on 2026-09-09 | Share server behavior; implement and verify runtime storage/sync adapters, including Bun's missing sync backend |
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

- [x] Reconcile `apps/self-host/AGENTS.md` with the accepted named-user direction as part of the implementation; its token-only prohibitions describe the previous target.
- [x] Choose runtime order: Worker first, then Bun. The user selected both in that order on 2026-09-09; Bun remains required work.
- [x] Choose the self-host admission/sign-in/recovery flow: operator enrollment, passkeys by default, optional operator-enabled passwords, and recovery of the same user. The user selected this direction on 2026-09-09; see ADR-0383.
- [x] Prototype Worker passkey enrollment, authentication, and operator-assisted recovery against durable admission. Real cryptographic verification and SQLite commits prove single-use grants, same-principal recovery, credential/session invalidation, and refusal for removed users. This is isolated runtime evidence, not deployed sign-in.
- [x] Integrate the durable credential owner with real HTTP ceremonies, browser cookies, `/api/session`, application handoff, and operator tooling. Prove the no-email user contract through the existing Account client. Local Worker evidence exercises the actual deployment entry; remote Cloudflare authentication remains untested.
- [ ] Implement optional passwords with complete setup/change/reset and recovery flows.
- [x] Separate generic Account/session lifetime from Cloud issuer identity and dashboard links. The constructor now requires authority identity, and Cloud compositions attach management links. The existing bearer lifetime remains the owner. See ADR-0382 and the checkpoint 2 evidence below. Verify authentication-library behavior again when implementing the selected sign-in flow.
- [ ] Implement user-bound sessions and durable admission without importing Cloud billing into self-hosting. Admission must gate sign-in/session issuance, handoff authorization and redemption, protected requests, and socket admission. Revoking existing sessions alone does not remove admission. Preserve the actor during Shared access.
- [ ] Define and test removal for new requests, existing sockets, issued blob tickets, and in-flight operations. Do not claim immediate invalidation or remote erasure of offline copies without those guarantees.
- [x] Preserve same-owner credential repair, offline identity restoration, Account retirement, and host credential brokerage. Desktop repair retains the host Account, while the existing native close barrier closes app windows before sign-in.

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

- [ ] After the Worker slice works, implement the Bun runtime adapters and missing store-sync backend against the same server contracts. Prove named sessions, admission/removal, atomic initialization, rows, attachments, and restart behavior on Bun. Avoid a second authentication or library-ownership model.

- [ ] Run the focused tests, relevant package/app typechecks, browser storage tests, Worker integration tests, and desktop smokes appropriate to the implementation. Discover current scripts through package manifests and the `monorepo` skill; record exact commands and results.
- [ ] Stop importing the old `openAccount` and token-selection paths. Verify all affected consumers on the replacement path while the unused code remains available for comparison.
- [ ] Delete the obsolete public name, token-entry branches, expected-`instance` assertions, and stale UI only after the replacements pass. Preserve baseline lifecycle tests and adapt them to the new composition.
- [ ] Update package READMEs and runtime instructions to describe shipped behavior. Reconcile the interrupted specs without attributing or deleting unrelated user work.
- [ ] Apply `post-implementation-review` locally. Use `design-review` for materially new ownership questions, following `spec-execution` checkpoint cadence rather than requesting repeated reviews of the same settled decision.

Completion is local implementation plus verification on the explicitly selected supported runtime(s). Deployment, data migration, source erasure, and automated account/deployment deletion are separate operations. Bun is selected as the second supported runtime. Do not mark the full plan complete with Worker-only evidence; any later Bun deferral requires an explicit scope change. Whole-library physical purge and later Shared rebuild policy must not be presented as completed merely because normal shared content deletion works.

## Carry the work across sessions

Use this file as the single working plan. At each checkpoint, replace the short progress entry below with the completed slice, exact verification evidence, unresolved decision, and next concrete action. Keep explanations of durable decisions in ADRs and detail needed only for investigation in the review. A handoff should point here and state the current checkpoint; it should not duplicate the plan.

Current checkpoint: 2 in progress. The production credential owner verifies with SimpleWebAuthn and commits through Worker SQLite or Bun SQLite. Both self-host entries mount named sessions and the shared passkey page. ADR-0384 records that ownership direction. The Worker operator command and browser/desktop Account integration now work. Complete optional password flows and access/removal evidence through storage consumers remain. Production Shared and Bun store sync remain unbuilt. Generation integration is paused pending coordination with the concurrent current-generation task; its competing server replacement was backed out, leaving this task’s partial initializer in place.

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

Next action within checkpoint 2: implement complete optional password
setup/change/reset and extend removal evidence through sockets, blob tickets,
and in-flight operations. Worker operator tooling and browser/desktop issuer
composition are implemented below. Before checkpoint 3 resumes, resolve the
generation-model overlap; picker scope and defaults remain checkpoint 4 choices.

## Checkpoint 2: issuer composition evidence

The requested design review between checkpoints reconstructed self-hosted setup
and recommended this independent slice before choosing credentials or storage.
`createSessionAuth` now requires `authorityId`; `SessionAuthClient` and
`CallbackAuthClient` describe session capabilities without requiring Cloud.
`createHostedBrowserRedirectAuth` and the desktop Cloud constructor supply the
unchanged `epicenter-api` bytes and attach `createAccountManagementUrl` themselves.
The private bearer owner, persisted credential format, and retirement rules stay
intact. The decision is recorded in
[ADR-0382](../docs/adr/0382-session-composition-selects-issuer-identity-and-management-capabilities.md).
All direct test constructors now explicitly select their existing Cloud identity.

Verification baseline: checkpoint 1 commit plus the existing dirty worktree.
Task-start hashes and copies of changed source are under
`/tmp/library-checkpoint-2/`. Before this slice, `bun test packages/auth/src`
reported 120 passed and eight failures in `browser-auth.test.ts`;
`bun run typecheck` from `packages/auth` reported 22 diagnostics in that same
unchanged startup test file.

- `bun test packages/auth/src/session-authority.test.ts packages/auth/src/account-lifetime.test.ts packages/auth/src/contract.test.ts packages/auth/src/refusal-is-not-an-identity-change.test.ts`: 49 passed, 178 assertions.
- From `packages/auth`: `bun x tsc --noEmit --strict --noUncheckedIndexedAccess --skipLibCheck --target esnext --module preserve --moduleResolution bundler --types bun --lib esnext,dom,dom.iterable src/create-session-auth.ts src/hosted-browser-redirect-auth.ts src/auth-contract.ts src/session-authority.test.ts src/account-lifetime.test.ts src/contract.test.ts src/refusal-is-not-an-identity-change.test.ts`: passed.
- `bun test packages/auth/src`: 123 passed, the same eight failures; the three new tests pass. Package typecheck diagnostics match the task-start output exactly.
- `bun test apps/epicenter/src/desktop-auth-authority.test.ts apps/epicenter/src/account-transport.test.ts packages/server/src/store-sync/browser-dial.test.ts packages/app/src/sync-subprotocol.test.ts packages/app/src/ai.test.ts apps/api/ui/src/lib/dashboard/runtime.test.ts`: 57 passed, two desktop close-barrier timeouts. The saved pre-edit source snapshot reproduced the same two timeouts: `bun test apps/epicenter/src/desktop-auth-authority.test.ts` from `/tmp/library-checkpoint-2/baseline-checkout` reported 31 passed and two failed. The test fixture matched its task-start hash.

The runtime order is now selected: Worker first, then Bun, with shared server
behavior and runtime adapters for persistence and synchronization. Bun still
needs its sync backend; this is implementation work, not an existing adapter.
The user selected the sign-in policy recorded in
[ADR-0383](../docs/adr/0383-self-hosted-sign-in-defaults-to-passkeys-with-optional-passwords.md):
operator-enrolled passkeys by default, optional operator-enabled passwords, and
recovery that preserves the same principal. Applications will use the server's
sign-in page and a code/state/PKCE handoff. Password enablement follows the
passkey slice and requires complete setup/change/reset and recovery flows.
Removing a user disables durable admission and outstanding enrollment/recovery
grants without assigning or deleting library content.

The implemented issuer requires a stable HTTPS origin, durable auth storage, and
exact application callbacks. Its opaque sessions need no signing secret. Store
sync and blob bindings remain separate deployment requirements.
An operator command uses infrastructure credentials to manage people. This does
not select D1, Postgres, an operator UI, or a particular schema. The installed
passkey plugin's enrollment hooks need a prototype; the current Cloud schema's
required email must not be filled with fabricated addresses to reuse it.

Removal's proposed bound is request admission: new checks after removal refuse
access; existing sockets keep their 600-second deadline; issued blob tickets
keep their 120-second GET and 300-second PUT lifetimes. Already authorized work
may finish and offline copies remain. Capability issuance racing removal needs
an explicit rule and tests; do not claim a universal ten-minute cutoff.

The independent implementation review accepted the production boundary and
required one test repair: the hosted browser mock omitted `sessionStorage.setItem`,
so disposal logged a cancellation failure even though assertions passed. The
fixture now uses a functioning Map-backed session store. The three issuer tests
were rerun with clean disposal. Production logging and cancellation were not
weakened. Local post-edit inspection found no further issue. No additional
issuer factory, bearer export, or capability registry was justified.

The user selected Worker first and Bun next, and confirmed the credential policy
on 2026-09-09. No further credential product choice is needed to start the Worker
prototype. Database choice and runtime integration still require implementation
evidence. This issuer slice does not complete named-user authentication.

Decision-record verification: checked ADR-0383 and this spec for consistent
runtime order, credential defaults, same-user recovery, and remaining unbuilt
work. Relative links resolve and `git diff --check` passes for these documents.
This documentation update adds no runtime verification claim.

After the implementation is complete, move any remaining durable decisions into ADRs, record the completed spec in `docs/spec-history.md`, and delete spent planning artifacts. Leave no second competing execution plan.


## Checkpoint 2: Worker credential-commit evidence

The installed `@better-auth/passkey` 1.6.23 calls registration
`afterVerification` before a separate credential insert. A real-handler test
with a valid ES256 none-attestation response reproduces a consumed grant and no
credential after injected insert failure. The plugin's current documentation
includes newer session-creation behavior that is absent from the installed
source. The implementation decision follows installed behavior, not that claim.
`resolveUser` also does not create a user or session. Its no-session mode can
prefer an ambient session, so it is not a sufficient grant identity boundary.

The isolated candidate in `packages/server/evidence/enrollment/admission.ts`
owns users, admission revisions, grants, registration/authentication ceremonies,
credentials, and candidate sessions in one SQLite-backed Durable Object. It
verifies responses using SimpleWebAuthn, then rechecks durable authorization
inside the commit. Recovery invalidates access and advances the same user's
revision when the operator issues the recovery grant. Removal never restores
admission. The synthetic `complete` and inspection methods are evidence-only;
no production route imports or exposes them.

Worker evidence covers:

- Two real registration responses for one grant publish one credential/session.
- Failures after grant, credential, or session writes roll back the transaction.
- Duplicate credential insertion rolls back grant consumption.
- Unused ceremonies and committed enrollment survive object eviction. Replay
  after eviction cannot enroll another credential. This is object restart
  evidence, not a killed workerd process or simulated network response loss.
- The enrolled private key signs a valid authentication assertion after eviction.
- Recovery preserves Alice's ID and invalidates her old key, sessions, grants,
  and pending registration ceremonies. Bob remains admitted after Alice's removal.
- Removal and recovery while real registration or signature verification is
  awaiting completion prevent stale credential/session publication.
- Wrong origin, expired grant, another user, another server, and replay refuse
  access at the tested boundary.

Baseline is saved under `/tmp/library-worker-enrollment-baseline/`: HEAD,
porcelain status, tracked binary diff, hashes of tracked/untracked files, and the
starting spec. At the prototype checkpoint, task-owned changes were this evidence directory,
the direct server SimpleWebAuthn dependency and corresponding lock entry,
self-host instructions, ADR-0384, and this spec. The production slice below
adds credential, runtime, browser, management, and partial initializer files. Other dirty work remains unrelated. The independent
review compared the lockfile to the saved baseline; its other visible edits
already existed at task start.

Verification:

- `bun test packages/server/evidence/enrollment/passkey-hooks.test.ts packages/server/src/auth/plugins.test.ts`: 6 passed, 25 assertions.
- From `packages/server`: `bun x vitest run -c evidence/enrollment/vitest.config.ts`: 18 passed in workerd.
- From `packages/server`: `bun x tsc --noEmit --strict --noUncheckedIndexedAccess --skipLibCheck --target esnext --module preserve --moduleResolution bundler --types bun,@cloudflare/workers-types,@cloudflare/vitest-pool-workers/types --lib esnext,dom,dom.iterable evidence/enrollment/admission.worker.ts evidence/enrollment/passkey-hooks.test.ts evidence/enrollment/vitest.config.ts`: passed. Normal package includes do not cover these evidence files.
- `bun x biome format --write packages/server/evidence/enrollment`: formatted the five evidence files.
- The initial `bun add` reached an existing workspace `install` script that
  requires a release argument and failed. Repeating with `--ignore-scripts`
  installed the explicit dependency and saved the lockfile. No deployment ran.

Independent review retained the single durable owner and required more precise
claims: candidate sessions are not working application sign-in, eviction is not
process-crash proof, and cryptographic fixtures are not browser passkey UX.
Accepted follow-ups added real authentication, eviction, duplicate insertion,
and verification/removal races. The misleading second-ceremony test title was
renamed. No production user data or legacy `instance` addresses changed.


## Checkpoint 2: production issuer integration

`packages/server/src/self-host-auth` now owns admission, same-user recovery,
passkey registration/login, opaque sessions, and code/state/PKCE handoff. Worker
and Bun adapters share the domain transactions. The self-host entries resolve
named sessions before protected requests and serve the same `/sign-in` page.
The local Bun command admits, recovers, or removes a person against the same
SQLite file. It prints an expiring enrollment link; no public administration
route or deployed Worker management command was added.

Independent review retained the credential owner and required these repairs:

- Reserve `instance` so named enrollment cannot adopt historical data.
- Bound JSON requests to 256 KiB and durably limit anonymous ceremony issuance.
- Preserve infrastructure failures as logged 503 responses.
- Validate issuer/callback schemes and use HTTPS `__Host-` cookies.
- Retry a failed handoff from completed sign-in rather than a consumed grant.
  Enrollment also offers ordinary sign-in if its response was lost.
- Drain active Bun handlers before closing SQLite and share one shutdown promise
  across SIGINT and SIGTERM.

Verification:

- `bun test packages/server/src/self-host-auth/index.test.ts apps/self-host/runtime-profile.test.ts`: 21 passed, 83 assertions.
- `bun test packages/server/src/self-host-auth/bun.test.ts`: 1 passed, 10 assertions. Real enrollment, login, recovery, and removal survive reopening file-backed SQLite.
- From `packages/server`: `bun x vitest run -c evidence/enrollment/vitest.production.config.ts`: 3 passed. This mounts the production credential owner and session resolver in an evidence Hono entry, not the full deployment entry. It proves Alice/Bob sessions, browser-bound enrollment, handoff, removal, and object eviction.
- From `packages/server`: `bun x tsc --noEmit --strict --noUncheckedIndexedAccess --skipLibCheck --target esnext --module preserve --moduleResolution bundler --types bun,@cloudflare/workers-types,@cloudflare/vitest-pool-workers/types --lib esnext,dom,dom.iterable evidence/enrollment/production.worker.ts evidence/enrollment/production-entry.ts evidence/enrollment/vitest.production.config.ts`: passed.
- `bun test apps/self-host packages/server/src/self-host-auth`: 40 passed, 120 assertions after the final repairs, including suspended-request shutdown and repeated signals.
- `bun run --cwd apps/self-host typecheck`: passed after the final repairs.
- `git diff --check` on the touched auth, self-host, and execution documents: passed.
- `bun /tmp/library-worker-enrollment-browser/smoke.ts`: Chromium virtual CTAP2 enrollment, an injected handoff 503 followed by successful retry, and fresh passkey sign-in passed without page errors. This launches the actual Bun entry through root `bun dev:self-host` with temporary auth storage. Screenshot: `/tmp/library-worker-enrollment-browser/sign-in.png`. This temporary smoke is not a committed regression harness.

At this earlier checkpoint, Worker operator tooling and application Account
composition were still missing. The continuation below implements them.
Complete optional passwords and access/removal coverage through library and
blob consumers remain. No deployment or migration ran.

## Generation integration pause

The concurrent current-generation task replaced the authority while this task
was implementing `/initial`. That task has since backed out its server replacement
to preserve the overlapping changes. Both execution plans record the coordination
pause. The user was asked whether library ownership should integrate with the
new current-generation model or retain this spec's history model. No answer has
been received; elapsed time is not a decision.

The partial history initializer remains in `generations.ts`, `mount.ts`,
`authority.ts`, `generations-route.ts`, and browser bootstrap, with foundation
and real Worker evidence. ADR-0385 is Proposed, not an accepted constraint on
that choice. From `packages/server`, `bun x vitest run -c vitest.workers.config.ts workers/initial-generation.test.ts` passes five tests: competing
seeds, reservation restart, stored-but-unadmitted restart, historical imports,
and socket gating. The wider earlier Worker run had three authorization-deadline
failures after the concurrent sync protocol changed. Baseline reconstruction did
not execute successfully, so their attribution is unresolved.

The proposed 32 MiB seed ingress bound is not currently implemented after the
overlap, and the full client/runtime integration is not verified. Do not mark
checkpoint 3 complete or resume conflicting storage edits before the generation
ownership/model question is settled. The public library binding and three
openers have not been implemented by this slice.


## Checkpoint 2: Worker operations and application Accounts

Task-start HEAD was `5059dc4820`, with substantial existing dirty auth, host,
application, and storage work. Status, HEAD, and the tracked binary diff are in
`/tmp/library-auth-continuation/`; desktop source copies are in
`/tmp/desktop-issuer-baseline/`. This continuation builds on that dirty auth
composition. It does not claim the whole visible Git diff as its work. No
files were staged or committed, and no generation route or storage bootstrap
was edited.

The Worker exports `SelfHostOperator`, a named service entrypoint with only
`admit`, `recover`, and `remove` available through RPC. The command at
`apps/self-host/scripts/manage-worker-user.ts` uses Wrangler's remote service
binding and an explicit Cloudflare account and Worker name. It reaches the same
`SelfHostAuthOwner` as public sign-in. The entrypoint has no public HTTP handler;
it adds no operator password or second credential database. Admission and
recovery return a private expiring link using the deployed issuer origin.

Browser `createBrowserAuth` selects an issuer; `createBrowserRedirectAuth` owns
browser storage and navigation around the existing PKCE handoff. Cloud keeps
its existing authority bytes, management links, and exact ceremony-cookie
policy. Self-hosted sessions use the origin-derived authority without those
Cloud capabilities. `createSessionAuth` remains the sole Account lifetime owner.
Applications already using the browser startup/callback contract receive this
behavior without opening a library in the callback document.

Desktop Settings selects the issuer. The host finishes its native callback,
keeps the bearer, and brokers requests through its captured Account. Offline
startup restores Alice without network access. Rejection preserves that Account;
same-person repair installs a new credential on it. A different person or first
sign-in is persisted for relaunch and never becomes the old windows' Account.
The native barrier closes app windows before sign-in; same-person success resumes
launching, not the closed windows themselves.

The operator's private link enrolls Alice at the issuer. Alice then opens the
application and connects to the server; the issuer cookie can complete the app's
handoff without a second passkey prompt. The link itself does not select an app
or fabricate its PKCE transaction. Exact callbacks and browser CORS origins must
be configured. Desktop uses `epicenter://auth/callback`.

Review accepted two repairs: remove fresh static-token connection branches now
that both UIs submit only a URL, and reject the configured Cloud origin as a
custom issuer so it cannot acquire a second local identity. Historical static
`instance` attachments still restore under their original identity; named sign-in
does not adopt their data. Cancellation, persistence-failure, and delayed-write
tests now exercise issuer selection instead of the deleted token-entry path.
The reviewer retained the shared browser redirect composition because it owns
real callback/storage/navigation behavior used by both issuers. No additional
session state machine or public client factory was introduced.

Verification after review repairs:

- `bun test packages/auth/src`: 137 passed, 562 assertions. Task-start result
  was 123 passed and eight failures in browser tests using the previous startup
  API. Those tests now use the current startup contract and preserve their
  relevant cancellation/persistence schedules.
- `bun run --cwd packages/auth typecheck`: passed. The task-start check had
  22 diagnostics in those same outdated browser tests.
- `bun test apps/epicenter/src/desktop-auth-authority.test.ts apps/epicenter/src/account-transport.test.ts`:
  45 passed, 300 assertions. The two task-start timeouts were obsolete Cloud
  selection fixtures waiting for an interactive sign-in; their replacements
  explicitly select an issuer and exercise the intended close/write barrier.
- `bun test apps/epicenter/src/server.test.ts -t 'the account broker requires'`:
  one passed, seven assertions, including URL-only loopback server selection.
- `bun run --cwd apps/epicenter typecheck:home`: TypeScript and Svelte checks
  passed with no diagnostics.
- `bun test apps/self-host packages/server/src/self-host-auth`: 40 passed,
  120 assertions. `bun run --cwd apps/self-host typecheck`: passed.
- From `packages/server`, `bun x vitest run -c evidence/enrollment/vitest.production.config.ts`:
  five passed. These now run the actual self-host Worker entry and named
  operator RPC rather than the former evidence-only entry. They cover real
  WebAuthn, recovery of Alice's ID, Bob surviving Alice's removal, independent
  handoff sessions, rejection of previously issued codes after removal, and
  absent public operator routes. The obsolete evidence entry was deleted.
- `bun apps/self-host/smoke/application.browser.mjs`: Chromium passed against
  the actual Bun entry through root `bun dev:self-host`, using temporary SQLite
  and a virtual passkey. The small browser consumer uses the same startup and
  callback API as store apps. It proves enrollment, app Account establishment,
  offline identity restoration, recovery with a replacement key, fresh sign-in,
  and refusal on the next check after removal. It does not open a store or
  exercise a packaged Tauri window.
- `bun apps/self-host/smoke/application.browser.mjs --worker`: the same
  Chromium scenario passed against the actual local Worker, starting with
  `getPlatformProxy` and the named operator service binding. This joins operator
  admission, the private link, passkey enrollment, application Account handoff,
  offline identity, recovery, fresh sign-in, and removal in one runtime test.
  The harness uses temporary config and SQLite with `remoteBindings: false`.
  Bun mode was rerun after adding Worker mode and also passed. The Worker
  subprocess resolves Wrangler from `apps/self-host` so its local service
  registry matches the version imported by the operator proxy.
- `bun run --cwd packages/app-shell typecheck` still reports one diagnostic in
  `src/inference-picker/connections.test.ts:186`, a null/undefined comparison.
  No diagnostic points to the modified sign-in components. This unrelated file
  was not edited; the package check is not claimed as passing.

The explicit strict TypeScript check for
`scripts/manage-worker-user.ts` and `smoke/application-page.ts` also passes;
these files are outside the app's normal include. Focused diff whitespace checks
pass. `bun scripts/check-doc-hygiene.ts` reports 40 ADR issues outside this
continuation; no ADR status or spec terminal state was changed.

The remote command has not authenticated to Cloudflare or changed a deployed
Worker. Local RPC evidence validates the bridge and owner; deployed account
permissions and rollout remain unverified. No deployment or real-data migration
was performed. This is an auth checkpoint, not completion of library ownership.
Local/Personal/Shared openers, library selection, Shared attachments, optional
passwords, Bun store sync, and the generation-model coordination remain required.

## Auth checkpoint commit verification

The commit includes the preceding uncommitted issuer-neutral auth/startup changes
that this continuation depends on, together with their browser, desktop, and app
consumers. Partial staging preserves the existing application constructors and
excludes the separate AI, SQLite, generation, and restoration implementations.
The staged source was materialized under `/tmp/library-auth-commit/snapshot`,
with workspace packages resolving inside that snapshot and installed third-party
dependencies reused. A separate HEAD archive is under the adjacent `baseline`
directory.

Commit inspection found and repaired Whispering's remaining old-shape callback,
UI adapter, session-readiness check, and auth reads. Its staged application module
keeps the committed opening model; the live, separately owned lazy bootstrap also
received the equivalent auth read without being included in this commit. The
AppBoot browser smoke now selects an issuer URL without entering a static token.
The auth routing test checks any addressed ledger against Alice and still requires
exactly Alice's authority; it no longer assumes the uncommitted initialization
protocol must contact a ledger.

Verification against the staged snapshot:

- `bun test packages/auth/src apps/self-host packages/server/src/self-host-auth apps/epicenter/src/desktop-auth-authority.test.ts apps/epicenter/src/account-transport.test.ts`:
  222 passed, 981 assertions.
- From `packages/server`, `bun x vitest run -c evidence/enrollment/vitest.production.config.ts`:
  five passed against the actual Worker entry.
- `bun apps/self-host/smoke/application.browser.mjs --worker` and the same
  command without `--worker`: both passed in Chromium using temporary state.
- `bun packages/app-shell/smoke/app-boot.browser.mjs`: Chromium and WebKit
  passed for signed-in and Local sessions, producer shutdown, durable closure,
  selection-write failure, and successful issuer selection.
- Auth, self-host, desktop Home, Honeycrisp (browser and host), Vocab, and
  app-shell package typechecks passed in the isolated staged source.
- Whispering checking reports only the unchanged SQLite fixture at
  `src/lib/whispering/app.test.ts:38`, whose fake database lacks `query`.
  The separate HEAD archive reproduces the same one diagnostic. It is not
  an auth regression, and the full Whispering check remains failing.
- Independent staging review found no other executable references to removed
  auth startup members and no unrelated implementation changes in the index.
  The focused staged whitespace check passes.

The remaining unused low-level `verifyInstanceToken` export predates this
continuation and has no production selection caller. It is a possible later
cleanup; it does not restore token entry to either application's connection UI.
The full library-ownership objective and generation integration pause remain open.
