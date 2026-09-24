---
name: svelte
description: Apply Epicenter’s Svelte 5 patterns for runes, components, lifecycles, and workspace-backed state. Use when editing `.svelte`, `.svelte.ts`, or Svelte UI state.
---

# Svelte Guidelines

Keep the first pass focused on Svelte runes, component lifecycle, workspace-backed state, TanStack Query usage, and local UI composition.

## Reference Repositories

- [Svelte](https://github.com/sveltejs/svelte): Svelte 5 framework with runes and fine-grained reactivity
- [shadcn-svelte](https://github.com/huntabyte/shadcn-svelte): Port of shadcn/ui for Svelte with Bits UI primitives
- [shadcn-svelte-extras](https://github.com/ieedan/shadcn-svelte-extras): Additional components for shadcn-svelte

## Source Checks

- Check [Svelte `$props`](https://svelte.dev/docs/svelte/$props), [`$bindable`](https://svelte.dev/docs/svelte/$bindable), and [snippets](https://svelte.dev/docs/svelte/snippet) before changing prop ownership, `bind:` APIs, or `children` snippet typing rules.
- Check [Svelte `{#key}`](https://svelte.dev/docs/svelte/key), [`{#await}`](https://svelte.dev/docs/svelte/await), and [lifecycle hooks](https://svelte.dev/docs/svelte/lifecycle-hooks) before changing keyed resource or async readiness guidance.
- Check [Svelte `{@attach}`](https://svelte.dev/docs/svelte/@attach), [`use:`](https://svelte.dev/docs/svelte/use), and [`svelte/attachments`](https://svelte.dev/docs/svelte/svelte-attachments) before changing reusable DOM behavior, actions, or attachment guidance.
- Check [Svelte `svelte/reactivity`](https://svelte.dev/docs/svelte/svelte-reactivity) before changing `SvelteMap`, `SvelteSet`, or reactive collection guidance.
- Check the [Svelte 5 migration guide](https://svelte.dev/docs/svelte/v5-migration-guide) before changing legacy API avoidance, event syntax, slot migration, or callback-prop guidance.
- Check [TanStack Svelte Query `createMutation`](https://tanstack.com/query/v5/docs/framework/svelte/reference/functions/createMutation) and local installed types before changing mutation lifecycle guidance.

## Upstream Grounding

When Svelte 5 runes, compiler behavior, lifecycle, reactivity, snippets, or template behavior affect correctness, use source-backed grounding before relying on memory. If DeepWiki MCP is available, ask a narrow question against `sveltejs/svelte`; for SvelteKit integration, ask against `sveltejs/kit`; for shadcn-svelte or extras component APIs, ask against `huntabyte/shadcn-svelte` or `ieedan/shadcn-svelte-extras`. If DeepWiki is unavailable or the repo is not indexed, use upstream source or official docs directly. Treat DeepWiki as orientation, then verify decisive details against local installed types, source, or official docs before changing code.

Skip DeepWiki for stable basics and repo-local patterns already documented here or in references.

## Related Skills

- `query-layer`: TanStack Query integration
- `error-handling`: `$lib/report`, `extractErrorMessage`, and component error handling
- `styling`: CSS and Tailwind conventions, including the flex column scroll trap
- `ui-design`: visual direction plus loading, empty, pending, tooltip, and component selection patterns

## Svelte 5 Baseline

- Use `$state` for reactive values the component mutates in place. Use `$state.raw` for values that are only ever reassigned wholesale (large arrays, replace-only persisted stores, opaque handles): it stores by reference with no deep proxy, does not freeze, and reacts only to reassignment, so an in-place property write mutates the object without triggering reactivity or persistence (not an error, but not reactive either). Reach for it when the deep proxy buys reactivity you never use, and when stable value identity matters (for example a store whose value is JSON-serialized or compared by reference). Exemplar: `createPersistedState` in `packages/svelte`.
- Prefer `$derived` for computed state. Treat `$effect` as a browser-only escape hatch for DOM integration, analytics, subscriptions, and external systems. A returned cleanup runs before the effect re-runs and when the component is destroyed.
- Props can change. Values derived from `$props()` should usually be `$derived`, not one-time initialization.
- Treat props as parent-owned by default. Use callback props for commands and `$bindable` only for intentional two-way APIs such as UI wrappers, `bind:value`, `bind:open`, and `bind:ref`.
- Prefer snippets and `{@render}` over slots for new Svelte 5 code. Type exposed snippet props with `Snippet` from `svelte`; use tuple parameters such as `Snippet<[Row]>`.
- Avoid legacy patterns in runes-mode code: `$:` declarations, `export let`, `on:click`, `<slot>`, `<svelte:component>`, `<svelte:self>`, `beforeUpdate`, `afterUpdate`, and `createEventDispatcher`.
- Use event attributes and callback props: `onclick={...}`, `onkeydown={...}`, and `onSelect={() => ...}` style props. Do not add `on:` directives or dispatch component events in new runes-mode code.

## Core Decisions

- If a disposable resource identity depends on a prop, let the parent own mount and unmount with `{#key}` or `{#if}`; open the resource synchronously in the child. Read [lifecycle and reactivity](references/lifecycle-and-reactivity.md).
- If readiness is a stable promise, use `{#await}` in the template instead of a `$state(false)` flag and a cancellation effect.
- Inline shallow property aliases and single-use script helpers (a `function`, `$derived`, or one-off `const` used once in the template). Keep one extracted only when it computes, narrows, or stabilizes something useful, or when a justifying comment plus a semantic name makes the template read better. Read [component and UI patterns](references/component-ui-patterns.md).
- Map finite unions with a `satisfies Record` lookup, not nested ternaries or `$derived.by()` switches.
- Use `SvelteMap` for ID-keyed collections where `get`, `has`, `size`, or iteration should update reactively. Values inside a `SvelteMap` are not deep-proxied, so store reactive row objects or replace values when nested data changes. Convert maps to stable arrays with `$derived` before passing them to table-like consumers.
- Use `SvelteSet` for an id set whose membership (`has`, `size`, iteration) is read in a reactive or template context: `add`/`delete` then drive the UI directly, replacing `$state<string[]>` plus spread/filter reassignment. Reach for `SvelteMap` instead the moment the set needs to carry per-key data (a timestamp, a last error). Use a plain `Set`/`Map` (not the reactive class) when the collection is read only in imperative code, such as a subscription's listener bag: a reactive wrapper read outside any effect is cost with no reader (exemplar: the plain `listeners` set in `createPersistedState`).
- Read Epicenter store data through `fromData` from `@epicenter/svelte`: it mirrors an opened database's declared `tables`/`kv` plus `persistence`, makes every read reactive, and passes writes through. A table is HELD as a live `SvelteMap` projection keyed by row id, seeded on the first `fromData` call for a raw store and patched with the ids each commit names. Repeated calls with that same raw store return the same projection without walking tables or subscribing again; a declared table nothing renders is still walked on the first call; `kv` and `persistence` stay read-through on `createSubscriber`. Nothing is torn down and nothing is disposed by hand: the projection dies with the document. Do not hand-roll `db.<table>.subscribe(listener)` feeding `$state.raw` for table reads; `$derived` over `table.rows` does the filtering and sorting. For one value off a source that is not a table, use `fromSubscription(subscribe, read)` rather than writing `createSubscriber` by hand. Adapter: `packages/svelte/src/from-data.svelte.ts`; app exemplar: `apps/honeycrisp/src/routes/components/Notes.svelte`.
- Bridge a non-store external event source (`window` events, an auth store) into reactivity with `createSubscriber` from `svelte/reactivity`, not a hand-rolled `$state` plus `$effect` plus listener set: reads inside an effect become reactive and the subscription is ref-counted to effect usage (start on first subscriber, cleanup at zero). Exemplar: `packages/auth/src/svelte/auth.svelte.ts`. Keep a manual listener set only when the same source also serves imperative `.get()`/`.watch()` consumers whose liveness cannot ride on effect ref-counting (again `createPersistedState`).
- For new reusable DOM behavior on elements, prefer `{@attach}` attachments over new `use:` actions. Keep `use:` for existing code or libraries that only expose actions.
- Create TanStack Query mutations in `.svelte` files and call `mutation.mutate(...)` directly from template handlers unless the action earns a semantic helper. Read [mutations and workspace inputs](references/mutations-and-workspace-inputs.md).
- For workspace string fields, prefer commit-on-blur over writing a CRDT transaction on every keystroke.
- For string attributes that combine plain text with expressions, use Svelte quoted interpolation (`label="Loading {name}"`, `href="/users/{id}"`) instead of a JavaScript template literal attribute. Keep expression attributes for non-string values, callbacks, objects, booleans, and cases where the entire attribute is a computed JavaScript expression.
- Keep simple component props inline. Use named `Props` only when a wrapper, generic relationship, exported contract, or native DOM type composition earns it. Push large view-mode branches into focused child components. Read [component and UI patterns](references/component-ui-patterns.md).
- Use local `@epicenter/ui` loading, empty, pending, and tooltip components before ad hoc markup.

## Reference Map

- Read [Lifecycle and reactivity](references/lifecycle-and-reactivity.md) when a change touches keyed resources, readiness promises, `$effect` cleanup, shallow aliases, value maps, `SvelteMap`, table state, or `.svelte.ts` state modules.
- Read [Mutations and workspace inputs](references/mutations-and-workspace-inputs.md) when a change touches TanStack Query mutation placement, inline handlers, async button states, direct `await`, or workspace-backed text inputs.
- Read [Component and UI patterns](references/component-ui-patterns.md) when a change touches shadcn-svelte imports, `$props` typing, `$bindable`, snippets, DOM attachments, self-contained dialogs, view branching, repetitive markup, single-use helper inlining, loading or empty states, prop-first derivation, or template text gotchas.
