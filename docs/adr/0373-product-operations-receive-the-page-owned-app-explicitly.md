# 0373. Product operations receive the page-owned App explicitly

- **Status:** Proposed
- **Date:** 2026-09-08
- **Revised:** 2026-09-20

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

`createWhisperingUiSession` uses `fromData(data)` for the selected library and
`fromKv(openedApp.device.kv)` for device settings. The UI reads
`app.library.tables` and `app.device.kv`. `getSetting` applies application
defaults; writes go directly to KV. Recording defaults, audio loading, ordering,
and copying built-in recipes remain ordinary functions beside the data.

**The UI session owns recording and query lifetimes.**

Bootstrap owns opening and closing the framework App. The session creates the
recording workflow and query client, provides them through context, and disposes
them when the working UI leaves. It does not add another readiness promise or
application opening API.

## Consequences

The global registry, settings façade, recording and recipe caches, and their
subscription cleanup disappear. Operations retain explicit owner parameters.
The context remains because it distributes a ready instance with real recording
and query lifetimes. `fromKv` avoids projecting a device recording table when
the person is viewing the account library.

## Considered alternatives

- Export one global App: saves argument passing but adds publication order,
  ambient access, and retained-operation routing to the boot contract.
- Add `fromApp`: the current consumers need one selected data projection and
  device KV. A broader adapter would need to decide which stores to project.
- Add `app.inference` or domain CRUD methods: duplicates declared data access
  and moves workflow selection policy away from its application callers.
