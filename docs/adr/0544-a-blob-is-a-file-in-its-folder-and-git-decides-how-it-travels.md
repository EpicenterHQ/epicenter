# 0544. A blob is a file in its folder, and Git decides how it travels

- **Status:** Proposed
- **Date:** 2026-10-15
- **Unbuilt:** all of it, in this order: the Worker's LFS routes; the desktop's bundled `git-lfs` and the engine's LFS checkpoint, push, and fetch; browser download; browser upload. Until both clients handle LFS, the engine keeps refusing `filter` attributes.

## Context

Blobs live in two places today: a per-app device cache in app data
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
audio needs LFS there. The Worker serves `POST /git/<name>.git/info/lfs/objects/batch`
and `.../info/lfs/verify` beside the Git routes in `mountGitApp`, accepts the
same credential Git sends by checking it against Artifacts, and answers with
presigned URLs on its S3-compatible blob storage under `lfs/<repo>/<oid>`, so
the bytes never pass through the Worker. `.../info/lfs/locks/verify` answers
501.

**The desktop ships `git-lfs` and fixes its configuration on every run.**
`run_git` passes `filter.lfs.process`, `filter.lfs.clean`, `filter.lfs.smudge`,
and `filter.lfs.required=true` naming the bundled binary by absolute path, and
`lfs.url`, so neither a missing `git lfs install` nor another program's
configuration changes what runs. LFS objects upload with
`git lfs push --object-id` before the refs that name them are pushed; no
pre-push hook runs. Incoming pointers are fetched with `git lfs fetch` and
materialized by the shell into data paths under the same checked publish as
every save.

**The browser has its own LFS client**, since isomorphic-git has none: it reads
the three-line pointer, asks the batch endpoint with the person's session, and
fetches the returned link, about 150 lines. Download comes first; until upload
exists, the browser refuses to change an LFS path.

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

- The per-app device blob cache in app data has no job left: LFS keeps its
  objects in each folder's `.git/lfs`.
- A file not yet downloaded is its pointer: a reference until it is fetched.
- Desktop, CLI, and an agent's plain `git` all move blobs the same way.
- Epicenter ships `git-lfs` as a sidecar (MIT, about 13 MB per architecture);
  a Finder-launched app cannot rely on a Homebrew install being on its `PATH`.

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
