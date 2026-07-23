# 0156. Applications bring workspace lenses; runtimes own workspaces by ID

- **Status:** Superseded by [ADR-0160](0160-lenses-interpret-durable-namespaces-without-creating-lifecycle-scopes.md)
- **Date:** 2026-07-19
- **Amends:** [ADR-0125](0125-record-definitions-are-release-local-lenses-and-never-migrate-user-data.md) by making simultaneous release-local interpretations a runtime property; [ADR-0130](0130-workspace-definitions-expose-tables-with-row-owned-documents-and-a-release-local-kv-lens.md) by separating the application lens from the opened workspace owner; and [ADR-0143](0143-account-open-never-consumes-device-data.md) by making capture, add, export, and delete take Workspace IDs.
- **Relates:** [ADR-0096](0096-local-workspace-persistence-is-environment-injected.md), [ADR-0140](0140-open-workspaces-synchronize-automatically-and-callers-settle-one-watermark.md), [ADR-0152](0152-epicenter-home-is-a-shell-above-workspaces.md)

## Context

ADR-0125 already makes table and KV definitions release-local lenses over
schema-opaque data. The SQLite implementation nevertheless binds the first
definition opened for a Workspace ID into the persistence owner. Core, browser,
Worker, and desktop runtimes then reject a different definition object for the
same ID. Browser and desktop transports also carry or reconstruct lens data so
the storage side can project and validate rows.

That implementation quietly restores the canonical schema that ADR-0125
removed. It prevents two installed applications from interpreting the same
workspace differently, makes the host compare application meaning, and couples
storage and synchronization lifecycle to one release's TypeScript values.

## Decision

Epicenter owns and synchronizes schema-opaque workspaces by stable Workspace
ID. Every application, action, or script brings the release-local lens it needs
to interpret one of those workspaces.

`defineWorkspace` constructs an inert `WorkspaceLens`. Opening remains one
operation:

```ts
const workspace = await runtime.open(honeycrispWorkspace);
```

The clean-break public names are `WorkspaceLens` for the inert value and
`Workspace<TLens>` for the opened typed view. `WorkspaceDefinition` and
`WorkspaceHandle` are deleted without aliases.

The runtime resolves `lens.id` to one raw owner cached by Workspace ID. That
owner owns the SQLite connection, canonical rows and KV, row documents,
synchronization, settlement, capture, and disposal. A typed view wraps the raw
owner with the supplied table and KV lenses. Reopening the same lens may return
the same typed view; opening a different lens with the same ID is valid and
creates another typed view over the same owner.

Lens code stays in the application JavaScript realm. Browser main-thread code
validates and projects values around a schema-opaque Worker protocol. Desktop
webview code does the same around a schema-opaque HTTP protocol. Bun, browser
Workers, synchronization authorities, and remote servers receive Workspace
IDs, canonical row addresses, bounded JSON, document updates, SQL text, and
transport metadata, never table lenses, KV lenses, result schemas, serialized
definitions, hashes, or fingerprints.

Opening may fail because identity, storage, transport, or Workspace ID
admission fails. It never scans data and never fails because a stored value does
not conform to the supplied lens. Row and KV reads validate only the value being
read and return the existing nonconforming result with its raw value. Typed
writes validate the application-owned portion before sending a schema-opaque
operation; the raw owner enforces only platform invariants and bounded JSON.

Schema-opaque lifecycle operations take a Workspace ID rather than a lens.
Logical capture, install, export, deletion, synchronization, and document
ownership therefore do not need an application definition.

Workspace IDs remain statically declared by application or host code. A user
project, collection, or account is data inside a declared workspace, not a
dynamically minted workspace. Admission of an ID is a host policy separate from
the meaning supplied by a lens.

## Consequences

- Honeycrisp, reporting, and automation code can use different table or KV
  lenses over the same bytes at the same time.
- The runtime has one expensive raw owner per ID and any number of cheap typed
  views. Synchronization and row-document connections are not duplicated per
  lens.
- There is no definition registry, exact-equality check, hash, compatibility
  classifier, preferred lens, provider role, or lens migration protocol.
- Applications that want exact agreement share an npm package containing a
  lens. Epicenter neither requires nor verifies that agreement.
- Different web origins still have different OPFS replicas. They share a
  logical workspace through account plus Workspace ID and synchronization, not
  through a pathname or browser origin.
- Uninstalling the last application that declares an ID does not delete its
  raw workspace. The data becomes dormant until reinstall, export, diagnostics,
  or explicit deletion.
- Moving validation to the caller enlarges the browser and desktop client code,
  but it removes application meaning from every persistence and transport
  implementation.
- The package root's legacy root-Yjs runtime already exports `Workspace` and
  `WorkspaceDefinition`. The new nouns belong to the SQLite subpath during the
  clean break; the legacy exports remain a separate deletion target under
  ADR-0130 rather than weakening the destination names.

## Considered alternatives

- **Require exact definition equality.** Rejected because equality makes one
  release-local interpretation canonical and rejects useful partial lenses.
- **Hash serialized definitions.** Rejected because a fingerprint only makes
  the same unnecessary equality rule cheaper to compare.
- **Choose one provider application for each workspace.** Rejected because data
  outlives applications and an integration does not depend on the provider
  being installed.
- **Allow only one lens at a time.** Rejected because a desktop host runs
  several application surfaces and actions over one raw store concurrently.
- **Open a raw handle and bind a lens in a second public call.** Rejected because
  it exposes a platform capability applications do not need and creates two
  lifecycle objects where one `runtime.open(lens)` call is sufficient.
- **Validate every row during open.** Rejected because conformance is
  application-local, may differ by lens, and is already represented honestly at
  read time.
- **Keep compatibility aliases for the old nouns.** Rejected because the old
  names preserve the false idea that an application definition is the runtime
  owner.
