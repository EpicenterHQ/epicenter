# 0803. Clients sync only with Epicenter servers, and sync is a function of two stores

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Amends:** [ADR-0733](0733-your-own-git-in-an-epicenter-folder-is-plain-git.md) at a folder syncing with any Git remote: a folder syncs only with an Epicenter server, hosted or self-hosted; [ADR-0794](0794-a-sync-round-asks-its-host-to-settle-checks-out-only-what-did-not-move-and-retries-rather-than-guess.md) at the store-to-store prototype: it is `sync(local, remote, manifest)` over the store contract.
- **Relates:** [ADR-0802](0802-people-share-spaces-an-app-works-in-one-at-a-time-and-a-folder-carries-its-contract.md) (the lean on a plain folder), [ADR-0795](0795-git-merges-a-notes-body-and-epicenter-merges-its-front-matter-by-key.md) to [ADR-0798](0798-a-store-patches-fields-and-writes-text-and-a-change-is-data.md) (merge, grammar, patch, write), [ADR-0751](0751-every-native-app-carries-one-sync-core.md) (the Rust core this would replace), [ADR-0786](0786-every-web-app-is-online-and-browser-storage-leaves-the-platform.md) (the web already syncs a replica with the server).
- **Amended by:** [ADR-0824](0824-a-folders-history-is-a-log-of-versions-and-git-is-how-it-leaves.md) at cloning a folder's repository and pushing to it: there is no Git remote; history leaves by `epicenter export --git`.
- **Unbuilt:** all of it: the front-matter primitive in TypeScript with its fixture; `sync(local, remote, manifest)` and `.epicenter/synced.json`; the server reading a file at a commit; the prototype's scenarios and timings; and, if the prototype confirms the plain folder, everything ADR-0802's lean then replaces.

## Context

ADR-0802 leans toward a plain folder: files on a computer, Git history on the
server. A client that keeps no repository needs no Git transport, so it can
sync with a Git host only through a Git client it would not otherwise carry.
The web page already syncs a replica with the server through the store
contract, and the folder's stores already share that contract and its
conformance suite.

## Decision

**A folder syncs only with an Epicenter server**, hosted or self-hosted. The
server keeps each space's repositories in Git, so a person or an agent can
clone one and push to it; no client keeps or speaks Git to sync.

**Sync is one function of two stores and a manifest:**
`sync(local, remote, manifest)`. It lists both stores against the manifest
(the last commit and each file's version both sides agreed), reads what
changed, merges a file both sides changed by ADR-0795's rules, fetching the
base text from the remote at the manifest's commit, and applies the result
through `patch` and versioned `write` on each side. The same function syncs a
folder with the server, the web's memory with the server, and two memory
stores in a test.

**A folder keeps its manifest at `.epicenter/synced.json`**, beside its files,
so a copied or moved folder carries a manifest consistent with its contents.

## Consequences

- If the prototype confirms the plain folder, every surface syncs with the
  same TypeScript, and the client Git stack (the core, libgit2, the Node-API
  addon, Git LFS client code, the merge driver, credential helpers, and the
  reconciliation of foreign history) goes.
- A folder cannot sync with GitHub or GitLab; its history can be cloned from
  the Epicenter server to anywhere.
