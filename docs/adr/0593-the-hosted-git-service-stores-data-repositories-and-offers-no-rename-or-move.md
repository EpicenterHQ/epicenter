# 0593. Hosted repositories have stable addresses

- **Status:** Accepted
- **Date:** 2026-10-17
- **Amends:** [ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md) at `repository_alias`, renaming or moving a repository with an alias, and the consequence that moving or renaming keeps every clone working: there is no rename, move, or alias. [ADR-0547](0547-every-repository-has-one-owner-namespace-and-a-person-is-a-namespace-of-one.md) at "Sharing a folder is moving it into a group" and the `manage` role's rename and move: neither is offered; share-by-move is reopened only if it becomes product work.
- **Amended by:** [ADR-0594](0594-a-hosted-repository-is-reached-only-by-the-person-who-owns-it.md) at "stores data repositories and nothing else": the service accepts any Git content a person pushes, and Epicenter offers no app hosting. [ADR-0608](0608-apps-never-talk-to-each-other-they-share-paths.md) at the consequence "renaming the folder on disk changes nothing remote": no local rename is offered either, and a folder's directory name is its repository's name on every device.
- **Amended by:** [ADR-0612](0612-a-repository-is-shared-by-the-people-on-its-access-list.md) at "offers no rename": a repository's name changes freely, and nothing moves.
- **Unbuilt:** the ID-based hosted route and removal of namespace-name aliases under ADR-0612.

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

**A hosted repository has a stable ID and a changeable display name.**
Its address is https://git.epicenter.so/<id>.git under ADR-0612. Names are
non-unique labels. Renaming a label changes no clone, grant, or remote URL.
A local clone can live in a directory of any name.

**The Git service stores ordinary Git content without serving it as an app.**
Data repository and app repository describe contents, not server-enforced
repository types. Membership guards access. The service does not install,
build, or execute the code a person pushes.

## Consequences

- Namespace/name routing and aliases are replaced by the stable ID route.
- Moving between naming namespaces is unnecessary because there is no
  second namespace registry. A label change requires no data move.
- Storage limits and fast-forward rules remain independent of file meaning.
