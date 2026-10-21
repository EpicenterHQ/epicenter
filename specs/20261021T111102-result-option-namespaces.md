# Result option namespaces and selective Epicenter adoption

**Date**: 2026-10-21
**Status**: Draft
**Owner**: Wellcrafted and Epicenter maintainers

## One sentence

Add Wellcrafted option namespace helpers for regular Result-service calls,
adopt them in the dashboard, and migrate Whispering's existing work adapters
without changing Folder reads or workflow lifetimes.

The helper runtime is unimplemented. Epicenter uses Wellcrafted 0.44.0 and
query-core 5.96.2; Wellcrafted's source and published 0.45.0 expose client-free
options adapters and Result runners. Completion requires a tested library
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
| `apps/whispering/src/lib/library.svelte.ts` | Scope-keyed `track`, fenced `action`, accepted-work draining | Keep those adapters; execute explicit `resultMutationOptions` through `runMutation` |
| `packages/svelte/src/folder-queries.ts` | Path/representation keys and context-aware generic readers | Replace removed `defineKeys` with plain tuple data/functions; keep reader API and key layout |
| Capture and other consumers of `resultMutationOptions` | Explicit local observation of app actions | Keep explicit options unless a real repeated service namespace appears |

The dashboard's `billingKeys` and `accountKeys`, repeated service argument
annotations, forwarding lambdas, and injected `createQueryFactories` plumbing
can disappear. Whispering's scope keys, action closures, and Folder's positional
key protocol contain independent information and remain.

## Review findings and decisions

Two independent reviews reconstructed the callers and challenged the proposal.
Both support selective adoption and preserving Whispering's resource/workflow
adapters. The strongest disagreement is whether a mutation namespace saves
enough beyond plain `resultMutationOptions`. Retain the two-helper proposal
within its small mapping contract; do not add a lifecycle registry, callback
merging, automatic invalidation, or per-domain wrapper factories to justify it.
An isolated or customized mutation can still use the explicit adapter.

| Decision | Basis | Consequence |
| --- | --- | --- |
| Keep separate read and mutation maps | Composition | Mutation policy can reference already-constructed query identities |
| Keep services independent of TanStack | Composition | Observation and cache relationships stay at the consuming edge |
| Bound query arguments in a final tuple | Executed key-collision check | Use `[...namespace, method, args]`; require readonly string namespace paths |
| Preserve supplied-argument identity | Native hashing and service signatures | No automatic trailing-undefined trimming; canonicalize before factory calls when required |
| Keep explicit Folder and Whispering adapters | Actual callers and lifecycle tests | No generic namespace wrapper around files, capture, inference, or `track` |
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

### Whispering action execution

Before, `apps/whispering/src/lib/library.svelte.ts:730`:

```ts
const mutation = defineMutation({
  mutationKey: keys.action(name),
  mutationFn: async (args: TArgs) => Ok(await work(...args)),
});
// Inside the returned function, after the refusal check:
const ran = await hold(local.run(() => mutation(args)));
```

Target:

```ts
const mutationOptions = resultMutationOptions({
  mutationKey: keys.action(name),
  mutationFn: async (args: TArgs) => Ok(await work(...args)),
});
// Inside the same returned function, after the same refusal check:
const ran = await hold(
  local.run(() => runMutation(queryClient, mutationOptions, args)),
);
```

Keep the public variadic action API, `refused()`, `hold`, `local.run`, and the
existing Result-to-message translation. A tuple already serves as the single
mutation variable; do not reshape every action into an object to fit a mapper.

### Whispering resource-scoped work

`track<T>` at `apps/whispering/src/lib/library.svelte.ts:516` becomes:

```ts
async function track<T>(work: () => Promise<T>, scope?: string): Promise<T> {
  const options = resultMutationOptions({
    mutationKey:
      scope === undefined ? keys.action('read') : keys.recording(scope),
    mutationFn: async () => Ok(await work()),
  });
  const ran = await hold(runMutation(queryClient, options, undefined));
  if (ran.error !== null) throw ran.error;
  return ran.data as T;
}
```

