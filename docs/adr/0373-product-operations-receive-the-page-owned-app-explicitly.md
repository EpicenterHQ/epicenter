# 0373. Product operations receive the page-owned App explicitly

- **Status:** Proposed
- **Date:** 2026-09-08
- **Revised:** 2026-09-21

## Context

Whispering published its ready UI session through a module registry. Completion,
Polish, and Recipe operations looked up that registry, while recording and
import operations received the session explicitly. Tests needed publication
setup, and a retained operation could resolve whichever App was published later.

The session also wrapped settings, recordings, and recipes in domain objects
with their own subscriptions. Those objects repeated the store API and its
reactive projections.

## Decision

**Product operations receive their App or required data capability as an argument.**

Components obtain the ready session from Svelte context. Buttons, shortcuts,
queries, and recording workflows pass that captured owner to operations. A
retained operation keeps its original owner and remains subject to that owner's
retirement. Importing an operation acquires no App and reads no registry.

**Svelte adapts the existing store API without replacing it with product CRUD wrappers.**

`createWhisperingUiSession` uses `fromApp(openedApp)` to adapt both stores.
Device behavior reads `app.device.kv`. Dictionary, custom instructions, and
custom recipes belong to `app.account.personal`. Call sites use `kv.get` with
the appropriate device or personal default; writes go directly to their store.
Signed-out account reads use built-in defaults, never device-stored content.
Controls receive values and callbacks without choosing storage through context.

The context App preserves the framework namespaces. Its `authAccount` member
holds the captured authentication capability for account-management links;
`app.account` retains the framework account scope.

Recording history still uses `app.library.tables` while its permanent owner is
being decided. That selected-store binding is transitional, not a pattern for
new fields. Previous device-authored settings and recipes remain downloadable;
they are not copied into an account automatically.

**The UI session owns recording and query lifetimes.**

Bootstrap owns opening and closing the framework App. The session creates the
recording workflow and query client, provides them through context, and disposes
them when the working UI leaves. It does not add another readiness promise or
application opening API.

## Consequences

The global registry, settings façade, recording and recipe caches, and their
subscription cleanup disappear. Operations retain explicit owner parameters.
The context remains because it distributes a ready instance with real recording
and query lifetimes. Both stores now need reactive projections. The general
settings reset remains device-only.

## Considered alternatives

- Export one global App: saves argument passing but adds publication order,
  ambient access, and retained-operation routing to the boot contract.
- Adapt only the selected library: fixed field ownership now requires both
  stores concurrently. `fromApp` composes the existing store adapters without
  adding another cache or choosing a destination.
- Add `app.inference` or domain CRUD methods: duplicates declared data access
  and moves workflow selection policy away from its application callers.
