# 0359. The document factory owns readiness and closure

- **Status:** Proposed
- **Date:** 2026-09-08
- **Implementation:** The document engine owns readiness and document-operation draining; App coordinates separate capability owners.
- **Amends:** [ADR-0355](0355-local-and-account-sessions-share-the-application-data-api.md) at the construction mechanism of the live app handle.

## Context

Before this change, `packages/app/src/index.ts` returned getters forwarding to
a store created after storage opened. The app and store each owned a closure
flag. A table retained before app closure could still write until the store was
closed. Copying every store member also required facade edits for new operations.

## Decision

**The factory implementing document operations owns acquisition, readiness,
and closure of that same document.**

`packages/data/src/store/store.ts` constructs its `Y.Doc`, named roots, table
handles, and KV handle synchronously. Acquisition supplies durable storage and
its loaded snapshot. The factory hydrates the existing document before attaching
its update listener. It constructs `createPersistenceController` with the real
port and snapshot after acquisition, without a placeholder port or a public
initialization protocol.

The actual reads, writes, and subscriptions check the factory's private state.
Writes share the existing `transact` guard. Storage failures settle readiness
with a typed failure; operations before readiness or after closure throw a
programmer error. A successful readiness result is not a continuing liveness
signal.

An invalid build-time definition or an Account missing its stable authority
identity is rejected synchronously before acquisition. These are constructor
contract violations, not storage failures. Exact-generation openers accepting
definitions as data retain their typed parse refusal.

`close()` disables operations synchronously. Every call returns the same
completion promise, which waits for acquisition and resource release. Failure
and closure during opening release any resources acquired before completion.
The final flush runs after the current synchronous transaction finishes. Close
revokes callback delivery immediately, including the rest of a copied batch.
Readiness retains its original boot failure if cleanup also fails; that cleanup
failure is logged and remains available from `close()`.

The app composes actual capabilities by reference. It does not copy the API
through forwarding getters, a Proxy, or a generic lifetime/activation manager.
A getter for the real persistence controller after acquisition is permitted;
retained persistence operations still obey closure.

The document factory owns its document operations. The App constructs its other
capabilities directly and coordinates their shutdown. Each resource owns the
guards and draining required by its concrete lifecycle.
App-facing blob and named SQL capabilities do not need to be returned as
constructor parts from the document engine. The App does not mirror the store's
readiness or forward its operation surface.

An admitted document operation is registered before its primitive runs. Document
close drains those operations before releasing storage. Each operation retains
its own Result or rejection; draining does not reinterpret a failed transfer as
a successful one.

Resource owners preserve the corresponding release guarantees. Playback sources
are released on consumer disposal or resource close. A source arriving during
close is released rather than published. A SQL open completing during close
cannot publish a usable handle. The platform keeps ownership of cached physical
SQL connections; closing one App does not delete its databases or shut down a
shared worker. SQL-only callers still use the device capability without
constructing a document.

The document factory does not own blob publication, transfer, or deletion. The
App composes app-local and account-remote blob capabilities independently. Each
capability owns its byte operation, admission, resource guards, and cleanup for
its own lifetime. A row creation records an available BlobId or URL as an
ordinary value; it neither copies bytes nor establishes a cross-store transaction.

`CreateRowOf` is the sole row creation input. Blob publication and deletion are
explicit capability operations. A local or remote ID can outlive the row, and
changing or deleting a row reference does not delete bytes. KV has no
blob-specific write contract and does not infer ownership from declarations.

## Consequences

Holding a table or KV handle before readiness is safe; operating on it is not.
Hydration preserves handle and root identity. One owner decides when operations
are usable, so consumers cannot bypass closure by retaining a method.

A raw `Y.Type` returned to an editor remains borrowed library state, not a
revocable capability. Owners must stop editors before closing. This decision
does not promise to intercept arbitrary writes through retained Yjs references.

This changes no storage address, wire protocol, or product workflow. It adds no
legacy migration or compatibility path. Generation policy, authenticated
authority identity, blob replacement/deletion, and capture crash behavior remain
separate implementation waves.

Recording publication belongs to the recorder and blob capabilities, not to
`CreateRowOf`. A later workflow stores the returned local BlobId as an ordinary
row value; it does not copy from or clean up a source because a row was created.
Each capability retains its own publication contract. This adds no cross-store
transaction or power-loss durability guarantee.

Current blob transfer primitives have no cancellation contract. A transfer that
does not settle can hold close pending. A timeout that released the backing while
a download could still write would violate ownership, so bounded shutdown is not
promised. App-owned workflows that span multiple awaited calls must handle close
between those calls; draining one upload does not admit its later row update or
compensation operation.

## Considered alternatives

- Forwarding getter facade: duplicates the operation surface and cannot revoke
  methods already returned.
- Proxy: hides the same extra owner behind dynamic property interception.
- Generic lifetime manager with activation hooks: exposes internal ordering as
  a second protocol when one lexical factory can enforce it.
- Two-phase persistence controller: creates an invalid controller state solely
  to preserve an identity no current consumer needs before readiness.
- Lifecycle callbacks passed to the device: make closure depend on another
  factory mirroring the document's private state and tracking its operations.
- Row-owned blob receipts: independent blob identities and explicit
  capability operations do not need a row ownership registry or single-use
  receipt.
