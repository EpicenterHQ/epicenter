# Result option namespaces and selective Epicenter adoption

**Date**: 2026-10-21
**Status**: Draft
**Owner**: Wellcrafted and Epicenter maintainers

## One sentence

Add Wellcrafted option namespace helpers for regular Result-service calls,
adopt them in the dashboard, and rebuild Whispering's observation boundary
around Result commands and explicit recording/run owners.

The helper runtime is implemented in [Wellcrafted PR #145](https://github.com/wellcrafted-dev/wellcrafted/pull/145),
with a minor changeset and passing CI. Epicenter still uses Wellcrafted 0.44.0
and query-core 5.96.2. The helpers are not yet adopted here; completion requires a tested library
release, a compatible dependency set, migrated legacy consumers, and preserved
dashboard isolation and Whispering lifecycle behavior.

The durable proposals are [Epicenter's composition decision](../docs/adr/0661-apps-compose-result-services-through-wellcrafted-option-namespaces.md)
and Wellcrafted's `docs/adr/0001-result-namespaces-produce-native-tanstack-options.md`
in `wellcrafted-dev/wellcrafted`. The local library checkout is
`/Users/braden/Code/wellcrafted`.

## Current state and target

The useful boundary is service observation, not every use of TanStack Query.
The inspected production legacy imports are concentrated in these owners:

| Owner | Current work | Target |
| --- | --- | --- |
| `apps/api/ui/src/lib/billing/queries.ts` | Key map, forwarding functions, client-bound definitions | Selected query/mutation maps composed directly in the existing dashboard runtime |
| `apps/api/ui/src/lib/account/queries.ts` | Key map and fixed/nested auth-client reads | Selected read closures; shared invalidation for unlink/passkey writes where adopted |
| `apps/api/ui/src/lib/dashboard/runtime.ts` | Account, transports, fresh QueryClient, injected factories | Retain lifetime; replace factories-only plumbing with native options namespaces |
| `apps/whispering/src/lib/library.svelte.ts` | Scope-keyed `track`, fenced `action`, accepted-work draining | Remove internal mutation wrappers; expose Result commands and domain activity with one registry for accepted local stages |
| `packages/svelte/src/folder-queries.ts` | Path/representation keys and context-aware generic readers | Replace removed `defineKeys` with plain tuple data/functions; keep reader API and key layout |
| Capture and other consumers of `resultMutationOptions` | Explicit local observation of app actions | Keep explicit options unless a real repeated service namespace appears |

The dashboard's `billingKeys` and `accountKeys`, repeated service argument
annotations, forwarding lambdas, and injected `createQueryFactories` plumbing
can disappear. Whispering's internal mutation keys, mutation-cache activity
subscription, outer `Ok` round trips, and duplicate pending accounting can also
disappear. Folder's positional key protocol remains.

## Review findings and decisions

The initial reviews supported a narrow compatibility migration. A subsequent
independent greenfield review challenged its assumption that Whispering's
wrappers had to survive. Both reviewers found that their TanStack machinery
could disappear while recorder and run owners retain the necessary behavior.
Shutdown admission and draining remain necessary; merely renaming `hold` to
another lifecycle helper would not establish a simplification.

Retain the two-helper proposal within its small mapping contract. The strongest
library disagreement remains whether a mutation namespace saves enough beyond
plain `resultMutationOptions`; an isolated or customized mutation can use the
explicit adapter. Do not add a lifecycle registry, callback merging, automatic
invalidation, or per-domain wrapper factories to justify namespace helpers.

| Decision | Basis | Consequence |
| --- | --- | --- |
| Keep separate read and mutation maps | Composition | Mutation policy can reference already-constructed query identities |
| Keep services independent of TanStack | Composition | Observation and cache relationships stay at the consuming edge |
| Bound query arguments in a final tuple | Executed key-collision check | Use `[...namespace, method, args]`; require readonly string namespace paths |
| Preserve supplied-argument identity | Native hashing and service signatures | No automatic trailing-undefined trimming; canonicalize before factory calls when required |
| Keep explicit Folder readers | Actual readers and refresh protocol | No generic namespace wrapper around resource/context arguments |
| Remove Whispering's internal mutation wrappers | Actual state consumers and greenfield review | Domain owners report activity; one lifecycle registry admits complete local stages |
| Retain a small mutation helper | Design choice | Saves operation-key and forwarding declarations; explicit adapters remain a valid alternative |

### Query identity correction

The original flat key scheme aliases two valid compositions:

```ts
// Namespace ['users'], getUser('list'):
['users', 'getUser', 'list']

// Namespace ['users', 'getUser'], list():
['users', 'getUser', 'list']
```

The corrected keys are:

```ts
['users', 'getUser', ['list']]
['users', 'getUser', 'list', []]
```

Method `.key` stays `[...namespace, method]` for prefix invalidation. A method
prefix can also match a nested namespace; it is untagged and is not a typed
bulk-update selector. Exact filters and reads use `factory(...args).queryKey`.
Even a zero-argument read ends with `[]`, so an old exact literal key no longer
matches it. Audit `DashboardSession.svelte` and runtime test cache assertions
specifically.

The tuple does not change TanStack's JSON equivalence. Explicit `undefined`
and `null` in arrays can hash alike. `events()` and `events({})` can remain
separate entries, but exact cache writes must use the same canonical inputs as
reads. Normalization belongs before the generated factory, or in a handwritten
`resultQueryOptions` adapter when key identity is domain-specific.

### Dependency compatibility

Registry metadata checked on October 21, 2026 supplies a compatible baseline:

| Package | Verified version or requirement |
| --- | --- |
| Published `wellcrafted` | 0.45.0; query-core peer `^5.102.0`; no namespace helpers |
| `@tanstack/svelte-query` | 6.3.5; depends on query-core 5.104.5 |
| `@tanstack/svelte-query-devtools` | 6.3.5; peers with Svelte Query `^6.3.5` |
| `@tanstack/query-core` | 5.104.5 |

Select a tested Wellcrafted release containing the helpers when implementing;
do not invent a release number. Align Epicenter's direct core catalog entry
with the framework adapter's core dependency. Its installed Svelte Query
6.1.13 pins core 5.96.2, so changing only Wellcrafted is insufficient.

Verify one resolved core module is used by `QueryClient`, Svelte Query's
observers, and `focusManager` in the running dependency graph. Stale package
directories can remain in an installation; merely counting directories in
`node_modules/.bun` does not establish resolution identity. Check the lockfile
and resolve the actual importing paths.

## Dashboard composition

Construct account-bound maps directly inside `createDashboardRuntime(account)`.
Expose `billingQueries`, `billingMutations`, `accountQueries`, and, when shared
write policy is moved, `accountMutations` through its existing context.

```ts
const billingKey = ['billing'] as const;
const billingQueries = createQueries(billingKey, {
  overview: {
    queryFn: billingApi.overview,
    refetchOnWindowFocus: 'always',
  },
  usage: billingApi.usage,
  events: billingApi.events,
  plans: billingApi.plans,
});

const billingMutations = createMutations(billingKey, {
  previewPlanChange: billingApi.previewPlanChange,
  checkoutPlan: {
    mutationFn: billingApi.checkoutPlan,
    onSuccess: (result, _input, _rollback, { client }) => {
      if (result.checkoutUrl) return;
      return client.invalidateQueries({ queryKey: billingKey });
    },
  },
  checkoutTopUp: {
    mutationFn: billingApi.checkoutTopUp,
    onSuccess: (result, _input, _rollback, { client }) => {
      if (result.checkoutUrl) return;
      return client.invalidateQueries({ queryKey: billingKey });
    },
  },
});
```

Keep the account service captures, fresh attachment-owned client, lifetime
signal, provider, and disposal. A late mutation uses its executing client and
cannot populate a successor attachment, including one for the same principal.
No cache is keyed or memoized solely by principal identity.

Shared billing invalidation moves out of component callbacks. Redirects,
toasts, and dialog state retain their component departure guards. Awaiting the
definition callback's invalidation extends mutation pending through that
refresh; verify this intended timing in the billing UI. `portal` can remain a
direct Result-returning interaction with its existing guards.

Account read closures still fix `disableCookieCache: true` and select nested
passkey methods. Do not detach arbitrary Better Auth proxy methods or pass
transport options into generated query keys. Shared unlink/passkey invalidation
can use selected unary mutation wrappers and `runMutation` in the existing
async handlers. Preserve cancellation, reauthentication, confirmation-dialog
retry, and typed Result branches; adopting shared policy does not require
replacing every handler with a hook. OAuth redirect completion remains its own
interaction, not a guessed mutation-success event.

## Real callers before and after

### Activity feed read

Before, `apps/api/ui/src/lib/components/ActivityFeed.svelte:10`:

```ts
const events = createQuery(() => billing.events({ limit: 50 }).options);
```

Target, after obtaining `billingQueries` from the same dashboard context:

```ts
const events = createQuery(() => billingQueries.events({ limit: 50 }));
```

Apply the same translation to `UsageChart`, `TopModels`, `CreditBalance`,
`UserMenu`, `PlanComparison`, and the dashboard routes. Replace imported exact
keys with generated option keys, including the window-focus handler in
`DashboardSession.svelte`.

### Top-up mutation input

Before, `apps/api/ui/src/routes/dashboard/+page.svelte:45` and its button handler:

```ts
const topUp = createMutation(() => billing.topUp.options);
// Inside the button handler:
topUp.mutate(window.location.href, callbacks);
```

Target:

```ts
const topUp = createMutation(() => billingMutations.checkoutTopUp());
// Inside the button handler:
topUp.mutate({ successUrl: window.location.href }, callbacks);
```

The object input is the service's real input. The old adapter reshapes a string.
Keep component callbacks for local effects; remove their duplicate invalidation
after the shared definition owns it. The same success callback must run when a
component observer has gone away.

## Whispering workflow redesign

Whispering records audio, transcribes it, transforms saved or pasted text, and
keeps the results as editable files. Its platform services currently supply
capabilities; `library.svelte.ts` supplies most application workflows. Merely
mapping the platform service object would leave that orchestration intact.

### Ownership and callers

| Owner | Responsibility |
| --- | --- |
| Folder | Authoritative files, typed edits, merge/save behavior, change notifications |
| Folder context | QueryClient, read refresh, one registry for accepted local operations |
| Mounted app root | Construction and shutdown order, selection, drafts, pasted text |
| Recorder | Active capture, initial recording row, stop/cancel, audio finalization state |
| Runs | Request snapshots, duplicate-send exclusion, per-result state, received answers awaiting persistence |
| Result commands | Finite file/settings operations, including admission before asynchronous work |
| Options namespaces | Native observation and cache policy for selected Result methods |

Keep the existing platform seam. Construct stateful owners once per mounted
app; routes consume them. A feature module does not require a separate public
factory, injected callback framework, or query/mutation wrapper factory.
Existing Svelte reactive state can remain where it makes the application model
simpler; a new generic subscription layer is not a goal.

The following is a proposed caller shape, not an existing export. These are
application commands, not direct aliases for low-level transport methods:

```ts
const mutations = createMutations(['whispering'], {
  createTransformation: app.createTransformation,
  saveConnection: app.saveConnection,
});

// Component:
const create = createMutation(() => mutations.createTransformation());
create.mutate(starter, {
  onSuccess: ({ path }) => openTransformation(path),
});
```

`createTransformation` returns a Result containing the created path. The
component observes pending/error and chooses what to open. A direct call to
the same command has the same admission and save guarantees. The command must
not depend on executing through mutation options to be safe.

Recording and inference commands may also be adapted when a caller benefits,
but their shared state remains owned by the recorder and runs. Successful
`startRecording` means a recording started, not that it finished. A received
answer can still be awaiting persistence after the provider call succeeds.
Native mutation pending/success/error does not replace those distinctions.

### Remove the compensating machinery

Delete `track`, `action`, `whisperingKeys`, their internal `defineMutation`
calls, `trackMutations`, and the outer `Ok`/unwrap/cast round trips. Replace
`audioOf`'s mutation-cache lookup with recorder-owned capture/finalization
state. Writing a transcript must not incidentally mark its audio as settling.

Consolidate accepted local work in the existing context registry rather than
retaining both library `pending`/`hold` and `context.run`. Commands admit whole
local stages once; after an await, their continuations call Folder directly
instead of attempting admission again. Resource reservations and domain state
remain necessary; do not replace them with one generic `isPending` flag.

Tests that synchronize on internal mutation-cache events should instead block
the actual folder/capture stage and assert its outcome. Preserve the behavior
under test, not the fabricated mutation identity.

### Shutdown boundary to prove

The proposed cutoff is explicit:

1. Root shutdown synchronously refuses new commands and provider replies,
   stops retry scheduling, and registers recorder finalization before storage
   shutdown begins.
2. Preparation and initial result publication are admitted local stages. If
   shutdown begins during preparation, finish that local stage but check the
   cutoff before sending the provider request.
3. Provider waits are outside the registry. An answer handled before the
   cutoff synchronously admits its complete publication attempt. That attempt
   finishes even if the cutoff occurs before its callback starts.
4. Answers handled after the cutoff are ignored. Do not start new publication
   retries or automatically resend inference. Drain admitted local stages and
   finalization, then close Folder.

The current mounted teardown can support one registry: `FolderApp` defers
`context.close()` through `opening.then`, while `WhisperingApp` calls product
stop synchronously. Finalization must be registered synchronously in that
interval. Verify this ordering with the mounted close test; do not silently
extend the claim to arbitrary direct calls of `context.close()` while the
product is mounted. If those calls must also shut down the product, establish
an explicit context-owned pre-close registration instead of relying on component
ordering. This lifecycle seam must be resolved before deleting the old registry.

This is orderly in-page teardown. The current desktop window destroy path does
not await it, and browser/process termination cannot promise it. Recording
durability and result rows written before dispatch remain necessary; options
factories do not strengthen abrupt-exit guarantees.

Folder's path/representation reads and change-driven refresh remain. Do not
put a `FileReader`, edit object, Blob, or AbortSignal into an automatically
generated key, or require a display reread before accepting a save as complete.
Keep deletion reservations, conflict handling, ambiguous-audio refusal, and
publication retries that reuse a received answer rather than resend a request.

## Implementation plan

### 1. Prove and implement the library contract

- [x] Add `createQueries` and `createMutations` beside the existing adapters,
  with no client capture, proxy, callback-merging overload, or invalidation DSL.
- [x] Generate bounded query keys and ordinary operation mutation keys; prevent
  descriptors from replacing the generated identity or Result conversion.
- [x] Prove heterogeneous shorthand/descriptor inference, zero/optional/multiple
  query arguments, void/unary mutation inputs, `select`, cache `DataTag`,
  `initialData` compatibility, and optimistic callback context. Rollback inference
  requires annotations on every parameter declared by namespace `onMutate`;
  the explicit adapter retains full unannotated optimistic inference. Reject
  unsupported multi-argument mutation functions with an explicit-adapter path.
- [x] Test construction without execution, exact and prefix keys across nested
  namespaces, receiver handling, Result conversion, mutation callback ordering,
  observer departure, and shared policy through `runMutation`.
- [x] Update the library query README and distributable TanStack skill,
  validate the package, and open a PR with a minor changeset.
- [ ] Release the helpers through Wellcrafted's existing release workflow before
  upgrading Epicenter's dependency.

The library checkpoint passes 183 tests, typecheck, build, and query-module
Biome checks. Packed declarations pass real React Query 5.104.5 and Svelte
Query 6.3.5 consumer checks; query-core 5.102.0 also passes a packed type/runtime
check. Review repaired fixed-hash identity overrides, prototype-named method
mapping, and unannotated service wrappers accepting arbitrary inputs. The
namespace helpers add no per-entry builder to hide the optimistic inference
limit. Whispering implementation remains the next phase.

The source runner already catches thrown work. An executed check confirmed
`Err` with the same thrown value and no success callback. Another check found
that `runMutation` also casts callback exceptions to the service error type;
that existing limitation is not a new exhaustive error guarantee. Keep cache
policy outside `mutationFn`, so a policy failure cannot retry a completed write.
Any broader runner error-model change is a separate decision.

### 2. Establish Whispering's workflow boundary

- [ ] Separate recorder ownership and run ownership from the library's read
  projections and view selection. Preserve the existing platform capabilities
  and one mounted app lifetime; avoid replacing one giant library with an
  equally broad service object.
- [ ] Make finite application commands return Results and own their admission.
  Remove presentation strings as the success/error protocol; preserve domain
  error detail and let callers choose toasts, selection, and navigation.
- [ ] Prove one accepted-work registry using whole local stages and synchronous
  finalization registration. Test the explicit reply cutoff before replacing
  `hold`/`pending`; establish pre-close registration if direct context closure
  must coordinate product shutdown too.
- [ ] Remove `track`, `action`, internal mutation keys and mutation-cache
  subscriptions. Use recorder state for audio settling; keep run persistence,
  duplicate-send exclusion, deletion safeguards, and save-only retries.
- [ ] Replace mutation-event test synchronization with actual stage control.
  Prove direct command calls and observed calls have the same close behavior.

This work can use the current native Result adapters before the library release.
The namespace helper is not a prerequisite for establishing domain ownership.

### 3. Upgrade Epicenter directly to the final compatible shape

- [ ] Update the root dependency catalog and lockfile to the selected helper
  release and an aligned TanStack set; verify resolution from each real importer.
- [ ] In the same compatibility change, migrate all production imports of removed
  `defineKeys` and `createQueryFactories`. Do not land a dependency-only state
  that leaves consumers broken, or build a throwaway dashboard adapter layer.
- [ ] Compose dashboard maps in the existing runtime; translate consumers and
  runtime tests to native options and explicit Result runners.
- [ ] Replace Folder's `defineKeys` with plain typed tuples, preserving its key
  layout. Whispering's obsolete internal keys disappear with its workflow
  redesign; do not write a temporary `track`/`action` execution shim.
- [ ] Compose selected Whispering command options directly beside their
  application owner. Adopt native component mutation state where useful,
  including transformation creation; do not require observers for recorder or
  inference state that already has a domain owner.

### 4. Establish shared app policy and prove behavior

- [ ] Move conditional checkout/top-up invalidation into shared definitions,
  retaining local UI effects and departure guards.
- [ ] Move repeated account invalidation into selected mutation definitions
  executed by existing handlers, preserving their Result and dialog semantics.
- [ ] Prove isolation for a different principal and a new attachment of the same
  principal, including late mutation callbacks and every exact cache assertion.
- [ ] Run Folder refresh/lifecycle tests, Whispering lifecycle and mounted tests,
  dashboard runtime tests, targeted typechecks, and browser/host builds.
- [ ] Update current package documentation and the repo query-layer guidance
  after exports and callers establish the supported names. Retire this spec
  after implementation; preserve the ADRs without assigning acceptance status.

Native `fetchQuery` remains a deprecated alias in the inspected newer core.
Unrelated native callsites need no mechanical rename to adopt these helpers.
Whispering's startup read error classification must survive any later change
from `fetchQuery` to `query` or a Result runner.

## Verification gates

The implementation is done when these checks pass on its own baseline:

- Library `bun test`, `bun run typecheck`, and `bun run build`, including public
  type usage against the supported framework adapters.
- Dashboard runtime tests cover late old reads/mutations, fresh clients, and
  exact generated keys. New policy coverage proves invalidation after observer
  removal and no completed-purchase claim for a returned checkout URL.
- Folder tests cover refresh after writes, active-reader polling, and close
  ordering with unchanged positional key matching.
- Whispering tests cover capture completion/cancellation, command refusal after
  closing, admitted-stage draining, recorder-owned settling, Result failures,
  unchanged provider request counts, and retry of failed result publication.
  Test replies before and after the cutoff, cutoff during preparation, and
  finalization registration before storage closes. No mutation-cache event is
  required for correctness or test synchronization.
- Whispering's `page-boundary.test.ts`, mounted route tests, browser build, and
  host build preserve the platform seam and one mounted product lifetime.
- No production importer uses a removed Wellcrafted export. No compatibility
  `defineMutation` shim or second cache/workflow layer remains.

Use the package scripts declared in `apps/whispering/package.json`,
`apps/api/ui/package.json`, and `packages/svelte/package.json`; the two apps
have separate browser/host and Svelte checks. Existing unrelated working-tree
changes need their own baseline before attributing a failure to this migration.

## Evidence

- `apps/api/ui/src/lib/billing/{api,queries}.ts` and
  `dashboard/{runtime.ts,runtime.test.ts}` establish the regular service mapping
  and attachment isolation.
- `apps/whispering/src/lib/library.svelte.ts`, `runs.svelte.ts`, `file-reads.ts`,
  `runs-lifecycle.test.ts`, and `capture-lifecycle.test.ts` establish workflow,
  key, and close behavior.
- `packages/svelte/src/folder-{queries,context}.ts` establish path/representation
  keys, change-driven refresh, and query-context consumers.
- Wellcrafted `src/query/{index.ts,utils.ts,utils.test.ts}` establishes the
  0.45 exports, runner signatures, and Result conversion.
- Public package metadata: [Svelte Query 6.3.5](https://registry.npmjs.org/@tanstack%2Fsvelte-query/6.3.5),
  [Svelte Query devtools 6.3.5](https://registry.npmjs.org/@tanstack%2Fsvelte-query-devtools/6.3.5),
  and [Wellcrafted 0.45.0](https://registry.npmjs.org/wellcrafted/0.45.0).
