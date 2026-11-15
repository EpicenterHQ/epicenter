# Mutation lifecycle

Use this reference when completion work must survive overlapping submissions,
an observer reset or unmount, or when callback ordering or cached input matters.
[Query-layer](../SKILL.md) owns operation inputs, composition, and invalidation.

## Callback lifetime and timing

Place completion work according to which executions and lifetime it belongs to:

- Current-interaction UI reactions can use `mutate(input, { onSuccess,
  onError })`. These callbacks require a subscribed observer and belong to its
  latest call; they may be skipped after unmount, `reset()`, or a newer call.
- Per-execution work belongs in the operation, its mutation options, or the
  outcome handler of that call's `mutateAsync` promise. For overlapping
  submissions, each `mutateAsync(input).then(success, failure)` handles its own
  outcome, including essential failure recovery.
- Required persistence cleanup stays with its owner when a component can
  unmount. Promise continuations and mutation-option callbacks can still run
  after the component goes away; guard mounted UI work where that matters.
  They do not make a request durable across closing the page.

TanStack awaits mutation-option callback promises before completing the
mutation; second-argument `mutate` callback return values are ignored. Use
`onSuccess` or `onSettled` for the required phase; success-only work in
`onSettled` must check its error argument. The QueryClient's invalidation rule
can keep the mutation pending through read refresh, so verify ordering in the
installed query-core when a change depends on that refresh finishing.

Moving a handler into markup does not change which execution owns its work.
Preserve submitted values, IDs, and request-local abort controllers. Use current
shared state when applying the result, as described in Svelte's
[read timing examples](../../svelte/references/component-ui-patterns.md#preserve-read-timing).

The upstream [consecutive mutations guide](https://tanstack.com/query/latest/docs/framework/react/guides/mutations#consecutive-mutations)
describes observer callback behavior. Framework adapters share query-core;
check its installed `mutationObserver.ts` and `mutation.ts` for deciding details.

## Pending controls and admission

Read pending state from the mutation for rendering. A control may need to stay
disabled until its initial read is available and through a write's awaited
refresh when overlapping changes would race with optimistic updates or rollback.

Preserve an existing synchronous admission guard when it prevents duplicate
calls before observer notifications reach the template. A disabled button
alone does not establish that stronger guarantee.

## Retained variables

Mutations keep submitted variables and outcomes in their runtime cache until
entries are removed. Completing, submitting again, or calling `reset()` does
not erase earlier entries. Cache-wide callbacks, devtools, and persisters can
inspect this state. Establish stricter sensitive-value retention requirements
at the app, query, or service boundary, without replacing value snapshots with
live DOM references or promising secret erasure from a form reset.
