---
name: query-layer
description: 'Compose Result-returning services into TanStack Query with Wellcrafted''s resultQueries and resultMutations, one invalidation rule per QueryClient, and composition by spread. Use when editing createQuery, createMutation, resultQueries, resultMutations, resultQueryOptions, resultMutationOptions, runQuery, runMutation, a QueryClient or MutationCache, cache keys, invalidation, or optimistic updates.'
metadata:
  author: epicenter
  version: '4.0'
---

# Query layer

The query layer turns Result-returning services into TanStack Query options
for UI to observe. Services stay TanStack-free and return Results; the layer
adds cache identity, observation, and refresh after writes. Everything in it is
plain TanStack options, so TanStack's own mechanisms do the composing.

Related skills: `services-layer` for the services these consume, `svelte` for
component-level hook use, `error-handling` for presenting a failure.

## Ground before relying on memory

Ground the Wellcrafted side in `wellcrafted/query` as installed (0.47, source
and README in [wellcrafted-dev/wellcrafted](https://github.com/wellcrafted-dev/wellcrafted/tree/main/src/query)).
When TanStack behavior affects correctness, such as invalidation, mutation
callback order, or adapter types, ask DeepWiki a narrow question about
`TanStack/query`, then confirm the deciding detail in the installed
`@tanstack/query-core` source. Skip this for the patterns below.

## Compose a service in two maps

List the reads and the writes a UI observes, under one namespace. The dashboard
does this for its billing API (`apps/api/ui/src/lib/dashboard/runtime.ts`):

```ts
const billingQueries = resultQueries(['billing'], {
	overview: billingApi.overview,
	usage: billingApi.usage,
	plans: billingApi.plans,
});

const billingMutations = resultMutations(['billing'], {
	checkoutPlan: billingApi.checkoutPlan,
	checkoutTopUp: billingApi.checkoutTopUp,
});
```

- A query entry takes the method's own arguments and returns options keyed
  `[namespace, method, [args]]`. `billingQueries.usage.key` is the prefix of
  every argument variant; `billingQueries.usage(params).queryKey` is one entry,
  typed for `getQueryData` and `setQueryData`.
- A mutation entry is the options object itself, keyed `[namespace, method]`.
  Its method takes zero arguments or one input object; only that input reaches
  it.
- Pass functions only: bound methods or closures, with annotated parameters on
  a new wrapper. A wrapper that fixes a transport option is fine:
  `session: () => management.getSession({ query: { disableCookieCache: true } })`.
- Query arguments become the key. Keep them stable and serializable, and
  normalize before calling the factory when `f()` and `f(undefined)` should
  share an entry.

Hooks take entries directly, with no `.options` hop:

```svelte
const overview = createQuery(() => billingQueries.overview());
const topUp = createMutation(() => billingMutations.checkoutTopUp);
topUp.mutate({ successUrl: window.location.href }, { onSuccess, onError });
```

Use `resultQueryOptions` or `resultMutationOptions` for one function outside a
namespace, a key that is not `[namespace, method, args]`, or a query that needs
TanStack's context, such as its abort signal. Namespace entries never see it.

## One rule refreshes reads after every write

Give each QueryClient one `MutationCache` rule, where the client is created:

```ts
const queryClient = new QueryClient({
	mutationCache: new MutationCache({
		onSettled: (_data, _error, _variables, _rollback, _mutation, { client }) =>
			client.invalidateQueries(),
	}),
});
```

After any write, finished or failed, every query goes stale. Only observed
queries refetch now; the rest refetch when next used. The rule reads nothing
from the write's key, so it cannot miss a read elsewhere, and it runs alongside
an entry's own callbacks, so a spread cannot drop it. Returning the promise
keeps the write pending until what is on screen is fresh.

So do not call `invalidateQueries` after a write in a component or a mutation
callback. An operation that changes nothing is a read, whatever its HTTP
method: the dashboard's plan-change preview is a POST, and it is a query keyed
by plan, enabled while its dialog is open. Modelling it as a mutation would need
a reset before each use, a guard that its answer is for the open plan, and an
exception to the rule. If one write's refetches ever cost too much, Wellcrafted
documents a `meta.invalidates` opt-in; a precise list goes stale silently when a
new read starts depending on the write, so adopt it only for that measured cost.
Do not derive a write's scope from its mutation key.

The rule's scope is the client. The dashboard creates one per attachment, so
its rule never touches another attachment's cache.

## Compose by spread

Behavior goes where its scope is:

| Scope | Where | Example |
| --- | --- | --- |
| One use | Spread into the hook's options | `createQuery(() => ({ ...billingQueries.plans(), select: (p) => p.cards }))` |
| A method or namespace | Client defaults by key prefix | `queryClient.setQueryDefaults(billingQueries.overview.key, { refetchOnWindowFocus: 'always' })` |
| A variant several components share | Spread into `mutationOptions` and export it | below |

TanStack infers what a spread adds, including `select`. Matching defaults merge
in registration order, so register a broad prefix before a narrow one.

A shared variant reaches the cache through the query factories' keys, so define
the reads first; writes refer to reads, never the reverse:

```ts
export const updateUser = mutationOptions({
	...userMutations.update,
	onSuccess: (saved, _input, _rollback, { client }) =>
		client.setQueryData(userQueries.get(saved.id).queryKey, saved),
});
```

For an optimistic change shown in one place, render `mutation.variables` while
the write is pending and leave the cache alone: there is nothing to roll back.
Update the cache in `onMutate`, cancel the read first, and restore the snapshot
in `onError` only when several places must show the change at once.

## Run options imperatively

Outside a hook, or when a handler needs the outcome as a Result, run the same
options through the client:

```ts
const { error } = await runMutation(queryClient, accountMutations.deletePasskey, {
	id: passkey.id,
});
if (error) return reportError(error, 'Could not remove this passkey.');
```

`runMutation` goes through the mutation cache, so the rule, devtools, and
`useIsMutating` see the write. `runQuery(client, options)` reads through the
cache and returns `Result<TData, TError | CancelledError>`; pass
`staleTime: 'static'` to accept any cached value. Call a service directly when
nothing observes its data.

## Keep errors and choices where they belong

Service errors pass through the query layer unchanged as tagged errors.
TanStack carries them in `error`, and the component or report boundary decides
what a person sees. Add a local error only when the adapter discovers a failure
no lower layer owns. Choosing an implementation from settings or platform
belongs to the consuming operation (`services-layer`), not to a query entry.

## Name handles for what they hold

Name a query handle for its data and a mutation handle for its verb and noun:
`overview.data`, `topUp.mutate(...)`, `deletePasskey`. Keep the action's verb;
`delete` alone is reserved, so add the noun. Do not suffix handles with `Query`
or `Mutation`. Give each control its own mutation so each owns its pending and
error state.
