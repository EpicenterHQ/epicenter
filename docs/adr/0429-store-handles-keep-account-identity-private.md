# 0429. Store handles keep account identity private

- **Status:** Accepted
- **Date:** 2026-09-23
- **Relates:** [ADR-0428](0428-whispering-recordings-reference-audio-in-their-containing-store.md).
- **Unbuilt:** Removal of public Personal store identity after migrating its callers to store-relative recording access.

## Context

`openPersonal` captures an Account's identity and transport, then returns its
store with an additional `identity: { authorityId, principalId }` property.
Whispering uses that projection to build and validate `remoteAudio` references.
ADR-0428 removes those references from ordinary recording rows.

Auth constructs frozen Account objects. The public Account carries durable
identifiers and credential-bound functions, not raw tokens. Applications can
retain the captured Account without requiring every opened resource to return
another copy of its identifiers.

## Decision

**Local and Personal stores expose their capabilities and lifecycle; Personal's
Account remains an acquisition input.** Keep these constructors:

```ts
const local = await openLocal(definition);
const personal = await openPersonal(definition, { account });
```

Both stores expose `tables`, `kv`, `blobs`, `persistence`, `signal`, and `close`,
alongside existing structured-data operations. Personal does not add a public
`identity`, `authorityId`, `principalId`, or `account` property. Application
composition retains its Account when a product operation needs account data.
No account-owned store factory or aggregate App handle replaces the openers.

Common structure does not require identical blob capabilities. Local keeps
`stat`, `list`, and the provenance accepted by `createRecorder`. Personal keeps
its authenticated remote access. Supported copy directions and the fresh-ID
result of `copyFrom` remain unchanged. Infer store types from their actual
constructors and pass the capabilities a caller uses.

**A handle's storage scope and transport remain fixed at acquisition.**
Authority and principal still select Personal persistence and authorize remote
access. They remain private implementation inputs. Auth retirement still fences
network access. Signing in again does not retarget an old store or transport.
Private capture at the opener remains allowed; removing the public projection
does not require deleting the snapshot guarantee for mutable structural Account
inputs.

A live Account cannot substitute for durable identity in a recovery artifact
that survives its lifetime. Any such artifact must name its destination without
credentials and be validated against the Account that resumes it. That boundary
does not require a public identity property on every store.

## Consequences

Ordinary data and audio consumers can receive their containing store without
account fields. Deleting the redundant public projection leaves identity
ownership with auth and storage scoping inside acquisition.

The change preserves physical addresses, synchronization, authentication,
captured transport, independent store closure, and blob admission. It grants no
authority to rewrite persisted data or merge Local and Personal datasets.

## Considered alternatives

- Flatten `personal.identity` onto the store: removes one property access while
  retaining the duplicated public ownership surface.
- Return `personal.account`: exposes unrelated network capabilities to data
  consumers that did not need them.
- Give every store the same methods: introduces remote listing or remote
  recording promises merely to make types identical.
- Remove owner identifiers from storage: loses account isolation; private scope
  is required even when public consumers do not inspect it.
