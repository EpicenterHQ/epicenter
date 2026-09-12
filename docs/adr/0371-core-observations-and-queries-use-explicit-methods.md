# 0371. Core observations and queries use explicit methods

- Status: Proposed
- Date: 2026-09-08
- Unbuilt: Core method migration and reactive adapter integration.

## Context

Auth getters read mutable state, while table getters validate rows and allocate
arrays. Property syntax hides that distinction and forces adapters to preserve
descriptors to avoid executing queries while copying an object.

## Decision

Use `getState()` for core auth and departure observations, `getStatus()` for
connection status, `list()` for table rows, `getNonconforming()` for table and KV
validation results, and `getPendingCount()` for backup counts. Subscriptions
remain explicit. Svelte adapters expose reactive properties; fixed facts remain
readonly values. This decision covers these reviewed APIs, not every getter.

## Consequences

Core and reactive types need deliberate adaptation instead of assuming an
identical property shape. Existing callers migrate without compatibility aliases.
Reading auth still captures an Account; it does not subscribe or change ownership.

## Considered alternatives

- `state()`: shorter, but less explicit about the read.
- `getSnapshot()`: suggests detached data although Accounts retain capabilities.
- Rename every getter: conflates queries, fixed facts, and lifecycle capabilities.

## Implementation

See the [execution plan](../../specs/20260908T204224-explicit-core-reads-and-blob-capabilities.md).
