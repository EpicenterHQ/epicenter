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
- `error-handling`: carry Results through operations, then present outcomes at the interaction boundary; includes tagged errors and `$lib/report`
- `styling`: CSS and Tailwind conventions, including the flex column scroll trap
- `ui-design`: visual direction plus loading, empty, pending, tooltip, and component selection patterns

## Svelte 5 Baseline

- Use `$state` for reactive values the component mutates in place. Use `$state.raw` for values that are only ever reassigned wholesale (large arrays, replace-only persisted stores, opaque handles): it stores by reference with no deep proxy, does not freeze, and reacts only to reassignment, so an in-place property write mutates the object without triggering reactivity or persistence (not an error, but not reactive either). Reach for it when the deep proxy buys reactivity you never use, and when stable value identity matters (for example a store whose value is JSON-serialized or compared by reference).
- Prefer `$derived` for computed state. Treat `$effect` as a browser-only escape hatch for DOM integration, analytics, subscriptions, and external systems. A returned cleanup runs before the effect re-runs and when the component is destroyed.
- Props can change. Compute changing values with `$derived` or read the prop directly where used. Initialize an adapter once only when its owner is fixed for that component instance; reactive properties do not imply changing adapter identity. Read [lifecycle and reactivity](references/lifecycle-and-reactivity.md).
- Treat props as parent-owned by default. Use callback props for commands and `$bindable` only for intentional two-way APIs such as UI wrappers, `bind:value`, `bind:open`, and `bind:ref`. Prefer `bind:value={get, set}` over paired read/write props on controlled inputs; see [function bindings](references/component-ui-patterns.md#function-bindings-for-transformed-values).
- Prefer snippets and `{@render}` over slots for new Svelte 5 code. Type exposed snippet props with `Snippet` from `svelte`; use tuple parameters such as `Snippet<[Row]>`.
- Avoid legacy patterns in runes-mode code: `$:` declarations, `export let`, `on:click`, `<slot>`, `<svelte:component>`, `<svelte:self>`, `beforeUpdate`, `afterUpdate`, and `createEventDispatcher`.
- Use event attributes and callback props: `onclick={...}`, `onkeydown={...}`, and `onSelect={() => ...}` style props. Do not add `on:` directives or dispatch component events in new runes-mode code.

## Core Decisions

- Use tracked getters for Svelte reactive reads and methods for ordinary passive reads. For contract apps, `fromClient` from `@epicenter/svelte/client` gives each collection tracked `items`, `invalid`, `loading`, and `error`; `get(args)` tracks when read reactively. Keep commands on the collection. This is the Svelte exception to the ordinary JavaScript and TypeScript preference for explicit read methods.
- For an app-owned, long-lived vanilla client with a Svelte facade, construct the client privately in one app module and export only the facade. Keep command methods on the facade. Replace synchronous, argument-free snapshot methods such as `getState()` with tracked properties such as `.state` when the client reports changes; the facade need not retain the old read method. A setup or event-handler read is a snapshot, while a template, `$derived`, or effect read tracks. Keep async operations, parameterized reads, and type guards callable.

- When a deferred binding callback loses the narrowing of an optional property, capture that value with `{@const}` in the nearest supported template scope containing the controls that need it, then narrow the local before creating the callbacks. Share one local across those controls; use `$derived` when script code also needs it or no existing template scope supports `{@const}` before the guard. Nested access alone does not require a local, and an already-narrowed value needs no extra alias. See [function bindings](references/component-ui-patterns.md#function-bindings-for-transformed-values) for the mechanism and examples.

- Choose [immediate editing or explicit submission](references/input-ownership.md) before adding content state. Immediate controls bind to the current editor and submit complete replacements. Explicit forms own one draft per submission, preferably a `$state.raw` object updated by replacement; ordinary proxied `$state` uses `$state.snapshot` when its API boundary needs plain data. Keep request, selection and widget state separate from this choice.

- If a disposable resource identity depends on a prop, let the parent own mount and unmount with `{#key}` or `{#if}`; open the resource synchronously in the child. Read [lifecycle and reactivity](references/lifecycle-and-reactivity.md).
- If readiness is a stable promise, use `{#await}` in the template instead of a `$state(false)` flag and a cancellation effect.
- Keep source reads and actions visible where used: read owner properties such as `session.current` or `files.notes.items` in markup, keep template locals that narrow them for controls, and inline forwarding handlers beside those controls, including short guards when they clarify the interaction. Keep a name when it explains substantial work or owns necessary behavior, including filtering notifications to effects. Access collections through their client (`files.notes`); keep locals for field editors or captured original methods. Read [component and UI patterns](references/component-ui-patterns.md) and [lifecycle and reactivity](references/lifecycle-and-reactivity.md).
- When several template branches render variants of an optional discriminated union, check presence once in an outer block, then branch on its discriminant inside. Keep immediate reads inline; repeated optional checks or a forwarding `$derived` alias obscure the shared presence condition. An isolated variant check can use optional chaining. See [optional union rendering](references/component-ui-patterns.md#render-optional-unions-presence-first).
- Map finite unions to labels, icons, or other values with a `satisfies Record` lookup, not nested ternaries or `$derived.by()` switches. Use template branches when variants render different markup or need variant-specific fields.
- Use `SvelteMap` for ID-keyed collections where `get`, `has`, `size`, or iteration should update reactively. Values inside a `SvelteMap` are not deep-proxied, so store reactive row objects or replace values when nested data changes. Convert maps to stable arrays with `$derived` before passing them to table-like consumers.
- Use `SvelteSet` for an id set whose membership (`has`, `size`, iteration) is read in a reactive or template context: `add`/`delete` then drive the UI directly, replacing `$state<string[]>` plus spread/filter reassignment. Reach for `SvelteMap` instead the moment the set needs to carry per-key data (a timestamp, a last error). Use a plain `Set`/`Map` (not the reactive class) when the collection is read only in imperative code, such as a subscription's listener bag: a reactive wrapper read outside any effect is cost with no reader.
- Read a contract's notes through `files.notes.items` from `fromClient` (`@epicenter/svelte/client`). A text input gets its own `fieldEdit(files.notes, args, field)` and shows failure inline with `<UnsavedEdit>`. Checkboxes, selects, and buttons write directly. The edit keeps typed text until its save answers. See [Contract reads and editing](references/lifecycle-and-reactivity.md#contract-reads-and-editing).
- Bridge a non-store external event source (`window` events, an auth store) into reactivity with `createSubscriber` from `svelte/reactivity`, not a hand-rolled `$state` plus `$effect` plus listener set: reads inside an effect become reactive and the subscription is ref-counted to effect usage (start on first subscriber, cleanup at zero). Keep a manual listener set only when the same source also serves imperative `.get()`/`.watch()` consumers whose liveness cannot ride on effect ref-counting.
- For new reusable DOM behavior on elements, prefer `{@attach}` attachments over new `use:` actions. Keep `use:` for existing code or libraries that only expose actions.
- Create TanStack Query mutations in `.svelte` files and call `mutation.mutate(...)` directly from template handlers unless the action earns a semantic helper. Read [mutations and workspace inputs](references/mutations-and-workspace-inputs.md).
- For legacy Y.Map value fields, see the commit-on-blur policy in [mutations and workspace inputs](references/mutations-and-workspace-inputs.md). Do not apply that policy to Folder row editors, which accept input immediately and own their publication queue.
- For string attributes that combine plain text with expressions, use Svelte quoted interpolation (`label="Loading {name}"`, `href="/users/{id}"`) instead of a JavaScript template literal attribute. Keep expression attributes for non-string values, callbacks, objects, booleans, and cases where the entire attribute is a computed JavaScript expression.
- For file editor views, use [the editor ownership patterns](references/component-ui-patterns.md#file-editor-views): Files opens full text, product lists open structured controls, and invalid files have an explicit repair route. Key details by acquired editor identity. Shared text controls retire destroyed bindings; accepted input and saving stay with their owner above the view.
- Keep simple component props inline. Use named `Props` only when a wrapper, generic relationship, exported contract, or native DOM type composition earns it. Push large view-mode branches into focused child components. Read [component and UI patterns](references/component-ui-patterns.md).
- Use local `@epicenter/ui` loading, empty, pending, and tooltip components before ad hoc markup.

## Reference Map

- Read [Lifecycle and reactivity](references/lifecycle-and-reactivity.md) when a change touches keyed resources, readiness promises, `$effect` cleanup, shallow aliases, value maps, `SvelteMap`, table state, or `.svelte.ts` state modules.
- Read [Mutations and workspace inputs](references/mutations-and-workspace-inputs.md) when a change touches TanStack Query mutation placement, inline handlers, async button states, direct `await`, or workspace-backed text inputs.
- Read [Component and UI patterns](references/component-ui-patterns.md) when a change touches shadcn-svelte imports, `$props` typing, `$bindable`, snippets, DOM attachments, self-contained dialogs, view branching, repetitive markup, single-use helper inlining, loading or empty states, prop-first derivation, or template text gotchas.
