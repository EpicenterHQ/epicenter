# 0392. Product boundaries provide required resource handles

- **Status:** Proposed
- **Date:** 2026-09-12
- **Amends:** [ADR-0369](0369-an-application-page-owns-one-library-and-changing-it-ends-the-page.md) at one-library opening and [ADR-0355](0355-local-and-account-sessions-share-the-application-data-api.md) at destination selection: products acquire concrete handles while store operations retain their common contract.
- **Unbuilt:** Product contexts and route gates using independent resource handles; consumers still contain nested App access and optional Personal checks.

## Context

A nested App exposed device capabilities and an optional account scope. A
personal-only component could receive that broad object and repeatedly check
`app.account?.personal`. Opening an account also acquired resources the product
might not use. The namespace described a possible capability rather than the
one the component required.

## Decision

**A product boundary acquires and supplies the handles its children require.**

Store opening uses `openLocal(definition)` and
`openPersonal(definition, { account })`. Capability constructors use their own
required inputs. Each store supplies its required `.blobs` capability; the
boundary does not open or close blobs separately. The target resource API is described in
[ADR-0423](0423-app-resources-open-as-independent-handles.md); inference and saved
catalogs have separate constructors in
[ADR-0365](0365-ai-owns-inference-access-and-applications-own-workflow-selection.md).

A personal-only route checks identity and opens Personal before rendering its
children. Its context contains a required Personal handle. Sign-in presentation,
loading, and opening failure belong to that boundary. Downstream operations do
not repeat optional chaining or substitute Local when Personal is absent.

A route that supports Local without sign-in receives Local. A route that works
with either store receives the concrete selected store. It does not rediscover
its destination from ambient auth. URL changes, local recording policy, and
copying into Personal remain product decisions; this record does not prescribe
new `/local` or `/personal` routes.

Account-backed inference remains separate from Personal data and can open
without a synchronized document. Remote blobs belong to `personal.blobs` and
require that store to open. Required
handles eliminate account-presence branches inside consumers, not network
failures, account retirement, or resource closure.

UI context distributes borrowed capabilities. The product composition owns
acquisition and shutdown; a component does not close a shared handle merely
because it unmounts. In SvelteKit, client/Tauri resources belong to the mounted
client owner, not request-scoped server `locals` or `+layout.server.ts`.

Account retirement itself fences network authority, not the cached Personal
store. The product working-lifetime owner closes or replaces Personal on
departure. An outage or sign-out does not invalidate its document generation
or delete pending edits. Retained handles never adopt a successor account.

## Consequences

The `app.device` and `app.account` capability tree is removed from the target.
Type narrowing happens at the product boundary. A workflow retains its original
handles and cancellation scope rather than resolving a successor from global
state. Existing product callers require an explicit migration.

## Considered alternatives

- Preserve a union or optional account scope everywhere: propagates sign-in
  policy into components that require an account resource.
- Silently use Local when Personal is missing: changes the write destination.
- Put all resources on `device`: recreates an aggregate with unrelated lifetimes.
- Gate every route on sign-in: removes useful local-only workflows.
