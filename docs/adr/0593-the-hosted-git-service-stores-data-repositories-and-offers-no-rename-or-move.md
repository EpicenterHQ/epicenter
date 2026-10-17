# 0593. The hosted Git service stores data repositories and offers no rename or move

- **Status:** Accepted
- **Date:** 2026-10-17
- **Amends:** [ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md) at `repository_alias`, renaming or moving a repository with an alias, and the consequence that moving or renaming keeps every clone working: there is no rename, move, or alias. [ADR-0547](0547-every-repository-has-one-owner-namespace-and-a-person-is-a-namespace-of-one.md) at "Sharing a folder is moving it into a group" and the `manage` role's rename and move: neither is offered; share-by-move is reopened only if it becomes product work.
- **Amended by:** [ADR-0594](0594-a-hosted-repository-is-reached-only-by-the-person-who-owns-it.md) at "stores data repositories and nothing else": the service accepts any Git content a person pushes, and Epicenter offers no app hosting.
- **Unbuilt:** the deletions below and the migration that drops `repository_alias`.

## Context

The hosted Git service renames and moves repositories and leaves an alias
for the old name (`renameRepository` and `moveRepository`,
`packages/server/src/repositories.ts:309`, `:327`; `repository_alias`,
`packages/server/src/db/schema/repository.ts:51`; the alias branch of the
access query, `packages/server/src/auth/resource-access.ts:157-166`). Its
promise is that every existing clone keeps working (ADR-0546). No product
feature calls rename or move; "Share…" into a group is unbuilt (ADR-0547).

The service resolves nothing about apps: an app is a repository at its own
address (ADR-0589), and `packages/server/src/routes/git.ts` serves only
`<namespace>/<name>` data repositories.

## Decision

**The hosted Git service stores data repositories and nothing else, and
offers no rename, move, or alias.** Deleted: `renameRepository` and
`moveRepository` in `packages/server/src/repositories.ts`,
`repository_alias` and its relation in
`packages/server/src/db/schema/repository.ts`, the alias branch of the
access query in `packages/server/src/auth/resource-access.ts`, and one
migration that drops the alias table. A person who wants another name
pushes the folder to a new repository and deletes the old one.

## Consequences

- A folder's hosted repository keeps its name for life; renaming the folder
  on disk changes nothing remote.
- Sharing a folder with a group waits until it is product work.
- Every Git request's access query loses its alias union.

## Considered alternatives

- **Delete aliases but keep rename and move.** An old clone would push to
  the old name, and the first push to a name nobody holds creates a
  repository (`packages/server/src/routes/git.ts:362-370`): a second
  repository, silently.
- **Rename and move with an HTTP redirect instead of an alias.** The same
  first-push creation answers an old clone's push before any redirect.
- **Keep rename and move with aliases.** The alias exists only so an old
  clone keeps working, and it holds a name until a new repository claims
  it; with no product feature that moves repositories, it is a promise with
  no caller.
