# 0393. Rows refer to blobs without owning their lifetime

- **Status:** Proposed
- **Date:** 2026-09-12
- **Unbuilt:** Hosted authority URLs in Personal and Shared rows. Whispering's Local rows still carry device-local `audioBlobId` values.
- **Amends:** [ADR-0154](0154-blob-access-is-address-only.md) at local listing: device-local blobs can be listed independently of rows; hosted access remains address-only. [ADR-0355](0355-local-and-account-sessions-share-the-application-data-api.md) at attachment ownership: rows store ordinary references without owning publication, transfer, or deletion of bytes.

## Context

Whispering saves Local audio through its store's `.blobs` handle and writes the
returned BlobId into a recording row. The former Save to Personal flow copied
bytes and created a separate Personal row. [ADR-0438](0438-hosted-blobs-have-stable-authority-urls.md)
establishes an authority URL as the hosted object's durable address. No current
application row cites one yet.

## Decision

**A row may cite bytes, but its lifetime does not own them.**

Local rows may contain a device-local BlobId. A Personal or Shared row
that cites hosted bytes contains the complete, credential-free authority URL as
an ordinary declared string value. The URL identifies an immutable object
with a fixed owner; signing into another account cannot reinterpret it. An
application maps references when it publishes or copies bytes between
owners. Store opening and Yjs synchronization do not transfer bytes.

No `field.blob()`, `field.attachment()`, one-file-per-row rule, automatic byte
queue, or server reference-liveness index follows from a cited URL. Temporary
download or presentation grants are never durable row values. A URL is an
address, not a credential: the authority checks personal ownership,
space membership, or public visibility on each read. Application code
chooses whether to fetch a private URL with its captured Account or present a
public URL directly.

The row may hold a title, transcript, dates, and application-specific media
details. The hosted object does not gain a reverse row ID. Several rows
may cite one URL, and an object may have no row. Deleting a row deletes only
that row. Explicit blob deletion can leave a broken citation. Losing the last
citation can leave an unreachable hosted object; there is no user-facing hosted
inventory or automatic reclaim pass. Internal object-store listing does not
make a parent authority URL a public collection endpoint.

Publication comes before saving a new row reference. If the row write fails,
the application retains the known URL and row values for retry. It can retry
the same row write when its row ID is known. If row creation was accepted but
the caller lost its row ID, it cannot promise a duplicate-free retry. A lost
publication response can leave an object whose URL the caller never received;
retrying publication may create another object. No atomic transaction spans
Yjs, local bytes, and hosted storage.

Materialization writes BlobIds and URLs as ordinary values. It does not copy
their bytes or prove future access to a private URL. Push must treat a changed
reference as an application-permitted field edit, never as an instruction to
publish or delete an object.

## Consequences

Row synchronization does not establish byte availability. A Personal URL can
be unavailable because the object was deleted, the Account lacks access, or
the authority is offline. A local replica of a Personal or Shared row retains
its URL, not a persistent local copy of its bytes. A saved working folder also
retains the citation but not the bytes. Local enumeration remains useful for
device-local maintenance; hosted object listing remains a deployment operation.

## Considered alternatives

- Delete bytes when the last row disappears: requires a reliable liveness view
  across offline replicas and other applications.
- Maintain a hosted inventory independent of rows: keeps uncited objects
  findable but adds a catalog and retention promise.
- Store bytes in Yjs: makes every replica receive large payloads it may never
  play.
