# 0373. Product operations receive their resource handles explicitly

- **Status:** Proposed
- **Date:** 2026-09-08
- **Unbuilt:** Migration from explicit App parameters to independent resource handles and product cancellation scopes.

## Context

Whispering's operations previously looked up a published UI session from a
module registry. Passing the session explicitly removed publication order and
prevented retained operations from resolving a later App. The next resource
boundary must preserve that property without requiring the App aggregate.

## Decision

**An operation receives the handles and product cancellation scope it uses.**

A component obtains ready handles from its product context and passes them to
buttons, shortcuts, queries, and workflows. A retained operation keeps those
handles. It never resolves another account or write destination from a registry.
Importing an operation acquires no resources.

An upload workflow receives LocalBlobs, RemoteBlobs, its target store, and a
product signal. It checks that signal after upload before writing the returned
URL. Individual handle lifetime does not establish that the initiating UI or
selected workflow still exists. Blob creation and row creation remain separate
operations; failure can leave unreferenced bytes.

Personal-only consumers receive required Personal handles from their route or
product gate. They do not repeat sign-in branches or fall back to Local. A
component that supports either store receives the concrete destination.

Svelte adapters observe the existing store API. Product CRUD wrappers and
mirrored caches do not replace `tables` or `kv`. Controls receive values and
callbacks when they do not need to own storage policy. Product contexts may
collect capabilities for a workflow, but they do not reconstruct the SDK's
`device`/`account` namespace tree.

Product composition owns resource opening and partial-startup cleanup. The UI
session owns its recording workflows and query lifetimes. Explicit teardown
stops those producers before closing their resources. Document replacement can
interrupt work and does not claim a completed save.

## Consequences

Operations remain usable without a global registry or framework App. Their
arguments state the resources required for the work. The product retains
cancellation checks across awaits; independent handles do not make multi-step
workflows atomic or transfer that responsibility into the SDK.

## Considered alternatives

- Export a current-session singleton: reintroduces publication order and late
  routing to a successor account.
- Pass the complete App everywhere: obscures the actual dependency and requires
  unrelated capabilities in tests.
- Remove workflow cancellation because handles have signals: misses a cancelled
  workflow whose resources remain open for another operation.