The third `runMutation` argument is required by the inspected 0.45 signature;
pass `undefined` for a void mutation. Preserve the outer `Ok`: some work
intentionally returns an inner Result which its caller inspects. Do not unwrap
that inner value as an incidental cleanup.

`audioOf` uses `isMutating({ mutationKey: keys.recording(entry.path) })` to
derive settling state. That per-recording key is information the generic
operation-name mapper does not supply. Keep `whisperingKeys` as a plain typed
object after removing `defineKeys`; preserve every existing key value,
including `['whispering', 'action', 'read']` in `runs-lifecycle.test.ts`.

## Whispering boundaries to preserve

- `FolderApp` owns the opened folder/context, and the mounted product survives
  route changes. No route creates another client, folder, or product owner.
- Folder's change channel and visible polling refresh file/row representations.
  Service mutation invalidation does not replace that channel. Saves and closing
  continue to finish without waiting for display rereads.
- File readers keep path/representation identity, generic table inference,
  query context, and audio cache policy. Do not put a `FileReader`, edit object,
  Blob, or AbortSignal into an automatically generated cache key.
- Capture owns a live microphone and its finalization. Inference workflows
  write their result rows before sending provider requests. Keep those workflow
  objects, deletion reservations, and result-save retry paths.
- Provider requests stay outside the Folder work that shutdown waits for
  (`runs.svelte.ts:459`). A stalled provider must not prevent closing, and
  retrying publication must not resend a paid request.

## Implementation plan

### 1. Prove and implement the library contract

- [ ] Add `createQueries` and `createMutations` beside the existing adapters,
  with no client capture, proxy, callback-merging overload, or invalidation DSL.
- [ ] Generate bounded query keys and ordinary operation mutation keys; prevent
  descriptors from replacing the generated identity or Result conversion.
- [ ] Prove heterogeneous shorthand/descriptor inference, zero/optional/multiple
  query arguments, void/unary mutation inputs, `select`, cache `DataTag`,
  `initialData` compatibility, and optimistic callback context. Reject unsupported
  multi-argument mutation functions with an explicit-adapter path.
- [ ] Test construction without execution, exact and prefix keys across nested
  namespaces, receiver handling, Result conversion, mutation callback ordering,
  observer departure, and shared policy through `runMutation`.
- [ ] Update the library query README and distributable TanStack skill, then
  validate the package and prepare a release containing the tested helpers.

The source runner already catches thrown work. An executed check confirmed
`Err` with the same thrown value and no success callback. Another check found
that `runMutation` also casts callback exceptions to the service error type;
that existing limitation is not a new exhaustive error guarantee. Keep cache
policy outside `mutationFn`, so a policy failure cannot retry a completed write.
Any broader runner error-model change is a separate decision.

### 2. Upgrade Epicenter directly to the final compatible shape

- [ ] Update the root dependency catalog and lockfile to the selected helper
  release and an aligned TanStack set; verify resolution from each real importer.
- [ ] In the same compatibility change, migrate all production imports of removed
  `defineKeys` and `createQueryFactories`. Do not land a dependency-only state
  that leaves consumers broken, or build a throwaway dashboard adapter layer.
- [ ] Compose dashboard maps in the existing runtime; translate consumers and
  runtime tests to native options and explicit Result runners.
- [ ] Replace `defineKeys` in Folder and Whispering with plain typed tuples,
  preserving their layouts. Replace Whispering's two mutation execution sites
  as shown, without converting them into service namespaces.

### 3. Establish shared app policy and prove behavior

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
- Whispering tests cover capture completion/cancellation, action refusal after
  closing, accepted-write draining, per-recording settling, inner Results,
  unchanged provider request counts, and retry of failed result publication.
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
