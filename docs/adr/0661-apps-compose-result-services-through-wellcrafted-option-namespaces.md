# 0661. Apps compose Result services through Wellcrafted option namespaces

- **Status:** Proposed
- **Date:** 2026-10-21; revised 2026-11-11 for the merged helper shape
- **Built:** the dashboard (`apps/api/ui/src/lib/dashboard/runtime.ts`) composes billing and account through `resultQueries` and `resultMutations` from Wellcrafted 0.47, with the client-wide invalidation rule. The UIs of Capture, Reading, Tasks, and Vocab do the same over `connect()`, whose calls return `Result<Out, ActionError>` (`Changed`, `Missing`, `Threw`, `Refused`, `Unreachable`): each UI's `ui/src/lib/app.ts` lists its `reads` and `writes`, and its layout makes the QueryClient with `createQueryClient()` from its own `ui/src/lib/query-client.ts`, which carries the rule and builds on the UI's own `@tanstack/svelte-query`, so a bundle holds one TanStack Query. `@epicenter/app` does not depend on TanStack Query (2026-11-11).
<!-- doc-path-check: ignore-next-line (the ADR path belongs to the external Wellcrafted repository) -->
- **Relates:** [Wellcrafted](https://github.com/wellcrafted-dev/wellcrafted) and its own proposed ADR, `docs/adr/0001-result-namespaces-produce-native-tanstack-options.md`, for the library-owned conversion contract.

## Context

The dashboard's `apps/api/ui/src/lib/billing/queries.ts` repeats billing method
names in `billingKeys` and in `createBillingQueries`, then forwards arguments
through `defineQuery` and `defineMutation`. Account queries use the same
pattern. Components consume `.options`, and billing and account components
invalidate cached reads themselves: `PlanComparison.svelte`, the dashboard
page, and the account page each call `invalidateQueries` after a write.

The libraries and the app have different responsibilities. Wellcrafted can
derive keys and convert Results into native TanStack options. The application
knows whether an operation belongs in its query cache and which reads must be
fresh after a write.

Billing shows why those decisions cannot come from HTTP methods or Result
types. `usage`, `events`, and `previewPlanChange` are reads sent as POST.
`portal` uses GET to open a billing interaction. Checkout can return a payment
URL before a purchase completes.

`createDashboardRuntime(account)` also owns a boundary that the mapping must
preserve: one captured Account, its transport clients, and a fresh QueryClient
per dashboard attachment. Its tests cover late results after both different-
principal and same-principal replacement.

An Epicenter app's view reads and writes through `connect()`, whose methods are
the app's actions. Once those methods return Results, a view's whole query
layer is the same composition as the dashboard's.

## Decision

**An app lists the Result-returning functions it observes in two maps,
`resultQueries` for reads and `resultMutations` for writes, and composes
everything else with TanStack's own mechanisms.** The application owns
selection and cache policy; Wellcrafted owns key generation and Result
conversion. Wellcrafted 0.47 provides both helpers.

```ts
const books = resultQueries(['reading'], { list: app.list, get: app.get });
const write = resultMutations(['reading'], { set: app.set, finish: app.finish });

const book = createQuery(() => books.get({ path }));
const save = createMutation(() => write.set);
save.mutate(input, { onSuccess: () => closeDialog() });
```

A query entry takes the method's arguments and returns options keyed
`[...namespace, method, args]`; its `.key` is the prefix of every argument
variant. A mutation entry is the options object itself, keyed
`[...namespace, method]`.

A read whose key describes something other than a method and its arguments,
or whose function needs TanStack's query context, keeps explicit options
through `resultQueryOptions`. Work whose lifetime and activity already have an
application owner, such as an active recording, is not a mutation; an observer
describes a call, it does not own the work.

**Services keep their Result-returning API without TanStack annotations.**
Membership in a map states the app's observation choice. A selected function
may be a real wrapper that fixes transport arguments, binds its receiver, or
turns several arguments into one mutation input. Account reads still fix
`disableCookieCache: true` and select the nested passkey read. No per-domain
wrapper factory is required; the two maps can share one module.

### Every write refreshes what is on screen

**Each QueryClient has one `MutationCache` rule: after any write settles,
invalidate every query.**

```ts
new QueryClient({
  mutationCache: new MutationCache({
    onSettled: (_data, _error, _variables, _rollback, _mutation, { client }) =>
      client.invalidateQueries(),
  }),
});
```

Only observed queries refetch; the rest are marked stale and refetch when next
used. The rule reads nothing from a write's key, so it cannot miss a read in
another namespace, and a component spreading an entry cannot drop it. Returning
the promise keeps the write pending until what is on screen is fresh. The
component invalidation calls in billing and account disappear.

The rule has no exceptions. An operation that changes nothing is a read, so it
belongs in `resultQueries` whatever its HTTP method: `previewPlanChange` is a
query keyed by plan, enabled while its dialog is open, and a write refreshes
it because proration depends on the current plan. Checkout needs no exception
either. A returned checkout URL refetches billing reads, which still show the
unchanged plan; a refetch reports server state and makes no claim that a
purchase completed. If following one write with refetches ever costs too much,
Wellcrafted documents a `meta.invalidates` opt-in; adopt it for that measured
cost, not by default.

### Other behavior composes by spread

- **One use:** spread an entry into the hook's options,
  `createQuery(() => ({ ...billingQueries.events({ limit: 50 }), select }))`.
- **A method or namespace:** client defaults by key prefix. The billing
  overview's focus refetch becomes
  `client.setQueryDefaults(billingQueries.overview.key, { refetchOnWindowFocus: 'always' })`
  in the dashboard runtime.
- **A shared variant:** spread an entry into Svelte Query's `mutationOptions`
  and export it. It reaches the cache through the query factories' keys, so
  reads are composed before writes; writes refer to reads, never the reverse.

For an optimistic change shown in one place, a component renders
`mutation.variables` while the write is pending. A cache update with rollback
is for a change several places must show at once.

**The app runtime retains ownership of service and cache lifetimes.** For the
dashboard, compose the maps inside `createDashboardRuntime(account)` with its
captured transport clients, and give its fresh QueryClient the rule and
defaults. Hooks execute with that attachment's provider client; callbacks use
their executing `context.client`. Disposal retains the existing lifetime signal
and cache clearing. Neither principal identity alone nor a module singleton
replaces attachment identity. An Epicenter app's view has one page and one
QueryClient, so the rule's scope is that app.

Workflows that need Results run the same options through Wellcrafted's
`runQuery` or `runMutation`; `runMutation` goes through the mutation cache and
so through the rule. Direct service calls remain available and bypass the cache.

## Consequences

- Regular reads lose duplicated key maps, argument annotations, and forwarding
  functions. Component invalidation calls disappear into one rule per client.
- Invalidation errs toward refreshing too much; only observed reads refetch.
- Stable, serializable read arguments and method names determine generated
  identity. Custom keys or normalization use Wellcrafted's explicit adapters.
- Wellcrafted's runners require query-core 5.102 or later. Epicenter's catalog
  moved Wellcrafted, query-core, and the Svelte adapter together (0.47, 5.107,
  6.4); keep them aligned in later upgrades.
- The dashboard migration kept mutation pending/error state, checkout
  redirects, and the late-result isolation tests. Because the rule awaits the
  refetch, a checkout's redirect and a top-up's success toast now wait until
  active billing reads are fresh.
- An app's view refreshes after its own writes. Writes made elsewhere (agents,
  the CLI, another device, the clock) appear when the view is shown again; no
  timer polls. A view left open beside an agent shows its change on the next
  write or tab switch. A change stream from `serve` (`/.changes/<app>`, a
  folder watch) was built and set aside on `claude/change-stream` until a view
  needs to update while it is watched.
- An app's view shows a write before it lands by reading the pending
  mutations with `useMutationState`, not by writing to the cache, so there is
  no rollback to keep: when the write settles, the refreshed read takes over.

## Considered alternatives

- **Keep every definition handwritten.** Each key and forwarding function stays
  independent. Use that form for custom behavior.
- **Annotate transport services with query and invalidation policy.** A
  reusable capability would depend on one app's observations and cache layout.
- **Shared invalidation in each mutation definition**, the first version of
  this decision. Every write states which reads it affects, a precise list goes
  stale silently when a new read starts depending on a write, and a component
  spreading an entry with its own `onSuccess` drops it.
- **Derive scope from the mutation key**, such as `mutationKey.slice(0, -1)`.
  It guesses a write's scope from how keys are built and misses reads in other
  namespaces.
- **Configure invalidation at each component.** This duplicates policy and ties
  it to observers whose per-call callbacks may disappear on departure.
- **Descriptors in the maps** (`{ queryFn, refetchOnWindowFocus }`). Client
  defaults and spreading cover the same settings with TanStack's own inference.
