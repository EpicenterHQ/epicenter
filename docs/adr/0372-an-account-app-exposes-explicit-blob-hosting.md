# 0372. An account App exposes explicit blob hosting

- **Status:** Proposed
- **Date:** 2026-09-08
- **Unverified:** Real object-provider and installed desktop upload acceptance.

## Decision

A local App exposes `app.blobs.local`. An account App also exposes
`app.blobs.remote`, already bound to its captured Account and app ID. Keep these
full paths at call sites. There is no remote factory on the App, nullable remote
property on a known account App, mutable current account, or availability flag.

```ts
await app.blobs.local.open(blobId);
await app.blobs.remote.addLocal(blobId);
await app.blobs.remote.add(pastedImage);
```

The remote API is `add`, `addLocal`, `get`, `open`, and `delete`.
Both add operations return a durable owner-pinned API URL after the server stores
an immutable object under a fresh remote ID. `add(Blob)` does not write local
storage. `addLocal(id)` reads the canonical app-local store and leaves it intact.
Desktop uploads stream the host file without loading it through frontend JS.
Repeated uploads may create duplicate objects; there is no transfer journal,
content deduplication, mirror identity, upload ticket, or automatic retry queue.

Fresh remote IDs include a format extension under the same key grammar as
local BlobIds. The server selects that extension from the accepted upload media
type; a caller does not select the random identity or reuse its local ID.
Direct uploads apply the same input-format policy as local creation before
sending bytes. For a File whose media type is empty or generic, a supported
filename supplies the conventional upload media type. A supported meaningful
media type takes precedence over the filename. The client sends that type, not
a filename header; the server validates it and selects the remote suffix.
Uploading a File directly and saving it locally before uploading must agree
on its format. Direct upload does not require local persistence.
`addLocal(id)` obtains conventional media type and actual size from the local
store. Provider-native Content-Type metadata can remain; flat local files do
not require removing metadata supplied by an object-storage provider. Exact
local MIME parameters are not recovered from an extension.

The owner-pinned URL ends in a complete extension-bearing key. The user confirmed
zero users and no existing data for the September 17, 2026 clean break.
Validators reject extensionless URLs; no hosted objects are converted or reset.
Archive capture and recovery preserve absolute HTTP(S) URLs as opaque values.
They do not fetch, convert, or inline remotely hosted bytes as local dependencies.

Hosting uses direct authenticated requests with a 25 MiB initial object limit.
The server enforces actual received size. Saved-file uploads check byte length
before reading bytes. Expanding this bound is a product/transport decision,
not a consequence of efficient native streaming.

The owner-pinned URL identifies server, principal, app, and object independently
of the account later presenting it. Reads/deletes reject a different destination
rather than attaching credentials to an arbitrary URL. `get` returns bytes;
`open` acquires a disposable display URL. A private durable address is not
necessarily usable directly in an img or audio element. No persistent local
cache is required to display remotely hosted content.

App closure cancels its network operations and releases display resources.
Account retirement permanently disables its captured transport, including
native uploads; another sign-in does not revive old handles. An ambiguous
upload outcome may leave an unreferenced remote object. Failed uploads never
authorize deleting their local source.

## Consequences

Remote storage is account-owned even when the App opens a shared row library.
Sharing rows does not grant access to the referenced files. The server stores
objects under principal/app/object identity; it needs no hydrated Yjs document
or blob-to-row ownership index. Row deletion and remote deletion are separate.

Standalone constructors remain useful for a blob-management tool or a local
library using separately selected hosting. App access composes the same
storage primitives and adds its admission and shutdown lifetime.

## Considered alternatives

- Automatic attachment synchronization: creates delivery obligations and recovery
  states that explicit one-shot uploads do not need.
- Matching local and remote IDs: introduces mirror semantics and retry identity.
- Download into durable local storage before display: creates a cache and cleanup
  obligation for an online-only image editor.
- A universal file/source token: exposes platform transport mechanics to callers.
- A shared library bucket chosen implicitly by row ownership: conflates the
  authorization of documents and uploaded objects.
