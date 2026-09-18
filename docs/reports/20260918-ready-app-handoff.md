# Ready App greenfield execution handoff

This is a self-contained execution prompt for a fresh session. The previous
session stopped on the user's instruction to hand off before further execution.
Implementation had already started. Preserve and review the uncommitted work;
it is incomplete, not a verified implementation. Do not assume the previous
agents or their processes are available.

Continue the ready-App implementation in
`/Users/braden/conductor/workspaces/epicenter/yamoussoukro`.
Read current git status and code before assuming this handoff describes unfinished
work. The user explicitly authorizes clean breaks across all existing apps; no
compatibility wrapper, migration facade, or legacy opener is wanted.

The product sentence is: the page owns opening, openApp returns a ready App, and
a failed lifetime requires page teardown. ADR-0410 records the decision. The
execution plan is `specs/20260918T211222-ready-app-page-lifetime.md` while present;
a deleted plan means inspect the ADR, code, and commits for delivered behavior.

Target callsites:

```ts
const app = await openApp(definition, { account });
const runtime = createMemoryRuntime();
const testApp = await openApp(definition, { runtime });
await testApp.close();
const reopened = await openApp(definition, { runtime });
await reopened.close();
await runtime.dispose();
```

Keep the inert defineApp declaration and the complete runtime injection contract.
Default services use isTauri; memory services use isolated storage primitives.
App exposes ready capabilities, close(), and a revocation signal. Delete App.ready,
canRetryClose, the separate libraryReplaced notification when signal replaces it,
and same-page recovery after failure. Keep App<T> derived from the awaited factory.
Account is uniformly optional; no account generic or overload family returns.

Opening acquires one namespace claim and publishes no partial handle. Close is
terminal and idempotent, flushes/drains, and only releases the claim when safe.
Failed acquisition or cleanup must never admit a second writer while the old one
may still write. Browser/page teardown and native connection teardown are the
recovery mechanism, not an API that force-releases ownership. Reload is not proof
that unsaved changes survived. Successful close/reopen against one memory runtime
remains supported; terminal-failure tests can use isolated pages/processes.

The earlier synchronous API accumulated partial resource slots, readiness flags,
retry paths and callback plumbing. The intended collapse is structural: one async
opening path and const resource handles, with explicit cleanup registration and
safe ownership release. Do not hide the old implementation behind an async facade.
Keep protection against closed or externally retired handles and service-owned
operation drains. Internal store readiness may remain where non-App engines use it.

Primary files: packages/app/src/open.ts and its tests; packages/app-shell/src/boot-screens;
app application modules; packages/app/evidence/data/library-ownership; native
acceptance at packages/app/scripts/shared-ai-catalog.native.mjs. Current callers
are evidence, not design constraints. Use one coherent page integration as proof
and migrate straightforward remaining callers without restoring old APIs.

Use Bun. Follow repository AGENTS.md and applicable skills. Consult Claude via
consult-claude for independent design judgment; Codex owns edits and tests.
Keep reviewed source stable during a read-only consultation. Stage explicit files.
The unrelated `docs/reports/20260918-integration-review.md` is user work: leave it
untouched and unstaged. Do not deploy or use destructive git commands.

Verification: App tests and all App TypeScript projects; loading/failure/departure
UI tests and consumer typechecks; Chromium and WebKit admission harnesses; real
native SQL window-teardown evidence in addition to Web Locks; memory reopen and
isolation tests. Delete obsolete contract tests but preserve failure-retention,
flush/drain, retired-handle, and transaction guarantees. Review the cumulative
change for hidden compatibility and lifecycle state before committing. Update
README/ARCHITECTURE/CONTEXT and the ADR, then delete the completed spec.

Done means a committed, reviewable implementation of this target with verification
results and any genuine blockers named. Do not report a Promise wrapper around
an unchanged partial App as completion.

## Why this direction won

