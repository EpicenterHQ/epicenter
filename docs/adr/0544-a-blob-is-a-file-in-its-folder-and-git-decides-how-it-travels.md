# 0544. A blob is a file in its folder, and Git decides how it travels

- **Status:** Accepted
- **Date:** 2026-10-15
- **Amended by:** [ADR-0577](0577-audio-stays-on-the-machine-that-recorded-it.md) at "Epicenter's hosted blob storage is the LFS server for hosted folders" and the deletions "With the LFS wave": the hosted blob routes, `@epicenter/blobs`, and `s3-blob-store.ts` are deleted now, and the LFS store is chosen when LFS is built. Until then Whispering's audio is in `audio/`, which its definition declares local, so no commit carries it; LFS stays the later path for audio.
- **Unbuilt:** all of it, in this order: the Worker's LFS routes; the engine's LFS client, download first, then upload. Until it uploads, the engine keeps refusing `filter` attributes.

## Context

Blobs live in two places today: a per-app device cache in app data
<!-- doc-path-check: ignore-next-line (deleted with the Bun host in wave 3) -->
(`apps/<app-id>/device/<owner>/blobs`, `apps/epicenter/src/main.ts`) and hosted
blob routes in `apps/api` backed by S3-compatible storage (`BLOBS_S3_*`).
Whispering commits audio as real bytes, with no LFS. A row that refers to a
blob by URL alone leaves the folder unable to describe itself, and an agent
unable to reach the bytes.

## Decision

**A blob is a file in its folder.** A recording is
`so.epicenter.whispering/recordings/2026-10-15-0930.wav`; a row refers to it by
its path in the folder.

**How a file's bytes travel is declared per path in the folder, with Git's own
files.**

| Declared in | Its bytes |
| --- | --- |
| nothing (the default) | in Git history |
| `.gitattributes`, e.g. `recordings/*.wav filter=lfs diff=lfs merge=lfs -text` | in an LFS store; Git keeps a pointer |
| `.gitignore` | stay on this machine |

An app writes the default policy for its folder; a person or an agent changes
it by editing those files.

**Epicenter's hosted blob storage is the LFS server for hosted folders.**
Cloudflare Artifacts has no LFS (its documentation and changelog through
2026-10-01 name none), and caps a file at 32 MB and a repository at 1 GB, so
audio needs LFS there. The Worker serves `POST /<namespace>/<name>.git/info/lfs/objects/batch`
and `.../info/lfs/verify` on `git.epicenter.so` beside the Git routes in `mountGitApp`, checks the same
access token and namespace Git requests carry ([ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md),
[ADR-0549](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md)), and answers with
presigned URLs on its S3-compatible blob storage under `lfs/<repo>/<oid>`, so
the bytes never pass through the Worker. `.../info/lfs/locks/verify` answers
501.

**The folder engine has one LFS client, in TypeScript, for every host.** The
browser, the desktop page, and Bun run the same code in `@epicenter/folder`:
it reads and writes the three-line pointer, asks the batch endpoint with the
grant's access token for `git.epicenter.so`, and moves bytes with `fetch` to
and from the presigned links it returns. Saving an LFS path uploads the object,
then stores its pointer as the path's blob (on the desktop and in Bun with
`git hash-object -w --stdin`, which runs no filters); an incoming pointer is downloaded and materialized into its data path
under the same checked publish as every save. Epicenter configures no
`filter.lfs` in `run_git` and ships no `git-lfs`. An agent or a terminal using
plain `git` on the same repository installs `git-lfs` itself and reads the same
pointers.

**Embedding a blob writes a file and links it by relative path.** An image
pasted into a row's body becomes `attachments/<name>` in the folder, marked for
LFS by `.gitattributes`, and the body says `![](attachments/<name>)`. A viewer
shows it whether its bytes are downloaded yet or not.

**Blob bytes are private.** The batch endpoint answers only a person whose
token the repository accepts, with a presigned link that expires within
minutes; there is no public link to a blob. Objects are keyed by SHA-256 and
never change, so each device caches them by hash indefinitely and may delete
the cache at any time.

## Consequences

- The per-app device blob cache in app data has no job left: LFS objects live
  in each folder's `.git/lfs`.
- A file not yet downloaded is its pointer: a reference until it is fetched.
- Every host moves blobs through one client; an agent's plain `git` reads the
  same pointers through its own `git-lfs`.
- A plain `git` without `git-lfs` checks out pointers, not bytes.

Deleted:

- Already, before LFS: the device blob store (`@epicenter/blobs`'s browser,
  Bun, webview, and native entries, the desktop host's
  `/api/apps/:appId/blobs` routes, and Rust `blobs.rs`) and Rust
  transcription and Opus encoding by blob id (`transcribe_recording`,
  `encode_recording_for_upload`). None had a caller.
- With the LFS wave: `@epicenter/blobs`, which by then holds only the Personal
  hosted URL grammar; the public Personal blob routes
  (`mountPersonalAuthorityBlobs`, `packages/server/src/routes/authority-blobs.ts`);
  and `createPersonalHostedBlobs` in `@epicenter/client`. `s3-blob-store.ts`
  stays only if it presigns `lfs/<repo>/<oid>`.

Open before this is built: whether a read-only Artifacts token is refused for
`git-receive-pack` (the upload check relies on it), and whether R2 enforces a
signed checksum on a presigned PUT (if not, `verify` hashes the stored object).
A pointer whose object cannot be downloaded needs a stated policy. Measured in
a feasibility spike on 2026-10-15 with git 2.50.1 and git-lfs 3.8.0.

## Considered alternatives

- **Commit every blob.** Every clone carries every recording, and Artifacts
  refuses a file over 32 MB.
- **A blob as a hosted URL in the markdown**, uploaded to Epicenter's storage
  and cached by id. It works in a browser without an LFS client, but the
  folder stops describing itself, agents need Epicenter's API to reach the
  bytes, and a folder synced to GitHub still keeps its blobs on Epicenter. The
  LFS client the browser needs makes the same request this design would.
- **Unguessable public links.** Anyone who sees the link sees the blob.
- **A bundled `git-lfs` with `filter.lfs.*` fixed in `run_git`.** The engine
  writes objects with `git hash-object --stdin`, which runs no filters, so the
  configuration would be inert for its own reads and writes, and the browser
  would still need its own client: two clients and a 13 MB sidecar per
  architecture.
