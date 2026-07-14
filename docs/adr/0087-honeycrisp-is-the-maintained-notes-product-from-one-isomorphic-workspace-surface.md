# 0087. Honeycrisp is the maintained notes product from one isomorphic workspace surface

- **Status:** Accepted
- **Date:** 2026-07-01
- **Amended by:** [ADR-0137](0137-applications-declare-one-live-workspace-per-contract-version.md), [ADR-0138](0138-tables-declare-cells-documents-and-blobs-in-one-field-map.md), [ADR-0141](0141-workspace-authority-is-selected-once-and-owns-one-local-database.md)

## Context

Fuji has been removed, and Honeycrisp is the notes app that still has a live workspace schema, web UI, and auth-gated session lifecycle. The next product direction is desktop notes: the same notes app should run on the web and in a Tauri shell without forking its Yjs wire contract. The old daemon mount path has no live consumer after ADR-0080; the Super App composes app workspaces in process from their isomorphic surfaces.

## Decision

Honeycrisp is the maintained Epicenter notes product. It ships from one SvelteKit
codebase on web and desktop. Its package root exposes the pure table and row
vocabulary; `src/lib/workspace/workspace.ts` declares the versioned candidate,
and a committed lock freezes version 1. Runtime actions and platform resources
compose after `openBrowserWorkspace` rather than entering the durable contract.
Runtime-specific concerns stay behind `#platform/*` imports and environment
factories under `src/lib/workspace/`. Honeycrisp does not regain Fuji, a daemon
mount, or a `./mount` export.

## Consequences

The `@epicenter/honeycrisp` package root remains the integration contract for
code that needs Honeycrisp's table and row types. Actions belong to an opened
runtime, not the package schema. Web and desktop peers stay compatible because
they validate the same append-only workspace lock. Desktop work can add Tauri
auth, updater, window, and OS seams without touching that contract.

## Considered alternatives

- **Restore Fuji or the daemon mount surface.** Rejected. Fuji was removed deliberately, and ADR-0080 makes the Super App an in-process workspace composer rather than a per-app daemon consumer.
- **Fork Honeycrisp into separate web and desktop apps.** Rejected. That would split the workspace contract and duplicate the product surface for no benefit.
- **Adopt Whispering's module singleton shape.** Initially rejected here, then adopted repo-wide the same day by [ADR-0088](0088-sign-in-is-an-enhancement-never-a-door.md), which answers this bullet's concerns with `reloadOnPrincipalChange` and the hydration gate. The product-surface decision above is independent of that lifecycle choice.
