# 0372. Local and remote blobs open independently

- **Status:** Proposed
- **Date:** 2026-09-08
- **Unbuilt:** Independent blob openers, source-aware native transfer, and migration from App-owned blob access; real object-provider and installed desktop upload acceptance remain separate.

## Context

The App constructs local and remote blob access together. The remote member is
absent without an account. Its `addLocal(id)` method captures a local source
implicitly, and the desktop broker derives that source's namespace from the
remote destination URL. Separating handles requires making that source explicit.

## Decision

**Local and remote blob handles require different inputs and expose their actual capabilities.**

The target API is:

```ts
import { openLocalBlobs, openRemoteBlobs } from '@epicenter/app/blobs';

const local = await openLocalBlobs({ id });
const remote = await openRemoteBlobs({ id, account });

await remote.addFrom(local, blobId, { signal });
```

Local captures a device-local namespace with no Account. Remote requires an
Account and captures its identity and transport before asynchronous acquisition.
Neither requires a data definition or opens a row store. Neither retargets after
account replacement. Closing one handle leaves the other usable.

| Local | Remote |
| --- | --- |
| `add(blob)` returns a Result containing a BlobId | `add(blob)` returns a Result containing a remote URL |
| `get(id)`, `open(id)`, `delete(id)` | `get(url)`, `open(url)`, `delete(url)` |
| `stat(id)`, `list(options)` | `addFrom(local, id, options?)` |
| `signal`, `close()` | `signal`, `close()` |

Both `open` methods acquire disposable display sources. Durable IDs and URLs
are stored in rows; temporary display URLs are not. No common interface forces
remote enumeration, local HTTP locators, or optional methods onto these handles.

**A transfer names its source handle and creates an independent remote object.**

`add` can upload supplied bytes without local persistence. `addFrom` accepts an
actual LocalBlobs handle, validates its source provenance, and checks size before
reading bytes. Browser transfer reads that source. Native transfer streams its
file without materializing audio in the WebView. The native broker must receive
and authorize the explicit source namespace; it cannot infer it from the remote
destination. A memory or custom source cannot silently select a same-named host
file. Unsupported source transports refuse before upload.

Both handles must be usable when a transfer is admitted. Closing either cancels
that transfer and waits for settlement, without closing the other handle or
cancelling its unrelated operations. A cancelled or failed upload can leave an
unreferenced remote object. It never authorizes source deletion.

Each upload creates a fresh remote key. Remote objects retain the 25 MiB initial
limit, authenticated owner-pinned URLs, and complete extension-bearing keys.
The server enforces actual received size. The source format determines saved-file
content type; direct uploads retain their declared media type under existing
format validation. No format conversion occurs during transfer.

**Remote locators identify private objects and confer no access.**

URLs identify server, principal, namespace, and object. Reads and deletion use
the captured Account and refuse foreign destinations or redirects. Another
sign-in cannot revive retired access. Sharing a row does not share its owner's
private audio. Rows do not own blob lifetime: deletion is explicit, and closing
handles preserves saved local and remote objects.

Remote display requires no persistent local cache. Working-copy materialization
preserves remote URLs as opaque values; it does not fetch or inline payloads.
Structural archives, attachment synchronization, retry queues, shared buckets,
and cross-owner reference counting are not introduced.

## Consequences

An opened remote handle needs no account-presence branch. Local recording works
without an account, and upload remains explicit. The public `addLocal` source
assumption disappears, but supporting explicit sources requires broker protocol
work and closure tests. API changes preserve durable paths and keys; they do not
migrate or erase existing bytes.

## Considered alternatives

- Keep an optional remote member on App: makes consumers repeat opening policy.
- `remote.add(await local.get(id))`: loses size-before-read checks and native
  streaming without routing audio through the WebView.
- Accept any object with `get` and `stat`: cannot prove which native namespace
  supplies the upload and can read different bytes on different platforms.
- One generic blob interface: advertises operations unsupported by one side.
- Matching local and remote IDs: implies synchronization and retry identity that
  explicit independent uploads do not provide.

## Verification

Check independent close, disposable playback release, retained-operation fences,
size checks before payload reads, source namespaces different from destination
namespaces, unsupported-source refusal, and cancellation from either handle.
Native tests must verify the exact uploaded bytes and source directory. Confirm
foreign URLs and account retirement refuse without credential redirection.
