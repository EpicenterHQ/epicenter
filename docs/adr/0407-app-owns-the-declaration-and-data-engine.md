# 0407. App owns the declaration and data engine

- **Status:** Proposed
- **Date:** 2026-09-18
- **Amends:** [ADR-0405](0405-one-flat-application-declaration-opens-the-live-app.md) at its retained lower-level declaration constructor and separate data package.

## Decision

`@epicenter/app` owns application declaration, application lifetime, and the
data engine. Authors import `defineApp`, `defineTable`, and `field` from its
root. `defineApp` is the only full declaration constructor. The former
`@epicenter/data` package and `defineData` constructor are removed.

The returned value exposes its schema and synchronous `.open(account?)` method.
Schema tools, memory stores, and artifact operations consume that same value
without opening an App. Eager validation, literal inference, table branding,
and declaration-identity compilation caching remain at the authoring boundary.

Server authorities import `@epicenter/app/sync`. Reusable table libraries use
`@epicenter/app/definition`; store handle types live at `@epicenter/app/store`.
These entrypoints do not import the App lifetime or platform implementations.
The Bun memory opener and browser persistence remain separate entrypoints.
`/browser` selects application capabilities; `/store/browser` owns persistence.

Full declarations statically load application modules but acquire no resources.
Keeping `.open()` does not promise a platform-free root dependency graph.

## Consequences

An author describes one application through one package. The application
constructor owns its validation rather than borrowing another constructor's
parameter type. Engine modules retain the boundaries that their runtimes need.
The package root exports authoring vocabulary explicitly; compiler internals
remain on the schema-tool entrypoint.

This changes package ownership and imports. It changes no persisted identifier,
cache namespace, wire frame, artifact format, or App readiness/close contract.
Skills' historical opener remains a separate lifecycle migration.

The [application architecture map](../../packages/app/ARCHITECTURE.md) records
source ownership, entrypoints, and consumer flows.

## Considered alternatives

- Re-export the data package through App while retaining both constructors.
  This shortens author imports but leaves two public declarations and owners.
- Flatten every engine directory into App's source root. The `data/` grouping
  names a coherent implementation; removing its directory does not remove a
  public boundary or simplify a caller.
- Replace `.open()` with a separate public opener. This can make the declaration
  graph platform-free. The final independent review recommends this follow-up:
  schema-only Skills consumers and Worker test harnesses currently load platform
  modules even though they acquire no resources. Existing import and Worker
  checks pass, but future platform top-level code could break those consumers.
  This migration preserves `.open()`; the opener decision remains proposed.
  See the [full comparison](../reports/20260918-app-data-claude-review.md).
