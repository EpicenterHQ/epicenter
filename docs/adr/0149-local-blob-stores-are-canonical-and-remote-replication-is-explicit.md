# 0149. Local blob stores are canonical and remote replication is explicit

- **Status:** Superseded
- **Date:** 2026-07-18
- **Superseded by:** [ADR-0171](0171-every-durable-local-write-leaves-an-automatic-authority-obligation.md)
- **Relates:** [ADR-0349](0349-local-blobs-belong-to-the-app-on-this-device.md) (local storage layout) and [ADR-0372](0372-local-and-remote-blobs-open-independently.md) (current target: store-owned blob capabilities with `copyFrom`, not the historical upload/download/purge surface)

## Context

Some Epicenter applications never need remote bytes, while others want a user
or setting to make selected objects durable across devices. Treating remote
storage as automatic blob sync would require eager downloads, background
workers, retry queues, deletion tombstones, and persisted transfer states even
for applications that do not need them.

## Decision

Application operations always read and write through a local `BlobStore`. A
signed-in composition may additionally attach one `BlobRemote` that performs
explicit same-ID `upload`, `download`, and `purge` operations. Every operation
is one-shot. The blob layer does not schedule work, retry failures, download
eagerly, or persist transfer state.

Native capture may finalize directly into the same host-owned local blob
backend and return only `BlobId`. This is the sanctioned exception to routing a
write through the portable TypeScript `BlobStore.put` method: it keeps complete
recording bytes and native paths out of JSON IPC while preserving one canonical
store and identity. Playback URLs likewise stay outside the store: they are
acquired through the sibling `BlobSources` contract, whose implementations are
platform-owned, never a second byte store or a method on `BlobStore`.

Epicenter Desktop implements that store once in its authenticated Bun loopback
host at top-level `<appData>/blobs`, without workspace or application
namespacing. Trusted surfaces use session-protected same-origin HTTP for
streaming writes, byte-range reads, stat, and deletion. Native capture may
publish into the same filesystem layout. This refuses a custom Tauri protocol,
whole-file WebView IPC, and a second desktop storage implementation.

Remote implementations are platform-specific behind one `BlobRemote`
contract. Browser upload can use a local `Blob`; desktop remote transfer
belongs to the Bun host so it can stream a lazy file directly to the presigned
operation.
The system does not route complete desktop recordings through the WebView merely
to reuse one transport implementation. The presigned operation is an
implementation detail of whichever process holds the deployment credential:
that process mints its own target, so no host route accepts a caller-supplied
destination URL and no signed URL enters application code.

## Consequences

Offline local work remains unconditional and applications compose remote
durability only when they need it. Whispering can persist one successful
`uploadedAt` timestamp and derive availability from that timestamp plus a local
`stat`, without inventing a blob state machine. The timestamp is historical UI
bookkeeping, never proof that the remote object still exists: removing the
local copy first repeats the idempotent upload, and a remote 404 clears a stale
marker. Remote purge requires a live remote capability; there is no offline
delete-everywhere promise. Automatic age-based retention is removed because it
cannot honor that rule offline without a pending-delete ledger. This decision
does not choose whether a consumer encrypts bytes before upload.

## Considered alternatives

- One hybrid store that uploads automatically: hides network policy inside a
  storage primitive and forces every caller into retry and reconciliation.
- Two unrelated local and remote IDs: requires a mapping table and makes rows
  environment-dependent.
