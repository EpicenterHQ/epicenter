# 0544. A blob is a file in its folder, and Git decides how it travels

- **Status:** Proposed
- **Date:** 2026-10-15
- **Unbuilt:** Git LFS for hosted folders; the hosted LFS endpoint; allowing `git-lfs` in the shell's `run_git`; Whispering's `.gitattributes`.

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

## Consequences

- The per-app device blob cache in app data has no job left: LFS keeps its
  objects in each folder's `.git/lfs`.
- A file not yet downloaded is its pointer: a reference until it is fetched.
- Desktop, CLI, and an agent's plain `git` all move blobs the same way.
- Users need `git-lfs`, or Epicenter ships it.

Open before this is built: whether Cloudflare Artifacts speaks the LFS protocol
(if not, the Worker implements the LFS batch API over its blob storage), and
allowing LFS's clean and smudge filters and its pre-push step in a `run_git`
that disables hooks.

## Considered alternatives

- **A blob as a URL, local or remote.** The folder stops describing itself, and
  agents cannot reach the bytes.
- **Commit every blob.** Every clone carries every recording.