The user repeatedly challenged multiple openers, defensive option policing,
partial-lifetime state, and tests using a different API from production. The
resulting doctrine is one declaration, one opener, one complete runtime seam,
and one ownership boundary. Existing app callsites may break. Do not reintroduce
overloads, deprecated exports, compatibility shims, or account-dependent return
types just to preserve consumers.

Private storage per tab was rejected: a second window should address the same
library. Concurrent writers, waiting, and takeover were also rejected. Refuse
the second window with AlreadyOpen. This removes distributed writer arbitration
inside the App, but still requires a physical cross-window admission mechanism.
An invariant does not enforce itself across processes.

Inject services beneath App, not alternate App implementations. Production
chooses browser or Tauri services using isTauri at runtime; memory always uses
isolated resources. Memory document persistence uses fake-indexeddb primitives
without installing fake constructors globally. The complete runtime includes
admission, documents, named SQL databases, blobs, secrets, recording, and AI.
The services own physical operations; App owns composition and lifetime.

The later simplification was async opening. A partial App plus ready and
cancellation created lifecycle state the product does not need. The page can
render a promise and tear down on failure. Successful close remains useful for
deliberate departure and memory reopen tests. Failed close cannot be retried.

```text
                     inert definition
                  defineApp / tables / fields
                             |
page owns opening promise    v
--------------------> await openApp(definition, { account?, runtime? })
                             |
                   one App orchestration
                   validate -> claim -> acquire -> hydrate
                             |
             +---------------+----------------+
             | complete runtime service seam  |
             | claim / documents / SQL / blobs|
             | secrets / recording / AI       |
             +---------------+----------------+
                             |
                 +-----------+-----------+
                 |                       |
          defaultRuntime()       createMemoryRuntime()
             isTauri?            isolated primitives
          /          \           reusable after safe close
     browser        native
     IndexedDB      SQLite/filesystem/host services

successful opening -> ready App
  app.device     tables, kv, SQL, secrets, recording, connections
  app.account    undefined or identity, personal, shared, connection
  app.blobs      local, remote
  app.signal     revokes retained operations
  app.close()    one cached terminal promise

close -> revoke -> flush/drain/cleanup -> release claim if safe
failure -> retain unsafe claim -> page/window teardown -> fresh attempt
```

Capability names above should be checked against code. Keep defineApp imports
inert for schema tools and server use. openApp remains the lifetime entrypoint:
`@epicenter/app/open`; memory runtime: `@epicenter/app/testing`.

## Exact stopping point, 2026-09-18

HEAD is `e3a4b70e11`, branch `braden-w/app-schema-derive-export-import`.
At handoff it was ahead 8 and behind 1 relative to its upstream. Do not pull,
reset, or reconcile history without inspecting it. No implementation changes
from this execution attempt were staged or committed.

Earlier committed foundations:

- `bfed2d5d29`: complete runtime and shared App lifecycle/admission.
- `1761eda6ea`: injected IDB primitives, native/memory coexistence.
- `e972818699`: automatic isTauri service selection.
- `8bc5a4c4c2`: one opener/schema generic, inlined composition, optional account,
  removed AppStore/AppSqlite/AppBlobs aliases and options policing.
- `e3a4b70e11`: ready-App planning docs, before async implementation.

Current working tree has roughly 47 modified tracked files plus this handoff.
Read `git diff` rather than rebuilding the work from scratch.

Implemented but unfinished:

- `packages/app/src/open.ts` is now async, awaits admission and readiness,
  registers resource closers, publishes the frozen handle last, and derives App
  using Awaited. Public ready, canRetryClose, and libraryReplaced are removed.
- Close caches its promise permanently, aborts usability immediately, attempts
  all registered cleanup, and releases admission only on safe completion.
- A heldBackings set conservatively retains ownership after uncertain document
  acquisition. Opening plus cleanup failure uses AggregateError with the original
  opening error as cause. This implementation still needs review.
- SQL cleanup now runs alongside independent resource cleanup. SQL owns its own
  operation drain. Other cleanup failure still retains the global claim.
