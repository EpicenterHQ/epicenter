# 0430. Store definitions declare data and products compose resources

- **Status:** Proposed
- **Date:** 2026-09-23
- **Amends:** [ADR-0405](0405-one-flat-application-declaration-opens-the-live-app.md) at declaration naming and identity: `defineStore` names a store definition, not an application composition. The flat schema and stable identity remain.
- **Amends:** [ADR-0407](0407-app-owns-the-declaration-and-data-engine.md) at the declaration constructor's name: `defineStore` replaces `defineApp`. The inert root, single constructor, and package ownership remain.
- **Relates:** [ADR-0423](0423-app-resources-open-as-independent-handles.md) describes independent resource acquisition; [ADR-0429](0429-store-handles-keep-account-identity-private.md) keeps Account an acquisition input.

## Context

`defineApp` originally combined a data declaration with application composition.
The SDK now opens Local and Personal independently and has no aggregate App
handle. Keeping that constructor name makes a data schema appear to define the
product's execution and resources. Deferring the rename avoided caller churn,
but left the public name describing an owner that no longer exists.

## Decision

**`defineStore({ id, title?, tables, kv })` is the single store declaration constructor.**

It validates and returns an inert schema with literal inference. It acquires no
resources, captures no Account, and exposes no opening method. The package stays
`@epicenter/app`: it supplies tools for applications, including store declarations
and independent resource constructors. `defineApp` is removed without an alias.

The definition ID names the store's document and SQL namespaces, and also names
its Local blob namespace. [ADR-0438](0438-hosted-blobs-have-stable-authority-urls.md)
gives hosted objects owner-level URLs independent of that definition ID and
an Account-bound client. The ID uses the same
reverse-domain grammar as host application IDs.
A product may open several
store definitions; its installed application identity is a separate concern.
Existing strings, address encodings, locks, and persisted bytes are unchanged.
Renaming the constructor does not authorize renaming a store's ID.

Products acquire usable handles through `openLocal(definition)` and
`openPersonal(definition, { account })`. Both stores own tables, KV, and terminal
cleanup; Local also lends a blob capability. Hosted publication captures an
Account independently of either structured store.
[ADR-0436](0436-stores-own-local-sqlite-namespaces.md) adds
store-owned local SQLite; this acquisition is implemented. Recording
borrows Local blobs. Secrets and inference have independent constructors. Product code expresses workflow dependencies and
page lifetime; it does not recreate a generic App handle or resource tree.

## Consequences

Callers, examples, and current guidance use `defineStore`. Historical records
retain the old name and link to this amendment. Import purity, schema inference,
validation, synchronization, and resource lifetimes remain unchanged.

The declaration rename and resource composition model require no new storage
layout, Shared opener, SQL projection, or headless owner protocol. Those remain
separate decisions. The shared ID validator can continue serving host and store
namespaces without adding a duplicate predicate.

## Considered alternatives

- Retain `defineApp`: leaves a store schema named after removed aggregate ownership.
- Export both names: gives one declaration two public entry points and preserves the ambiguity.
- Rename the package or every app-related identifier: conflates product identity,
  storage protocol vocabulary, and declaration naming without changing their responsibilities.
- Add a replacement app constructor: introduces an SDK owner where products
  already compose the resources they need.
