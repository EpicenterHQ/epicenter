# 0087. Honeycrisp is the maintained notes product from one isomorphic workspace surface

- **Status:** Superseded by [ADR-0160](0160-lenses-interpret-durable-namespaces-without-creating-lifecycle-scopes.md)
- **Date:** 2026-07-01
- **Amended:** 2026-07-17 by [ADR-0130](0130-workspace-definitions-expose-tables-with-row-owned-documents-and-a-release-local-kv-lens.md): Honeycrisp's one package contract now uses canonical SQLite rows and row-owned documents. It no longer exposes the legacy root-Yjs action registry.

## Context

Fuji has been removed, and Honeycrisp is the notes app that still has a live workspace schema, web UI, and auth-gated session lifecycle. The next product direction is desktop notes: the same notes app should run on the web and in a Tauri shell without forking its Yjs wire contract. The old daemon mount path has no live consumer after ADR-0080; the Super App composes app workspaces in process from their isomorphic surfaces.

## Decision

Honeycrisp is the maintained Epicenter notes product. It ships from one SvelteKit codebase on web and desktop, with one package root export that exposes the isomorphic workspace definition. Runtime-specific concerns live behind `#platform/*` imports and environment factories under `src/lib/workspace/`; the auth lifecycle follows the repo-wide composition in [ADR-0088](0088-sign-in-is-an-enhancement-never-a-door.md): sign-in is an enhancement over a local-first boot, not a gate. Honeycrisp does not regain Fuji, a daemon mount, or a `./mount` export.

## Consequences

The `@epicenter/honeycrisp` package root remains the integration contract for code that needs the inert workspace definition and shared application operations. Web and desktop peers stay compatible because they open the same definition through environment-owned SQLite runtimes. The Query host adapts those async application operations into its tool catalog instead of depending on a workspace action registry. Desktop work can add Tauri auth, updater, window, and OS seams without touching the schema. The cost is that Honeycrisp is no longer a generic daemon example; project-mounted note materialization would need a new live consumer and a new decision before it returns.

## Considered alternatives

- **Restore Fuji or the daemon mount surface.** Rejected. Fuji was removed deliberately, and ADR-0080 makes the Super App an in-process workspace composer rather than a per-app daemon consumer.
- **Fork Honeycrisp into separate web and desktop apps.** Rejected. That would split the workspace contract and duplicate the product surface for no benefit.
- **Adopt Whispering's module singleton shape.** Initially rejected here, then adopted repo-wide the same day by [ADR-0088](0088-sign-in-is-an-enhancement-never-a-door.md), which answers this bullet's concerns with `reloadOnPrincipalChange` and the hydration gate. The product-surface decision above is independent of that lifecycle choice.
