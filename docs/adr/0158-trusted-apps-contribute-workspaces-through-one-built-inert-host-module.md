# 0158. Trusted apps contribute workspaces through one built inert host module

- **Status:** Proposed
- **Date:** 2026-07-19
- **Amends:** [ADR-0153](0153-trusted-apps-are-source-built-static-catalog-members.md) at two boundaries: the runtime may now execute one validated app-authored host module, and authored host metadata gets a source convention. [ADR-0152](0152-epicenter-home-is-a-shell-above-workspaces.md) at the deferred third-party workspace registration boundary: catalog members may register workspace IDs without a publisher namespace system.
- **Relates:** [ADR-0111](0111-super-chat-v1-exposes-built-in-epicenter-apps-and-defers-extension-surfaces.md), [ADR-0118](0118-epicenter-is-one-trusted-bun-hosted-spa-origin.md), [ADR-0156](0156-a-workspace-opens-as-release-local-lens-views-over-one-schema-opaque-owner.md)

## Context

ADR-0153 admits source-built static SPA catalog members but declares the host
executes no app server modules, so today the Bun sidecar can only serve
workspaces whose definition values are statically linked into
`workspace-owner.ts`. A source-built app therefore cannot cause the host to
allocate its workspace storage at all. Under ADR-0156 the host-side owner is
schema-opaque and needs only workspace IDs, which removes the old reason the
host imported app schema code. ADR-0152 reserved the `epicenter-*` ID
namespace and deferred third-party registration until an installation product
existed; source-built admission (ADR-0153) is now that product's trust
boundary.

## Decision

Each source-built app may contain an optional `src/epicenter.ts`. The
Epicenter build command, inside the existing ADR-0153 trust-confirmed build,
compiles it to one inert, self-contained `host.mjs` per app (bundled, no
external imports, no side effects at import beyond exporting its declaration)
and derives static metadata from it at build time. The runtime consumes the
derived metadata for cataloging; it loads `host.mjs` only when the app
declares actions.

The declaration is deliberately flat:

```ts
export default {
	workspaces: ['plainjournal'],
	actions: {
		compactEntries: async (request) => {
			/* request-scoped work; returns before the request ends */
		},
	},
} satisfies EpicenterHostDeclaration;
```

`workspaces` is a list of static literal workspace IDs the host registers as
schema-opaque storage allocations, exactly the registration shape the bundled
first-party catalog uses. `actions` is optional and request-scoped: an action
runs inside one host request and owns no lifecycle beyond it. There are no
`provides`/`uses` capability declarations, no schema fingerprints, no lens
equality negotiation, no provider ownership, no dynamic or computed IDs, no
background jobs, and no arbitrary-Bun-API contract. Validation is static
(self-containment of the bundle, shape of the exported declaration, ID
grammar, `epicenter-*` reservation); the real authority boundary remains
source and build admission per ADR-0153, and the trust confirmation must state
that a declared host module executes in the Bun process.

The SPA side is untouched: app pages import their own `src/workspace.ts` lens
normally and open by ID through the workspace API. App identity, title, and
static route stay catalog-derived per ADR-0153; `src/epicenter.ts` never
supplies presentation metadata. A build candidate validates wholly or not at
all, replaces the active catalog atomically, and takes effect after a full
Epicenter restart. Uninstalling an app leaves its workspace data dormant in
place; no uninstall path deletes or exports user data.

## Consequences

- ADR-0153's "no app server modules" line is narrowed honestly: one validated
  built module per app, loaded for declared request-scoped actions. This is
  authority the build admission already implied (build scripts run arbitrary
  code as the user); the runtime floor now names its shape instead of
  pretending the host runs no app code.
- First-party and source-built apps converge on one registration shape:
  workspace IDs. The statically linked definitions catalog in the desktop
  owner becomes a plain ID registration and stops importing app schema
  packages.
- Two apps declaring the same workspace ID share it, deliberately. Under
  ADR-0156 the ID is the whole contract and each app reads through its own
  lens; there is no equality ceremony to fail.
- The inertness and no-arbitrary-Bun-API rules are contract plus static
  validation, not a sandbox. A malicious admitted app was already outside the
  threat model per ADR-0153's admission consequence; this ADR does not
  pretend otherwise.
- Background work stays refused: anything that outlives a request remains an
  external tool or a host-owned service. If a real app earns durable jobs,
  that is a new decision, not a widening of `actions`.
- Uninstall-leaves-data-dormant means reinstalling (or another app declaring
  the same ID) sees the data again; there is no orphan-cleanup subsystem to
  build or get wrong.

## Considered alternatives

- **Keep statically linked first-party definitions only.** Rejected because
  it makes the workspace plane unreachable for exactly the source-built apps
  ADR-0153 exists to admit.
- **A manifest with per-app permission grants.** Rejected by ADR-0153
  already: the shared origin and trusted host cannot enforce what the
  manifest would advertise.
- **Execute the app's full server module with open Bun APIs.** Rejected
  because the two live needs are storage registration and request-scoped
  actions; open-ended host code invites background lifecycles nobody owns.
- **`provides`/`uses` negotiation between apps.** Rejected because it
  recreates cross-release schema identity; ADR-0125 and ADR-0156 make the
  shared ID plus release-local lenses the entire interop story.
- **Derive `workspaces` from static analysis instead of executing the built
  module once at build time.** Rejected because the build step is already
  trusted and executes app code; a second extraction technology buys no
  authority reduction.
