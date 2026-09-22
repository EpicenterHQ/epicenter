# 0372. Local and remote blobs open independently

- **Status:** Proposed
- **Date:** 2026-09-08
- **Unbuilt:** Public `copyFrom`, remote `add`, ID-addressed remote operations, same-ID publication, and authenticated streaming presentation. Independent constructors already exist; current remote upload still creates a fresh ID.

## Context

Applications create bytes, copy saved objects, read bytes for computation, and
acquire URLs for presentation. A local-source-only upload API makes remote
creation depend on local persistence. A public arbitrary-ID writer makes every
application responsible for assigning immutable identities. Treating every read
as a download forces playback to wait for a durable local write.

## Decision

**Independent stores create new objects with `add`, preserve stored objects with
`copyFrom`, read bytes with `get`, and acquire presentation with `open`.**

The following is the target public API, not a claim that all methods exist:

```ts
import { openLocalBlobs, openRemoteBlobs } from '@epicenter/app/blobs';

const local = await openLocalBlobs({ id: 'so.epicenter.capture' });
const remote = await openRemoteBlobs({ id: 'so.epicenter.library', account });

const added = await local.add(bytes);
if (added.error) return added;
const copied = await remote.copyFrom(local, added.data, { signal });
if (copied.error) return copied;
const offline = await openLocalBlobs({ id: 'so.epicenter.library' });
return offline.copyFrom(remote, added.data, { signal });
```

Local captures a namespace without an Account. Remote captures a namespace and
Account identity/transport before asynchronous acquisition. Neither requires
the other handle, a schema, or a row store. The namespace and BlobId are distinct;
[ADR-0426](0426-blob-identities-survive-copies-between-scoped-locations.md) owns
address grammar, placement, and identity. Handles never retarget after account
replacement. Closing one does not close the other.

| Operation | Local and remote contract |
| --- | --- |
| `add(bytes)` | Accept Blob/File input, select its format, mint a BlobId, publish complete bytes, return `Result<BlobId, E>` |
| `copyFrom(source, blobId, { signal }?)` | Copy committed bytes from an actual supported source handle into this destination under the same ID; return `Result<void, E>` after publication |
| `get(blobId)` | Return `Result<Blob, E>` containing the complete payload, without creating a persistent copy in another store |
| `open(blobId)` | Return `Result<BlobSource, E>` with a usable `url` and idempotent disposal; no promise of complete download or offline retention |
| `delete(blobId)` | Remove only this placement; deleting an absent object succeeds |
| `signal`, `close()` | Fence new work and settle admitted work without deleting committed bytes |

Local retains `stat` and `list` for metadata and maintenance. Remote enumeration
is not introduced for interface symmetry. A remote metadata operation may be
added only for a concrete availability/copy caller; internal HEAD support need
not become a new public method. Expected operational errors use Results;
openers and `close()` retain rejecting Promise contracts. Invalid or closed
handle use may throw. Final application callers own presentation.

### New bytes and existing objects have different entrypoints

`remote.add(bytes)` can create a remote object without first saving locally.
`add` creates identity even if another object has equal bytes. Capture/import
and transformations use `add` or a producer's private publication capability.
The recorder keeps its selected ID across Stop publication retries.

Application handles expose no arbitrary-ID `put`. Storage needs atomic
publication under an established identity, but no particular internal method
name, exported interface, or wrapper is required. Keep a low-level `put` only
where real adapters/producers use it. Its existence does not justify public ID
assignment. Future restore from externally assigned IDs needs a concrete
validated ingestion contract; it is not implemented speculatively here.

`copyFrom` is the one public identity-preserving transfer spelling. Remove
`upload`, `download`, `addFrom`, `addLocal`, and top-level `copyBlob` aliases from
the target application surface. No destination-ID override exists. To create a
new identity for supplied bytes, use `add`.

### Copy owns one operation across independent handles

The implementation must name its supported source/destination pairs. Local to
remote, remote to local, and local to local across namespaces are required.
Remote to remote is a separate acceptance case before a source type advertises
it; it cannot become an unrestricted URL fetch or use destination credentials
against the source server. Reject unsupported pairs before reading payloads or
publishing. Do not promise all structural objects with a `get` method are sources.

Each admitted copy uses both captured scopes. Native source provenance comes
from the actual handle; a test/custom source must not silently select a
same-named native file. Cross-namespace copying is valid. Cross-account/authority
access requires independently authorized source and destination handles.

Both handles must be usable at admission. The copy is tracked by both until
settlement. Closing either cancels and drains admitted transfer work without
closing the other or cancelling its unrelated work. Preserve opened source
snapshots and owned descriptors; source deletion racing a copy must produce
complete captured bytes or a failure, never substituted or partial bytes.
Destination publication is atomic, without overwriting an occupied identity.
Verified identical retries succeed; different bytes conflict. If equality cannot
be verified, report conflict rather than guess.

Cancellation or a lost acknowledgment after publication can leave a complete
destination object. Neither failure nor close promises rollback. The source is
never deleted. Reconciliation uses the same ID and verified content, not a new
upload identity. There is no transaction spanning stores or application rows.

### The runtime chooses transport

`get` followed by an internal publication can implement a copy, but it loses
source provenance at the public Blob boundary. Native copying should retain
host file streaming rather than transporting a complete payload through the
WebView. Browser implementations may use complete Blobs where their storage
requires them. Preserve size checks before payload reads where metadata exists.

A Blob is not necessarily a JavaScript heap buffer. The current WebView
`response.blob()` and broker request preparation do impose full-body completion
barriers; browser writes and Bun's ordinary `get` explicitly use ArrayBuffers.
Measure peak process memory and latency rather than assuming copy counts.
Opening remote media follows
[ADR-0427](0427-opening-a-blob-acquires-presentation-without-retaining-a-copy.md).
No generic transfer engine, capability registry, durable queue, automatic retry,
background synchronization, or cache manager belongs to this copy operation.

## Consequences

Applications choose scopes once at acquisition and supply source handles only
for copying. Signed-out recording and local playback remain possible. Remote
creation and remote playback do not require local persistence. Public byte reads
remain available for transcription without retaining another device copy.

The physical publication primitive remains necessary even when its application
method disappears. The smaller public surface costs arbitrary external-ID
writes and requires deliberate copy/provenance and collision handling. It does
not prove global equality between untrusted stores with matching opaque IDs.

Current READMEs describe implemented exports. Implementation must change server,
client, host relay, adapters, callers, and tests together before removing the old
path. Historical APIs remain history; no compatibility aliases are required.

## Considered alternatives

- Capture LocalBlobs in the remote constructor: makes remote-only creation and
  presentation acquire an unrelated dependency and ties namespace selection.
- Expose `put(id, bytes)` to all application callers: permits arbitrary identity
  assignment without a demonstrated import/restore consumer.
- Require applications to compose every `get` and write: loses native source
  provenance and spreads transfer lifetime handling into callers.
- Top-level copy plus upload/download aliases: repeats one operation's meaning.
- Public destination-ID overrides: makes copying another creation API.
- Force equal method sets: invents remote enumeration to satisfy a generic type.

## Verification

Prove new-byte creation, both local/remote copy directions, cross-namespace local
copy, exact byte/ID preservation, atomic publication, identical and conflicting
occupied keys, interrupted transfers, and independent close. Verify custom
sources never borrow native provenance. Compare browser and native results,
including host descriptor release and account retirement. Preserve recorder
Stop publication and subsequent row-write failure outcomes. Public type checks
must reject removed methods and unsupported source pairs.
