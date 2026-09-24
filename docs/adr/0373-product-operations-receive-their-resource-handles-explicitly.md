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

A component obtains ready handles through its product's `get*` context accessors
during initialization. It passes the dependencies to operations, shortcuts,
queries, and workflows. Ordinary TypeScript operations never call Svelte context
getters. A retained operation keeps its handles and never resolves another
account or write destination from a registry. Importing an operation acquires
no resources.

A copy workflow receives its source and destination blob capabilities, borrowed
from the opened stores, and a product signal. If it also publishes a row, it
receives that destination explicitly and checks cancellation after the copy.
For example, `personal.blobs.copyFrom(local.blobs, id)` preserves the ID; the
workflow decides whether a Personal row needs that reference or only text.
Store lifetime does not establish that the initiating UI or selected workflow
still exists. Blob creation and row creation remain separate operations;
failure can leave unreferenced bytes.

Personal-only consumers receive required Personal handles from their route or
product gate. They do not repeat sign-in branches or fall back to Local. A
component that supports either store receives the concrete destination.

Svelte adapters observe the existing store API. Product CRUD wrappers and
mirrored caches do not replace `tables` or `kv`. Controls receive values and
callbacks when they do not need to own storage policy. Product contexts may
collect capabilities for a workflow, but they do not reconstruct the SDK's
`device`/`account` namespace tree.

An operation names its selected destination `store`. Local and Personal remain
distinct handles; the operation does not choose between them from current auth.
Personal-dependent operations receive a required handle or concrete settings
captured by their caller. A defaults policy belongs at composition, not in
repeated `app.personal?.` reads. Preserve each operation's input-capture timing.

Product composition owns resource opening. Each failed opener cleans up its own
partial acquisition; successful roots can remain until browser/WebView replacement.
The UI session owns recording workflows and query lifetimes. Retirement fences
new work and prevents late publication even while root handles remain open.
Temporary captures, previews, and requests retain their own cleanup. Context
distribution adds no aggregate close owner. Document replacement can interrupt
work and does not claim a completed save.

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
