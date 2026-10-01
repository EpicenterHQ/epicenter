# 0392. Product boundaries provide required resource handles

- **Status:** Proposed
- **Date:** 2026-09-12
- **Amends:** [ADR-0369](0369-an-application-page-owns-one-library-and-changing-it-ends-the-page.md) at one-library opening and [ADR-0355](0355-local-and-account-sessions-share-the-application-data-api.md) at destination selection: products acquire concrete handles while store operations retain their common contract.
- **Amends:** [ADR-0413](0413-app-boot-owns-the-working-page-lifetime.md) at UI distribution: a required resource gates its working UI; an independent resource gates only its consumers. Ready handles can pass through props or typed Svelte context. The browser/WebView still owns the working lifetime.
- **Unbuilt:** Local still reaches routed consumers through a mutable module binding. Moving its ready distribution into a layout context remains open.

## Context

Whispering needs its Local recording store before the working shell can create a recorder or read device settings. Its Personal speech profile can open later. Waiting for Personal at the root would stop Local recording when an account store is slow or unavailable. Giving every descendant a pending or optional handle would instead make each editor repeat readiness and sign-in policy.

Whispering's two Personal editors sit immediately beneath their readiness branches. They receive the ready handle by prop, while Local still reaches many consumers through a once-initialized module binding. Store readiness and distributing a ready handle are separate decisions.

## Decision

**The mounted working layout gates only the resources required by the whole working UI.**

Whispering opens Local, including its required migration, before mounting the working shell. The shell may publish the ready Local handle through typed context when routed descendants need it. Local opening failure renders the root opening failure; it does not mount a recorder over partially prepared history. The working layout starts acquisition, not an import of a store definition or resource module. Callback, sign-out, recovery, and auxiliary routes do not acquire the primary roots. Browser sign-in can start in the working page because the next Account is installed only in the callback page; departure fences work and replaces the document.

**An independent resource gates the smallest UI branch that needs it.**

Whispering starts Personal opening for the captured Account without making Local wait for it. Its settings page renders Local controls while the Personal section waits. A pending Personal section shows loading; a signed-out section shows sign-in; a failed Personal opening shows failure. A ready section receives a definite reactive handle. Svelte's `{#await}` and `{:then}` express these branches directly. An absent opening may be `undefined`: Svelte renders a non-Promise through `{:then}` immediately. A signed-in opening failure remains a rejected promise, never an empty Personal store.

```svelte
<DeviceCleanupSettings />

{#await app.personalReady}
	<p role="status">Opening your speech profile…</p>
{:then personal}
	{#if personal}
		<PersonalSettings {personal} />
	{:else}
		<p>Sign in to use your speech profile.</p>
	{/if}
{:catch error}
	<p role="alert">Your speech profile could not open.</p>
{/await}
```

The opened store is adapted once for reactive Svelte reads. Workflows capture the same opening promise when they need Personal inputs; a delayed opening delays those inputs, while a rejected opening prevents silent use of signed-out defaults. Account replacement retires the working page rather than retargeting the handle.

**Use context when it removes real forwarding, and props when the ready consumer is nearby.**

The Local working shell can provide a required Local handle to many routed descendants. The two Personal controls can take the definite handle as a prop from their immediate `{:then}` branches. A provider may still earn its place for a later Personal subtree with many consumers and intervening components; it is not required by async readiness itself. Do not add a generic component with loading, ready, and error snippets solely to repeat `{#await}`. A shared boundary earns a component when it owns additional policy that several callers actually need.

Context and await blocks distribute and render handles. They do not cancel operations, close stores, prove persistence, or authorize a new Account. The working page's departure fence and the resource handles retain those responsibilities. A ready Personal editor never switches its write destination to Local if Personal fails.

## Consequences

Local controls and recording remain available while Personal opens or fails. Personal editors receive a definite store, so their writes need no optional-store guard. Whispering's two Personal UI call sites use direct await blocks and props in place of the former Personal boundary, provider, and context accessors. This repeats a small amount of loading, sign-in, and error presentation at those sites. If that policy grows or diverges, the callers show whether a shared boundary has earned a place.

An absent Personal opening and a rejected Personal opening remain distinct. Changing the existing always-Promise type to an optional promise requires workflow callers that use `.then()` to handle absence explicitly. The type change is independent of removing the provider and does not justify an eager module opening.

## Considered alternatives

- Gate the whole working UI on Local and Personal together: makes account profile latency or failure block device recording.
- Require a provider for every opened store: adds a component and ancestry contract even when the ready consumer is the direct child.
- Put all loading branches behind a generic snippet component: duplicates Svelte's await control flow without owning additional policy.
- Export eager live opening promises from an ordinary module: static imports can acquire roots in callback, sign-out, or recovery documents before the working layout mounts.

## Framework grounding

[Svelte await blocks](https://svelte.dev/docs/svelte/await) render a non-Promise in the `{:then}` branch. [Svelte context](https://svelte.dev/docs/svelte/context) shares a value with descendants when prop forwarding is warranted. Neither feature chooses when a document may acquire a primary resource.
