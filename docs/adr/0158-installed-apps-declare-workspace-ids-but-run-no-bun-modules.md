# 0158. Installed apps declare workspace IDs but run no Bun modules

- **Status:** Superseded by [ADR-0160](0160-lenses-interpret-durable-namespaces-without-creating-lifecycle-scopes.md)
- **Date:** 2026-07-19
- **Amends:** [ADR-0153](0153-trusted-apps-are-source-built-static-catalog-members.md) by adding declarative Workspace ID inventory while preserving its refusal of app server modules.
- **Relates:** [ADR-0118](0118-epicenter-is-one-trusted-bun-hosted-spa-origin.md), [ADR-0152](0152-epicenter-home-is-a-shell-above-workspaces.md), [ADR-0156](0156-applications-bring-workspace-lenses-runtimes-own-workspaces-by-id.md)

## Context

A source-built static application needs to declare which durable Workspace IDs
it expects so catalog validation can catch typos and Home can show a useful
inventory. It is tempting to make the same TypeScript entry export executable
actions and compile it to `host.mjs` for Bun to import.

That module would not be inert or capability-scoped. Once imported into Bun,
ordinary JavaScript can reach ambient filesystem, process, network, and Bun
APIs regardless of TypeScript types or the request context the host passes.
Bundling and import allowlists are not a sandbox. Runtime server code would also
gain background lifetime that ADR-0153 deliberately withholds from installed
static apps.

ADR-0153 already treats dependency installation and build scripts as arbitrary
machine-authority code after explicit confirmation. That makes a Bun module an
honest possible full-trust product, but it does not make the module inert,
request-bounded, or capability-limited. Runtime access to host secrets and
lifetime is a distinct contract that no installed action currently earns.

## Decision

An installed application may include an optional build-time entry at
`src/epicenter.ts`. Its first contract is declarative:

```ts
export default defineEpicenter({
  workspaces: [HONEYCRISP_WORKSPACE_ID],
});
```

The build command evaluates this entry during the already explicit,
machine-authority trust step, validates exact static Workspace IDs, and writes
plain derived catalog metadata. The desktop runtime reads that data. It never
imports the application's TypeScript or a generated Bun module.

`workspaces` is one flat list. It does not distinguish `provides`, `uses`,
owner, provider, dependency, or canonical lens. Duplicate IDs across apps are
normal. The declaration does not contain a lens, fingerprint, package version,
storage path, dynamic pattern, or migration information. It is an admission
and inventory contract, not a same-origin security boundary.

At runtime, the desktop workspace API admits the union of IDs declared by the
active catalog. It does not identify a same-origin caller or restrict that
caller to the IDs listed by its own app. Per-app grants would claim isolation
the shared origin does not provide.

The SPA imports its ordinary `src/workspace.ts` code and calls
`runtime.open(lens)`. The filename is a source convention, not a host entry
point. App ID, title, icon, static route, and replacement behavior remain
derived by the catalog and are not repeated in `epicenter.ts`.

The first installed-app contract contributes no executable actions. Built-in
host actions remain statically linked first-party Bun code. External tools may
run through an explicitly launched MCP process. Installable actions require a
later decision that honestly chooses either fully trusted Bun modules or a real
runtime sandbox; a request-scoped TypeScript parameter alone is neither.

The build command validates a complete candidate, including static `dist/`
outputs and derived Workspace ID metadata, then publishes it as a new immutable
catalog generation. It atomically replaces one small `current` pointer only
after that generation is complete. A process resolves `current` once at startup
and keeps serving the selected generation directory for its whole lifetime.
Publication therefore cannot hot-swap its files. A new generation takes effect
only after a full Epicenter restart. Uninstall publishes a generation without
the app or its declarations but leaves every workspace intact and dormant.

## Consequences

- `dist/index.html` remains the one static SPA convention across Vite, Svelte,
  Solid, and other build systems; authored `build/` alternatives are not
  supported.
- The host can show which apps declare an ID and can refuse undeclared or
  malformed IDs without deciding which app owns the data.
- Catalog activation needs no module teardown, action generation fencing, or
  hot-reload lifecycle.
- An installed app cannot add a Bun background job or gain ambient server
  authority merely by satisfying a TypeScript helper.
- The first version does not make installed application actions visible to
  Home or MCP introspection. This is a deliberate capability gap.
- Workspace data survives uninstall and can be exported, diagnosed, explicitly
  deleted, or reopened after reinstall.

## Considered alternatives

- **Compile `epicenter.ts` to `host.mjs` and import it in Bun.** Rejected because
  the module has ambient Bun authority and lifetime; the proposed capability
  parameter cannot enforce the claimed restriction. If installed actions later
  earn this model, the product must name it as fully trusted Bun code.
- **Statically scan imports and top-level statements.** Rejected because global
  APIs, transitive dependencies, dynamic evaluation, and runtime effects make
  a denylist incomplete.
- **Call declarations `provides` and `uses`.** Rejected because those roles
  imply canonical ownership and an installation dependency that the
  schema-opaque workspace model does not have.
- **Put lenses in the host catalog.** Rejected because lenses are application
  code and must not cross runtime or transport boundaries.
- **Allow dynamic Workspace ID patterns.** Rejected because user-created
  projects belong as rows, while static IDs make durable stores inspectable and
  typo-safe.
- **Hot reload a successful catalog.** Rejected because restart removes module,
  handle, request, and generation overlap from the activation protocol.
- **Delete data on uninstall.** Rejected because applications interpret data;
  they do not own its lifecycle.
