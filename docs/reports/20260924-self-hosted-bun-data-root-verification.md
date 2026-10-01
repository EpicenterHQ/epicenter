# Self-hosted Bun data-root verification

Date: 2026-09-24 (Singapore)

## Layout decision

A dedicated `blobs.sqlite` stores each object's bytes, content type, ETag, and
last-modified value in one row. A Bun prototype inserted a row inside an
interrupted transaction and observed zero visible rows after rollback. A second
insert for the same key raised `SQLITE_CONSTRAINT_PRIMARYKEY`. SQLite `substr`
returned the requested byte window, and deletion left zero rows. Regular files
plus a metadata database would require a staged file, a publication ordering
rule, and orphan cleanup. The SQLite BLOB layout has no split publication
state. It copies at most the 25 MiB route upload limit into SQLite; metadata
and short ranges avoid loading the whole BLOB.

## Verified locally

- `bun test packages/server/src apps/self-host`: 195 passed, 0 failed. This
  includes operator-command admission, real passkey enrollment, named-session sign-in, Personal WebSocket
  admission and update acknowledgement, current download after restart, local
  private and public blob reads after restart, and a one-owner-per-root check.
  The lifecycle stops the server, copies the entire root, restores that copy,
  and verifies the saved auth, sync, and blob data.
- The local blob suite checks exact bytes, owner denial, anonymous public read,
  HEAD, ranges, `If-Match`, `If-Range`, create-only collision, and deletion.
- Headless Chrome loaded and played a public one-second WAV through the local
  authority. Its duration was one second, `play()` resolved, and playback time
  advanced past 0.1 seconds.
- `bun run --cwd packages/server typecheck` and
  `bun run --cwd apps/self-host typecheck` passed.
- `bun run --cwd packages/server test:workers` passed: 8 files, 32 tests.
  These run workerd and Durable Objects, but use test bindings rather than a
  deployed R2 S3 endpoint.
- A disposable Bun HTTP endpoint exercised the revised S3 adapter's signed
  PUT, create-only collision, HEAD metadata, exact range GET, and idempotent
  DELETE. It is a wire test, not a live S3 service.

## Environmental limits

The checkout has no configured R2 S3 endpoint or credentials. Wrangler is
logged in, but its reported OAuth scopes do not include R2 access. The Docker
daemon is unavailable. The revised S3 adapter's route and wire tests use
simulated storage; the earlier
[real-storage run](20260924-personal-hosted-blob-real-storage-verification.md)
covered the previous S3 adapter against a disposable gateway. The revised
adapter still needs a fresh lifecycle run against an actual S3-compatible
endpoint, and Worker/R2 needs a run through its actual endpoint. Neither is
counted as passed here.

`check:doc-hygiene` reports 75 ADR-status issues and `check:doc-paths` reports
45 dead references outside the task-owned files. Neither check passes for the
current checkout; neither report identified a path or ADR introduced here.
