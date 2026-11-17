---
name: svelte
description: Apply Epicenter’s Svelte 5 patterns for runes, components, lifecycles, and input ownership. Use when editing `.svelte`, `.svelte.ts`, or Svelte UI state.
---

# Svelte Guidelines

Use Svelte's ownership, reactivity, and lifecycle rules to carry the intended design through its components.

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
- Check [TanStack Svelte Query `createMutation`](https://tanstack.com/query/latest/docs/framework/svelte/reference/functions/createMutation) and local installed types before changing mutation lifecycle guidance.

## Upstream Grounding

When Svelte 5 runes, compiler behavior, lifecycle, reactivity, snippets, or template behavior affect correctness, use source-backed grounding before relying on memory. If DeepWiki MCP is available, ask a narrow question against `sveltejs/svelte`; for SvelteKit integration, ask against `sveltejs/kit`; for shadcn-svelte or extras component APIs, ask against `huntabyte/shadcn-svelte` or `ieedan/shadcn-svelte-extras`. If DeepWiki is unavailable or the repo is not indexed, use upstream source or official docs directly. Treat DeepWiki as orientation, then verify decisive details against local installed types, source, or official docs before changing code.

Skip DeepWiki for stable basics and repo-local patterns already documented here or in references.

## Related Skills

- `query-layer`: TanStack Query integration
- `error-handling`: carry Results through operations, then present outcomes at the interaction boundary; includes tagged errors, `$lib/report`, and `extractErrorMessage`
- `styling`: CSS and Tailwind conventions, including the flex column scroll trap
- `ui-design`: visual direction plus loading, empty, pending, tooltip, and component selection patterns

## Reconsider the relevant system

Establish what the interaction should make possible before choosing local
cleanup. Carry forward agreed intent; clarify genuinely unresolved purposes and
consequential tradeoffs. Read the whole component and follow the relevant
callers and owners to identify the system responsible for that behavior. The
relevant whole may extend across components, capabilities, or the app.

Develop a coherent account of how you would organize that system today. Treat
existing functions, state, effects, ownership, and component boundaries as
choices you can reconsider. Repeated decisions, mirrored state, and
compensating effects are clues to examine: they can reveal a missing owner, or
they can carry a real distinction. When the arrangement itself is in question,
borrow the reasoning in [collapse-pass](../collapse-pass/SKILL.md) and
[rethink](../rethink/SKILL.md) to find one that can make several local fixes
unnecessary; that reasoning serves this task without starting a separate
workflow. Let that understanding determine the edits. Scale investigation to
the uncertainty; a local change can still be the best result.

Before moving coordination to another owner, ask whether simpler product
behavior could make it unnecessary. Trace the mechanism to the promise it
serves; consider whether a native control or simpler workflow could do the job
without the repair. Use [product-collapse](../product-collapse/SKILL.md) to
develop changes to the experience with the user, making gains and losses
explicit. Carry forward product choices already settled in the conversation.

Moving behavior to a different owner is implementation work within the
authorized outcome; explain the structural change, and ask only when it would
change behavior, contracts, or guarantees the user has not settled. Show
interactions or caller code when they make the consequences concrete.
Preserve required behavior and unfinished input; make intended changes to
behavior or contracts explicit.

## State and handler defaults

Bindings, state, and refs should earn their place. For each one, ask what would
let you remove it and whether the result would be simpler. Keep it when you can
name the reader, interaction, or lifetime that depends on it. A submit handler
can pass a value directly. A live preview needs to follow it as the person types.
Replacing a binding with a ref, dirty flags, and reset effects can remove a
rune while giving the component more state to keep in sync.

Let the element or UI component own its unfinished value
or open state when no outside reader needs it. Styled native inputs can hold
text without an application draft; widgets can manage their own open state.
Bind when the application must observe or control the value. Choose the
primitive by its interaction and visual contract under
[ui-design](../ui-design/references/component-system.md#choose-the-interaction-contract),
rather than by whether it avoids `$state`. An element can own attached DOM
behavior; keep separate state for independent information.
When an identity change should reset a control, key only that owner;
keep surrounding navigation outside the key so its focused controls survive.

Choose the trigger as well as the owner. A submitted operation's outcome
belongs to its completion path; DOM behavior responding to a view transition
can belong in an effect. A previous value may carry the history needed to
recognize that transition.

Compare the complete obligations, including what each caller must remember.
Moving one reaction into several completion hooks redistributes a rule;
removing an effect alone is no collapse. A relocation can improve ownership
without reducing coordination. Explain what state, synchronization, or required
wiring disappears and what the new owner takes on. Keep the current arrangement
when the alternative only moves those obligations.

When a caller must coordinate sanitization, content policy, and a rendering
container for one safe view, let one component own the whole content boundary.
Keep the cooperating steps private; callers pass source content and presentation
such as a notices snippet. The safety work remains, but callers no longer have
to match permissions, order transformations, or configure the container's
safeguards. Keep queries and retries with their own lifecycle owner. Local
permission state still carries a real choice: reset it by content identity when
required, rather than recreating the renderer on every query refresh.

Choose the owner before declaring state or extracting a handler:

- Use `createQuery` for asynchronous reads the UI observes. Use `createMutation` when the UI observes a user-triggered operation's data or lifecycle. A final toast alone can use direct `await`. Existing reactive capabilities and editors already own their reads. See [query-layer](../query-layer/SKILL.md) for local versus shared options and operation lifetimes.
- Use `$state` for independent UI information: drafts with live readers, validation, search, selection, dialogs, undo, streams, cancellation, failure receipts, and workflow progress. Keep server state in its query cache.
- For input read only at submission, let the control hold its unfinished value; styled native inputs follow the same rule. Use reactive drafts when live readers or persistence need them. Capture submitted values, identity, and reviewed versions before async work, and preserve later edits when applying results. See [input ownership](references/input-ownership.md).
- Inline the handler when you have to jump to another function just to find the call it makes. A guard or a few submission steps can stay beside the control. Keep a name when it explains parsing, persistence, a shared rule, a sequence with its own failure handling, or preserves identity that a consumer observes. Preserve evaluation timing, including `tick()` boundaries, and callback lifetime when moving code. See [single-use functions and aliases](references/component-ui-patterns.md#single-use-functions-and-aliases) and [callback lifetime and timing](../query-layer/references/mutation-lifecycle.md#callback-lifetime-and-timing).

## Svelte 5 Baseline

- Use `$state` for reactive in-place updates and `$state.raw` for replace-only values. Reach for raw state when the deep proxy buys reactivity you never use, such as a replace-only persisted store whose value is serialized or compared by reference. See [raw, snapshot and freezing](references/input-ownership.md#raw-snapshot-and-freezing) for proxy and submission boundaries.
- Prefer `$derived` for computed state. Treat `$effect` as a browser-only escape hatch for DOM integration, analytics, subscriptions, and external systems. A returned cleanup runs before the effect re-runs and when the component is destroyed.
- Props can change. Compute changing values with `$derived` or read the prop directly where used. Initialize an adapter once only when its owner is fixed for that component instance; reactive properties do not imply changing adapter identity. Read [lifecycle and reactivity](references/lifecycle-and-reactivity.md).
- Treat props as parent-owned by default. Use callback props for commands and `$bindable` only for intentional two-way APIs such as UI wrappers, `bind:value`, `bind:open`, and `bind:ref`. Prefer `bind:value={get, set}` over paired read/write props on controlled inputs; see [function bindings](references/component-ui-patterns.md#function-bindings-for-transformed-values).
- Prefer snippets and `{@render}` over slots for new Svelte 5 code. Type exposed snippet props with `Snippet` from `svelte`; use tuple parameters such as `Snippet<[Row]>`.
- Avoid legacy patterns in runes-mode code: `$:` declarations, `export let`, `on:click`, `<slot>`, `<svelte:component>`, `<svelte:self>`, `beforeUpdate`, `afterUpdate`, and `createEventDispatcher`.
- Use event attributes and callback props: `onclick={...}`, `onkeydown={...}`, and `onSelect={() => ...}` style props. Do not add `on:` directives or dispatch component events in new runes-mode code.

## Core Decisions

- Keep template locals when deferred callbacks need type narrowing or consumers share a useful computation. See [template locals](references/component-ui-patterns.md#template-locals-narrow-reactive-values-before-use).
- Adapt a capability once with `reactive(capability)` where it is made. Keep its read methods and actions. If it seems to need a Svelte-specific facade, examine the capability's API. See [stable adapters and reactive reads](references/lifecycle-and-reactivity.md#stable-adapters-and-reactive-reads) for tracking, snapshots, and narrowing.
- When a view and its disposable resource share an identity and lifetime, let `{#key}` or `{#if}` own their mount and unmount. Preserve an outer owner for state that must survive a resource change. Read [lifecycle and reactivity](references/lifecycle-and-reactivity.md) for setup phase and cleanup.
- If readiness is a stable promise, use `{#await}` in the template instead of a `$state(false)` flag and a cancellation effect.
- When several template branches render variants of an optional discriminated union, check presence once in an outer block, then branch on its discriminant inside. Repeated optional checks or a forwarding `$derived` alias obscure the shared presence condition; an isolated variant check can use optional chaining. See [optional union rendering](references/component-ui-patterns.md#render-optional-unions-presence-first).
- Prefer `satisfies Record` for exhaustive finite mappings to labels, icons, or other constant values. Use branching for conditions, computations, different markup, or variant-specific fields.
- Use `SvelteMap` for reactive keyed data and `SvelteSet` for reactive membership; use plain maps and sets for imperative-only reads. See [reactive collections](references/lifecycle-and-reactivity.md#reactive-collections) for value reactivity and stable projections.
- Bridge a non-store external event source (`window` events, an auth store) into reactivity with `createSubscriber` from `svelte/reactivity`, not a hand-rolled `$state` plus `$effect` plus listener set: reads inside an effect become reactive and the subscription is ref-counted to effect usage (start on first subscriber, cleanup at zero). A capability with `subscribe` needs none of this: `reactive` already does it (`packages/svelte/src/reactive.ts`). Keep a manual listener set only when the same source also serves imperative `.get()`/`.watch()` consumers whose liveness cannot ride on effect ref-counting.
- For new reusable DOM behavior on elements, prefer `{@attach}` attachments over new `use:` actions. Keep `use:` for existing code or libraries that only expose actions.
- For string attributes that combine plain text with expressions, use Svelte quoted interpolation (`label="Loading {name}"`, `href="/users/{id}"`) instead of a JavaScript template literal attribute. Keep expression attributes for non-string values, callbacks, objects, booleans, and cases where the entire attribute is a computed JavaScript expression.
- For file editor views, preserve unfinished edits and give the person a way to repair invalid content. See [file editor views](references/component-ui-patterns.md#file-editor-views).
- Keep simple component props inline. Use named `Props` only when a wrapper, generic relationship, exported contract, or native DOM type composition earns it. Push large view-mode branches into focused child components. Read [component and UI patterns](references/component-ui-patterns.md).
- Use local `@epicenter/ui` loading, empty, pending, and tooltip components before ad hoc markup.

## Reference Map

- Read [UI verification](../ui-design/references/verification.md) for visible or interactive changes: view screenshots for appearance, exercise changed interactions, and check desktop UI in the native app.
- Read [Lifecycle and reactivity](references/lifecycle-and-reactivity.md) for keyed resources, readiness promises, cleanup, stable owners, value maps, reactive collections, or state modules.
- When maintaining Whispering’s existing folder editors and `<WhenOpen>` layout, use [the folder and editor API](../../../packages/svelte/README.md#an-apps-folder).
- Read [query-layer](../query-layer/SKILL.md) for mutation arguments and shared options; read [mutation lifecycle](../query-layer/references/mutation-lifecycle.md) for callback ownership, ordering, admission guards, and retained variables.
- Read [mutation examples](references/mutation-examples.md) for complete async buttons, local exports, direct `await`, and the point at which an interaction needs a mutation.
- Read [Input ownership](references/input-ownership.md) for native controls, reactive drafts, commit-on-blur, submission cleanup, or proxy and snapshot choices.
- Read [Component and UI patterns](references/component-ui-patterns.md) when a change touches `@epicenter/ui` imports, `$props` typing, `$bindable`, function bindings, snippets, DOM attachments, dialog ownership, view boundaries, repetitive markup, single-use helper inlining, loading or empty states, derivation from an existing owner, or template text gotchas.
