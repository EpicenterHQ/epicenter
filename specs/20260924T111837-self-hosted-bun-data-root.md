# Self-hosted Bun data root

**Date**: 2026-09-24
**Status**: Draft
**Owner**: Epicenter server

## One Sentence

The self-hosted Bun deployment serves Personal sync and hosted blobs from one
process and one persistent data root while keeping the authority protocol
unchanged.

## Current State

`apps/self-host/server.ts` serves named-user auth from `auth.sqlite` and mounts
the Personal hosted-blob routes. Those routes resolve the S3 adapter from the
request environment. Bun does not mount Personal sync. The Worker entry mounts
sync through a SQLite Durable Object. A local S3 gateway can store blob bytes
on the same machine, but it is a second service.

## Target Shape

```txt
app build, fixed authority origin
            |
       Hono authority
        /     |      \
      auth   sync   hosted blobs
        |     |      |
        +-----+------+---- Bun data root (default)
                         auth SQLite, sync SQLite, local hosted bytes

custom Bun composition: hosted blobs -> S3
Worker composition:     hosted blobs -> S3/R2; sync -> Durable Object SQLite
```

The reference Bun setup starts as one process and persists everything under
one configured root. It has one active owner of that root. Hosted routes keep
their stable URL shape, access checks, media headers, range behavior, and
deletion semantics. Deployment composition supplies the physical blob store;
the route does not discover one from `c.env` on each request. Auth and sync do
not inherit the blob store's interface.

This target is the decision in [ADR-0447](../docs/adr/0447-the-bun-self-hosted-server-owns-one-data-root.md).
[ADR-0438](../docs/adr/0438-hosted-blobs-have-stable-authority-urls.md) owns URL
identity, and [ADR-0414](../docs/adr/0414-an-application-build-connects-to-one-server.md)
owns fixed app authority selection.

## Implementation Plan

1. Extract the physical operations currently used by
   `mountPersonalAuthorityBlobs` into a narrow deployment-supplied hosted-blob
   capability. Keep ownership, content policy, conditional and range responses,
   and URL construction in the existing route. Bind the current S3 adapter in
   both Worker entries and in Bun when explicitly configured.
2. Prototype the Bun local backend beneath a temporary data root. Compare
   regular files plus metadata with a dedicated SQLite BLOB database against
   create-only publication, crash interruption, content type, byte-range reads,
   deletion, owner-wide cleanup, and operator recovery. Choose one layout from
   that evidence and implement it behind the same physical capability. Do not
   expose the layout in app URLs.
3. Bring the Personal sync authority to Bun using the existing SQLite database
   contract. Account for WebSocket upgrade, connection ownership, shutdown,
   and the server lifetime; an SQLite adapter alone is insufficient. Use one
   process per data root in the reference deployment.
4. Add a single data-root setting for the Bun reference and place auth, sync,
   and local hosted bytes beneath it. Make the operator commands use the same
   auth database path. Keep a deliberate S3 configuration path for operators
   who want managed object storage.
5. Update `apps/self-host/README.md`, examples, and the runtime profile to
   describe what now runs. State the files an operator must protect and give a
   tested stop/snapshot/restore procedure. Remove the local gateway from the
   default self-host setup only after direct local storage passes the same
   lifecycle checks.

## Verification

- Start a fresh Bun deployment with only a data root and public origin; enroll
  a user, sign in, sync a document, publish private and public blobs, restart,
  and read them again. No S3 service should be needed.
- Run the existing hosted-blob lifecycle against both S3 and local storage:
  exact bytes, owner enforcement, anonymous public read, HEAD, ranges,
  conditional reads, create-only writes, and deletion. Exercise public media
  playback with the actual response headers.
- Interrupt local publication and verify that a partial or replaced object
  cannot appear at an issued URL. Verify clean shutdown and reopening of auth
  and sync databases, including SQLite sidecar files.
- Verify Worker/R2 through its actual S3 endpoint. The earlier real-storage
  report covered a Bun server with a disposable S3-compatible gateway and
  browser playback; it did not cover Worker/R2 or this local implementation.
- Run the relevant Bun server tests, runtime profile, typechecks, and the
  documentation hygiene check. Do not claim the reference complete until Bun
  sync and direct local blobs both pass.

## Boundaries

The reference deployment does not provide active-active serving, automatic
backend migration, dual writes, a transaction spanning blob publication and a
Yjs row, scheduled snapshots, a restore API, or user-level data export. An
operator who selects S3 or runs a customized Hono composition protects all
durable stores in that arrangement. Copying a live SQLite directory is not
declared a consistent backup procedure.
