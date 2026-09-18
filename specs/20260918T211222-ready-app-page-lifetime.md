# Return a ready App; recover by page teardown

Status: Draft

## Outcome and current state

The page owns opening; openApp returns a ready App; a failed lifetime requires
page teardown. The target decision is [ADR-0410](../docs/adr/0410-an-app-is-returned-ready-and-page-teardown-owns-recovery.md).

Current baseline: `8bc5a4c4c2`. `packages/app/src/open.ts` is one synchronous
factory with a schema generic and complete runtime injection. It returns `ready`,
`close`, `signal`, `libraryReplaced`, `canRetryClose`, and scoped capabilities.
Browser, host, and memory runtimes already share its lifecycle. This plan changes
that lifecycle contract, not storage addresses, formats, auth, or sync protocols.

Completion means the public opener is asynchronous, every returned App is usable,
no compatibility facade or retryable App closure remains, and real teardown tests
prove that failed lifetimes retain ownership safely until their context ends.

## Target API

```ts
import { defineApp, defineTable, field } from '@epicenter/app';
import { openApp } from '@epicenter/app/open';
import type { App, AppRuntime } from '@epicenter/app/open';
import { createMemoryRuntime } from '@epicenter/app/testing';

const definition = defineApp({
  id: 'test.notes',
  tables: { notes: defineTable({ title: field.string() }) },
  kv: {},
});

// Local production: automatic browser/host service selection.
const local = await openApp(definition);
await local.close();

// Signed-in production: same shape; account remains optional in the type.
const app = await openApp(definition, { account });
if (app.account) app.account.personal.tables.notes.create({ title: 'Hello' });
await app.close();

// Tests: identical API, storage survives successful closure.
const runtime = createMemoryRuntime();
const first = await openApp(definition, { runtime });
first.device.tables.notes.create({ title: 'Retained' });
await first.close();
const second = await openApp(definition, { runtime });
await second.close();
await runtime.dispose();

// Tests with account capabilities may supply { account: fixtureAccount, runtime }.
// The fixture must supply any account transport the test actually exercises.
```

The target signature is:

```ts
async function openApp<const TDefinition extends DataDefinition>(
  definition: TDefinition,
  { account, runtime = defaultRuntime() }: {
    account?: Account;
    runtime?: AppRuntime;
  } = {},
) { /* acquisition, readiness, then return the handle */ }

type App<TDefinition extends DataDefinition> =
  Awaited<ReturnType<typeof openApp<TDefinition>>>;
```

The ready handle keeps `appId`, `device`, optional `account`, `blobs`, `signal`,
and `close()`. `signal` revokes retained operations on close or external retirement.
Evaluate replacing `libraryReplaced` with this existing signal at the page
boundary; do not add a second notification API without a distinct consumer need.

Remove `ready` and `canRetryClose` from the App. Do not expose a cancel/retry/force
API. Keep one opener, the complete AppRuntime contract, and the derived App type.

## Ownership model

```text
Page                          App implementation
opening promise ------------> validate and reserve ownership
loading                       acquire and hydrate
                              success: publish complete App
ready App <------------------ return
                              close: revoke, flush, drain, release
failure                       rollback where safe, retain unsafe ownership
reload/close page -----------> browser/host context teardown
fresh page -----------------> new opening attempt
```

The page owns one attempt. The opener owns partial acquisition and rollback.
The runtime owns storage and admission. Each resource owns its physical cleanup.
No returned handle is needed to retain the browser Web Lock while rollback fails.
Native services must release their connections when the owning webview disappears.

## Execute backward from the outcome

### 1. Prove the terminal-failure boundary

Use the existing browser ownership harness and native catalog harness. Inject a
blocked acquisition, a failed construction, and a failed physical cleanup. Prove
that a second window cannot enter while the failed owner may still write, then
prove a fresh page enters after the owner page actually disappears. Observe real
release, without a production delay, takeover, or automatic retry.

Prove browser and host cleanup separately. A browser lock disappearing does not
prove the native SQL connection has closed. Document any host teardown race before
rewriting the lifecycle. Failure requiring process restart rather than window
reload must be reported, not concealed with a weaker ownership check.

### 2. Build the async opener and delete the old contract

Keep all work in one opening path. Validate, acquire ownership, build resources,
await required hydration, and publish the frozen handle last. Register cleanup as
resources are acquired so every partial failure is accounted for. An acquisition
that rejects after allocating a resource must clean itself up or expose enough
information for safe retention; a comment assuming it cannot throw is insufficient.

Move App readiness inside the async function. Remove public ready, initialized,
and pre-readiness checks; retain a guard against closed/retired use. Make close
cache both success and failure permanently. Remove close retry state and any App
code whose only purpose was closing a publicly exposed opening handle.

Preserve one ownership claim, flushing, operation drains, late-acquisition cleanup,
retirement propagation, and safe retention. A generic disposal stack must not
hide the ordering or the condition for releasing ownership. Do not delete all
service-level lifecycle state merely because App has become asynchronous.

### 3. Make the page observe opening directly

Change AppBoot to observe Promise<App> rather than a partial App plus ready.
Render capabilities only after resolution. Rejected opening renders a terminal
failure and reload action. Departure closes UI producers before App.close; only a
successful close permits the normal account/server transition. A failed close
shows terminal status without offering retry or mounting a replacement App.

Use one reference integration to prove loading, opened content, unexpected
retirement, deliberate departure, and failed departure. Existing app compatibility
is not an architectural constraint. Mechanically migrate remaining callers when
straightforward; do not preserve old wrappers or grow app features to retain them.

### 4. Review and harvest

Review the combined opener, service closure, and page boundary independently.
Reconsider any new registry or state machine by mentally inlining it. Run the
checks below, update current README/ARCHITECTURE/CONTEXT, and delete this spec when
execution finishes. Preserve historical accepted ADR bodies; record amendments.

## Evidence and acceptance checks

- Type inference retains schema fields and uniformly optional account; App derives
  from the awaited factory return. No `ready` or close-retry member remains.
- A resolved opening permits immediate store operations. A rejected opening
  exposes no partial handle. Rejection preserves an actionable original cause.
- Duplicate opening rejects with AlreadyOpen without releasing the incumbent.
- Normal close flushes writes, drains admitted work, revokes retained methods,
  releases ownership once, and returns the same terminal outcome on repeated calls.
- Failed opening/cleanup cannot release resources that may still write. Context
  teardown, not an API retry, is the verified recovery mechanism.
- Same-runtime successful reopen retains documents, blobs, SQL, secrets, and AI
  catalog; fresh runtimes isolate state. Dispose refuses live owners.
- External retirement revokes every capability and leads the page to departure or
  terminal failure. Removing the separate libraryReplaced promise must preserve it.
- Run App tests and all App TypeScript projects; migrate tests that assert the old
  public readiness/retry promise. Retain persistence and failure-retention evidence.
- Run Chromium/WebKit ownership harnesses and the native teardown acceptance test.
  Verify one page integration build. Report untested apps explicitly.

## Deliberate compromises

There is no same-page recovery after failed opening or closure, and no public
opening cancellation. The page/process can be torn down. Reload does not imply
that unsaved changes survived. Normal successful memory reopen remains supported.

Internal cleanup failures remain observable even though they are no longer
repairable through the App API. Test terminal leaks in a disposable context,
without introducing a production force-release escape hatch.
