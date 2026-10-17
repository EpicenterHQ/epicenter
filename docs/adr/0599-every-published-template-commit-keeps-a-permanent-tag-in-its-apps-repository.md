# 0599. Every published template commit keeps a permanent tag in its app's repository

- **Status:** Accepted
- **Date:** 2026-10-17
- **Amends:** [ADR-0589](0589-an-app-is-one-git-repository-of-built-files-at-an-address.md) at the `template` branch as the only ref that holds template commits: each template commit an approved build can name keeps a tag, so an older approved build can still start a folder.
- **Unbuilt:** all of it: the tags, the publisher's push of them, and the installer's fetch of them.

## Context

An approved built commit names its template by `template-commit`, the full
hash of a `template` branch commit, and a folder's first commit is that
template commit (ADR-0585, ADR-0589). The branch is the only ref that holds
it. When a publisher rewrites `template`, an older approved build names a
commit no ref reaches: a fresh clone does not fetch it, and the host may
collect it. A person still on that approved build cannot start a new
folder.

## Decision

**Publishing tags every template commit it names, and nothing moves or
deletes the tag.** CI and `epicenter app publish` push
`refs/tags/template/<full hash>` pointing at the template commit before
they push the built commit that names it. The installer's clone fetches
tags (ADR-0597), so every template commit an approved build names is in
the clone when the person makes a folder.

## Consequences

- A rewrite of `template` changes what new builds name and leaves every
  older build able to start a folder.
- An app's repository gains one tag per published template commit, kept
  for the life of the repository.
- A publisher who deletes a tag by hand breaks folder creation for every
  build that names its commit; nothing in Epicenter recreates it.

## Considered alternatives

- **Forbid rewriting `template`.** A rule Epicenter cannot enforce on a
  repository it does not host.
- **Ship the template's objects in every built commit.** ADR-0589 does this
  for the browser; the desktop would carry a second copy of history the
  clone can fetch.
