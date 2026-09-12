# 0091. Blobs trade a file for a durable content-addressed URL; documents are the only manifest

- **Status:** Accepted
- **Date:** 2026-07-01
- **Amended by:** [ADR-0092](0092-identity-is-the-partition.md), [ADR-0148](0148-blobs-use-opaque-identifiers-rather-than-content-hashes.md), [ADR-0154](0154-blob-access-is-address-only.md), and [ADR-0393](0393-a-blob-is-addressed-by-its-row-and-the-account-holds-every-one.md) at the whole mechanism: there is no content-addressed URL, no `/api/blobs`, and no citation found in prose. A blob is the object at its row's path under the library's mount, and "documents are the only manifest" is now literal, because the row is the address.

> **2026-07-02 amendment:** The durable read URL is now `<origin>/api/blobs/<sha256>`. Auth resolves the principal, so the URL no longer echoes the owner or principal id.

## Context

The `epicenter blobs` CLI shipped as two products in one command tree: a content-addressed store, and half of a lockfile-sync layer (`epicenter.blobs.lock`, `pull`, path machinery in `add`) with no `push`, no `status`, and a `rm` that desyncs the map by design. The real workflow the CLI serves is a git vault whose markdown cites big files: the file's disk location stops mattering the moment a document holds a reference to it. The read URL embeds the content address, now `<origin>/api/blobs/<sha256>` after ADR-0092, which makes every citation self-describing.

## Decision

`epicenter blobs add <file|url>` trades bytes that do not fit in git for a durable content-addressed URL, and the documents that cite that URL are the only manifest. The CLI is four store verbs: `add` (prints the URL; idempotent because dedupe returns the same URL for the same bytes), `ls`, `get`, `rm`. The lockfile, `pull`, `push`/`status`, and all path machinery are refused; retrieval, audit, garbage collection, and origin migration are derived from the hash inside the cited URL (grep the vault, `blobs get <sha256>`, find-replace the origin prefix). The division of labor: small enough for git means commit it and reference by relative path; too big for git means trade it for a URL; publish-time path-to-URL resolution and the public serving tier belong to the post pipeline, later.

## Consequences

A fresh clone cannot bulk-restore binaries to their original disk paths; that workflow is git-lfs's product and Epicenter refuses to compete with it. Any cited blob remains recoverable on any machine because its hash rides in the citation. `rm` breaks every citation of the deleted blob forever, and its help text says so; a safer `gc` (delete only unreferenced) is earned later. URLs couple documents to an origin; the embedded hash keeps a deployment migration a mechanical find-replace rather than data loss. `add` of an http(s) source archives it and prints the URL without writing anything to disk.

## Considered alternatives

- Finish the sync layer (`push`, `status`, a map-maintaining `rm`): that is building git-lfs; mature tools already own restore-to-path.
- A custom `blob:` reference scheme: needs a resolver plugin in every renderer; a plain https URL works everywhere today.
- Keep the lockfile as a passive record: it is a cache of grep that drifts from both the store and the documents.
