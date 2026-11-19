---
name: query-layer
description: 'Compose Result-returning services into TanStack Query with Wellcrafted''s resultQueries and resultMutations, one invalidation rule per QueryClient, and composition by spread. Use when editing createQuery, createMutation, resultQueries, resultMutations, runQuery, runMutation, a QueryClient or MutationCache, cache keys, invalidation, or optimistic updates.'
metadata:
  author: epicenter
  version: '4.1'
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

## Compose a service into two maps

Wrap the reads a UI observes in `resultQueries` and the writes in
`resultMutations`. The first argument is the namespace, which starts every key;
the second names the service functions:

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

Each key is the namespace, then the method name. A query key also ends with the
call's arguments, kept together in one list:

```ts
billingQueries.usage.key                   // ['billing', 'usage']
billingQueries.usage(params).queryKey      // ['billing', 'usage', [params]]
billingMutations.checkoutTopUp.mutationKey // ['billing', 'checkoutTopUp']
```

The list keeps arguments apart from names, so an argument never reads as a
method or namespace. Use `.key` for defaults that cover every call of a method;
`.queryKey` is one cached answer, typed for `getQueryData` and `setQueryData`.
Every entry sends `Err` to TanStack's error path, so success callbacks, such as
a form reset, run only when the write succeeds.

- A query takes its method's own arguments. A mutation's method takes no
  arguments or one input object, and only that input reaches it.
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

### Group a feature's maps by resource

A namespace can have more than one part. When a feature holds several kinds of
data, give each kind its own map and keep the maps in a plain object. The
property names the resource, so each method can be a plain verb:

```ts
const folderMutations = {
	notes: resultMutations(['folder', 'notes'], {
		set: notes.set,
		replace: notes.replace,
		delete: notes.delete,
	}),
	settings: resultMutations(['folder', 'settings'], { set: folder.settings.set }),
	audio: resultMutations(['folder', 'audio'], {
		delete: folder.deleteAudio,
		deleteBefore: folder.deleteAudioBefore,
	}),
};
```

`folderMutations.notes.delete` is keyed `['folder', 'notes', 'delete']`. One
flat map is still fine when its methods read clearly together.

### Make writes take turns

TanStack runs writes in parallel. To run a group one at a time, in the order
they were made, give the group's key prefix a shared
[scope](https://tanstack.com/query/latest/docs/framework/react/guides/mutations#mutation-scopes):

```ts
queryClient.setMutationDefaults(['folder'], { scope: { id: 'folder' } });
```

Every mutation keyed under `['folder']` now waits for the one before it, and the
services stay unchanged. The prefix decides who waits, so key a write outside
it when it must not hold up the others: a slow transcription keyed `['runs']`
does not delay every save to the folder.

## Capture the submitted operation

Read data, pending, error, and submitted variables from their query or mutation.
First try removing local state that mirrors these values. Keep an independent
draft when the interface needs information the operation does not own.

Capture submitted values, record identity, and any reviewed version in the
interaction handler before calling `mutate(input)`, `mutateAsync(input)`, or
starting an awaited workflow. Let `mutationFn` receive that input. If someone
presses Send in thread A and opens thread B while the draft saves, the reply
still belongs to thread A. Capture the thread ID with the text at Send.
Read event or control values synchronously. Passing a live form or a callback
that reads the editor later changes which values the operation uses. Closures
over stable services or identity fixed for the component's lifetime remain useful.

Passing an object to `mutate` passes a reference. Check who can still change
it, including the receiving API. Capture the submitted fields or detach
mutable parts when needed. Replacing the draft on each edit can already
preserve the submission if its nested values also stay unchanged.

Svelte's [input ownership](../svelte/references/input-ownership.md) applies this
rule to native controls, reactive drafts, and completion-time clearing.

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
method: a plan-change preview sent as a POST is a query keyed by plan, enabled
while its dialog is open. Modelling it as a mutation would need
a reset before each use, a guard that its answer is for the open plan, and an
exception to the rule. If one write's refetches ever cost too much, Wellcrafted
documents a `meta.invalidates` opt-in; a precise list goes stale silently when a
new read starts depending on the write, so adopt it only for that measured cost.
Do not work out which reads a write affects by slicing its mutation key.

The rule covers one client. Code that creates a client per account or
connection gets one rule per client, and none touches another client's cache.

## Compose by spread

Put behavior where it applies:

| Applies to | Where | Example |
| --- | --- | --- |
| One use | Spread into the hook's options | `createQuery(() => ({ ...billingQueries.plans(), select: (p) => p.cards }))` |
| A method or namespace | Client defaults by key prefix | `queryClient.setQueryDefaults(billingQueries.overview.key, { refetchOnWindowFocus: 'always' })` |
| A variant several components share | Spread into `mutationOptions` and export it | below |

TanStack infers what a spread adds, including `select`. Matching defaults merge
in registration order, so register a broad prefix before a narrow one.
Spreading options and defining the same callback replaces it; preserve the
existing work, order, and awaited promises when extending one.

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

Put essential per-execution work in mutation options or that call's promise.
Per-call `mutate` callbacks belong to the latest observed interaction. Read
[mutation lifecycle](references/mutation-lifecycle.md) when changing callback
ownership, awaited completion, overlapping submissions, or sensitive inputs.

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
`staleTime: 'static'` to accept any cached value. Keep sequential workflows
linear with `mutateAsync` or `runMutation`. Call a service directly when no
consumer observes its data or operation lifecycle; presenting a final Result
as a toast alone does not require a mutation.

## Keep errors and choices where they belong

Service errors pass through the query layer unchanged as tagged errors.
TanStack carries them in `error`, and the component or report boundary decides
what a person sees. Add a local error only when the adapter discovers a failure
no lower layer owns. Choosing an implementation from settings or platform
belongs to the consuming operation (`services-layer`), not to a query entry.

## Name handles for what they hold

Name a query handle for its data and a mutation handle for its verb and noun:
`overview.data`, `topUp.mutate(...)`. When the map's method is a bare verb, the
handle adds the noun:

```ts
const deleteNote = createMutation(() => folderMutations.notes.delete);
```

Do not suffix handles with `Query` or `Mutation`. Give each control its own
mutation so each owns its pending and error state.