- App tests have been migrated to the new contract. Obsolete partial-handle
  cancellation tests were deleted; failure-retention coverage was retained.
- AppBoot now accepts an opening promise and renders a snippet with its resolved
  value. Departure observes signal and has terminal failure instead of retry.
- Honeycrisp, Vocab, Whispering, Skills, and Local Mail callers were migrated.
  Bootstrap modules expose one promise, without requiring module top-level await.
- Browser ownership and native catalog/SQL evidence were adapted and extended.
- ADR-0410 status was changed to Accepted; its Unbuilt header is now stale.
  The spec was changed to In Progress. Completion documentation was not done.

## First fixes and review questions

1. `open.ts:100` currently fails TypeScript: ownership.data is possibly null inside
   close's closure. Preserve the narrowed successful claim in a const. Do not use
   a non-null assertion to paper over acquisition semantics.
2. `packages/app/src/data/store/browser.test.ts:298` expects direct StorageFailed
   for failed opening plus unsafe cleanup. Adapt it to verify AggregateError and
   the preserved StorageFailed cause. Do not weaken cleanup retention.
3. Audit the successful runtime.data handoff: `{ ...opened.data }` may invoke a
   throwing getter after acquisition but before createStoreOverPort owns the
   backing. heldBackings retains the claim, but known backing disposal may not be
   attempted. Decide a clear local rollback or ownership-transfer solution. This
   is a suspected gap, not yet fixed or demonstrated with a focused assertion.
4. Similarly inspect runtime.ai.connections acquisition followed by createAppAi
   construction: if construction throws before registering inference.close, who
   disposes the acquired catalog? Verify actual factory behavior before adding
   abstractions or defensive machinery.
5. The abort listener invokes close even during manual close and can log ordinary
   cleanup failures as retirement failures. Check whether logging should distinguish
   those cases without adding lifecycle flags solely for diagnostic wording.
6. Departure ignores App.signal abort after its own resource close starts. Review
   simultaneous external retirement: can it incorrectly allow an auth mutation?
   Prefer an existing lower-level guarantee over a second notification API.
7. Migrate `packages/app-shell/smoke/app-boot/application.ts` and `App.svelte`.
   They still use a lower-level store/ready fixture. Prefer a real memory App and
   acquisition/commit gates to another artificial readiness facade.
8. Update current docs, notably `apps/whispering/ARCHITECTURE.md:26`, App README,
   architecture/context references, and ADR header amendments. ADR-0409 remains
   Proposed; do not silently describe it as accepted. Accepted ADR bodies are
   historical evidence; use bounded amendment headers/new decisions.

Internal createStoreOverPort still has ready/retry-related machinery for other
engines. Do not globally delete those names merely because App no longer exposes
them. Preserve retirement invalidation, operation drains, and storage safety.

## Evidence at the stop

These are completed checks reported by the executing agents, not a claim the
whole dirty tree is green. Re-run affected checks after fixes.

- Before this attempt: 696 App tests and all seven App TS projects passed.
- Latest focused App suite: 93 pass, 1 fail across 94 tests in nine files.
  The sole failure is the AggregateError assertion above. Log:
  `/tmp/async-tests2.log`.
- Latest App typecheck: only the ownership.data narrowing error was reported.
  Log: `/tmp/async-test-types2.log`.
- Focused departure/application/bootstrap/import/recording-close tests passed;
  four consumer boot/domain files had 14 passing tests. Logs:
  `/tmp/async-page-tests.log`, `/tmp/async-consumer-tests.log`.
- Honeycrisp, Vocab, Whispering, and Local Mail typechecks reported no remaining
  consumer errors, but all failed on the same opener error. Logs:
  `/tmp/async-{honey,vocab,whisper,mail}.log`.
- Full app-shell suite had five failures in untouched
  `inference-picker/connections.test.ts`, apparently missing configuredFetch in
  its custom inference fixture. Baseline was NOT executed, so preexistence is
  inferred, not proven. Verify rather than silently excluding these tests.
