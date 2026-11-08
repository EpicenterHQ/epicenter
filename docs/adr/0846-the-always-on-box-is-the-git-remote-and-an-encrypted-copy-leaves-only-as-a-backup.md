# 0846. The always-on box is the Git remote, and an encrypted copy leaves only as a backup

- **Status:** Proposed
- **Date:** 2026-11-08
- **Relates:** [ADR-0842](0842-an-action-is-a-commit-and-the-repository-is-the-sync.md) (the repository is the sync), [ADR-0844](0844-one-runner-runs-anywhere-and-every-surface-is-a-view-over-it.md) (the box is the primary runner).
- **Unbuilt:** all of it: the box serving repositories over SSH, `epicenter sync` defaulting to it, and the scheduled encrypted backup.

## Context

The author wants app repositories encrypted wherever a third party stores them,
from the start; Mail is the most sensitive thing they will keep. The first
answer was an encrypted remote on GitHub with `git-remote-gcrypt`. Its own
documentation rules that out as the everyday remote: over a Git URL it uploads
the entire history on every push, and "every git push effectively has
`--force`", so two machines pushing (the box and a laptop) can silently
overwrite each other. `git-crypt` encrypts file contents only, leaves names and
commit messages readable, and turns merges of encrypted files into conflicts of
ciphertext.

## Decision

**The box is where repositories meet.** Each app repository's `origin` is the
box, reached over SSH through Tailscale. The laptop pulls and pushes there;
`epicenter sync` treats it like any remote. No third party holds the data.

**An encrypted copy leaves only as a backup, and only the box pushes it.** On a
schedule, the box pushes each repository to an encrypted remote
(`git-remote-gcrypt`, to GitHub or any host). With one writer, gcrypt's forced
pushes overwrite nothing, and its full uploads happen once per backup, not once
per action. The key lives on the box and in the person's password manager.

**The box's disk is encrypted** (FileVault, LUKS, or BitLocker), which covers a
lost or sold machine. While running, the box reads the data in the clear,
because it computes on it.

## Considered alternatives

- **`git-remote-gcrypt` as everyday remote.** Full-history uploads on every
  push, and forced pushes between two writers.
- **`git-crypt`.** Names and messages readable; encrypted files merge as
  ciphertext.
- **A plain private host (GitHub, Artifacts).** Simplest, and the host reads
  everything. Remains a choice for a person without a box.

## Consequences

- An encrypted repository cannot be served by Epicenter Cloud's file API,
  which reads files to serve them. A person who wants Cloud to serve an app
  trusts Cloud with that app's data; the box and the phone reaching it need no
  such trust.
- Without the box reachable, two laptops sync only through the backup's
  restore path, not each other. A person without a box uses a private host.