- Chromium and WebKit admission harnesses passed: 50 close/reopens, 50 reloads,
  duplicate refusal, unsafe failed-close retention, failed opening and rollback
  retention, blocked acquisition teardown, and native/default plus memory runtime
  coexistence. Logs: `/tmp/async-admission-{chromium,webkit}.log`.
- First native acceptance pass succeeded, including destroying a real window
  without App.close, reopening the same named SQL database, and proving an
  uncommitted transaction rolled back and a TEMP table disappeared. This tests
  physical connection teardown, not just disappearance of a browser lock.
- That native pass later logged SQL dispatcher cleanup failure during whole-host
  shutdown because the reopened probe left SQL acquired. Do not hide the warning
  or equate window teardown with proven process-shutdown cleanup. Investigate
  whether fixture cleanup or host shutdown ordering is responsible.
- The second native pass completed before the stop and also passed the actual
  location.reload SQL rollback/TEMP disappearance assertions. Both passes retained
  the later whole-host shutdown warning. Final evidence:
  `/private/var/folders/qx/9462vg517cvdtpjr4tt32_200000gn/T/shared-ai-catalog-native-NwvDss/result.json`;
  log: `/tmp/async-native-teardown.log`. Recording smoke and product Whispering
  native mode were not run. All delegated test/evidence processes have stopped.
- Honeycrisp retirement evidence script was migrated but NOT run. Formatting,
  full App suite, final independent design review, and cumulative docs are pending.

One test-writing trap already resolved: attaching Bun's `.rejects` matcher to a
gated pending promise before releasing its gate spun synchronously. Attach a
plain catch handler, release the gate, then await the assertion. The apparent
retirement deadlock was a matcher issue, not established production evidence.

## Review and execution instructions

Read AGENTS.md and the relevant skills, especially consult-claude, design-review,
typescript, greenfield-clean-breaks, and post-implementation-review. The user
explicitly requested Claude's judgment and independent Codex subagent passes.
Delegate bounded independent review/testing work if available; retain ownership
of integration and final decisions. Claude is a read-only second opinion.

The prior Claude native session ID is
`8394efde-f429-4ca9-ad09-e7e850cb2595`; resume only through the current skill's
workflow if accessible, otherwise start a fresh consultation with this context.
Previous consultations reported model `claude-fable-5-1`. Do not claim this
unfinished cumulative implementation has already passed Claude review.

Ask the reviewer to challenge the whole lifetime boundary, cleanup ordering,
ownership handoff, terminal failures, signal semantics, and remaining state.
Include the ASCII diagram and concrete callsites. Ask for focused executable
experiments where reasoning alone cannot establish teardown safety. Hold reviewed
source stable during the consultation, then independently verify objections.

Likely verification commands from the repository root:

```sh
git status --short --branch
git diff --stat
bun test --isolate packages/app/src
bun run --cwd packages/app typecheck
bun test --isolate packages/app-shell/src/boot-screens/departure.test.ts
bun packages/app/evidence/data/library-ownership/browser.ts
bun packages/app/evidence/data/library-ownership/browser.ts --webkit
bun packages/app/scripts/shared-ai-catalog.native.mjs
```

Consult package.json for consumer typecheck/build scripts and the native fixture
README for prerequisites. Do not run remote/prod scripts. Use targeted formatting.
Inspect retained logs before repeating expensive native runs. Temporary log paths
are conveniences, not durable evidence: summarize verified results in the final
artifact and record any unresolved limits.

Finish with current documentation, an independent cumulative review, appropriate
passing checks, explicit staging, and a coherent commit. Delete the spent spec
and update docs/spec-history only when the work is actually complete. Keep
`docs/reports/20260918-integration-review.md` untouched and unstaged. The user
should recognize one obvious API and less lifecycle machinery, with genuine
resource-safety obligations still enforced and explained.
