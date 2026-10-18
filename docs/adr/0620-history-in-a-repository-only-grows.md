# 0620. History in a repository only grows

- **Status:** Accepted
- **Date:** 2026-10-19
- **Supersedes:** [ADR-0595](0595-the-self-hosted-git-store-accepts-a-force-push.md) (the self-hosted Git store accepts a push that is not a fast-forward): no store accepts a force push.
- **Amends:** [ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md) at "unrelated history is refused as not a fast-forward, so a second folder cannot land in a repository by taking its name", as ADR-0595 amended it: the Git service refuses every push that is not a fast-forward, forced or not; [ADR-0592](0592-a-folders-gitignore-decides-what-stays-on-one-machine.md) at "repairing it means rewriting history in Git, by a person or an agent": a repair is a revert, and a rewritten history is a new repository.
- **Relates:** [ADR-0612](0612-a-repository-is-shared-by-the-people-on-its-access-list.md) (a repository's id never changes), [ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md) (a grant names one repository).
- **Unbuilt:** the refusal on the hosted service: whether Cloudflare Artifacts refuses a forced push that is not a fast-forward is not verified, and where the hosted service enforces the refusal (Artifacts or the Worker in `apps/api/worker/git-repositories.ts`) is not decided; and pushing a rewritten history to a new repository. The disk store already refuses one (`safety` in `packages/server/src/git-disk-store.ts`).

## Context

The disk store runs every `git` with `receive.denyNonFastForwards=true` and
`receive.denyDeletes=true` (`packages/server/src/git-disk-store.ts`), and
its test "unrelated history to an existing name is refused, even forced"
(`packages/server/src/routes/git.postgres.test.ts`) expects a
`git push --force` to fail.
[ADR-0595](0595-the-self-hosted-git-store-accepts-a-force-push.md) decided
to drop the first flag so a person could repair a file committed by mistake
by rewriting history, the repair
[ADR-0592](0592-a-folders-gitignore-decides-what-stays-on-one-machine.md)
names. A forced push reaches only the server: every other clone still holds
the old commits, and its next sync merges them back unless that clone is
reset first.

## Decision

**History in a repository only grows.** The Git service refuses a push that
is not a fast-forward, forced or not, and refuses deleting a branch, on
Cloudflare Artifacts as on the disk store. `safety` keeps
`receive.denyNonFastForwards=true` and `receive.denyDeletes=true`.

**A repair is a revert.** A file committed by mistake is removed by a new
commit, and its bytes stay in history.

**A rewritten history is a new repository.** Purging bytes from history
means pushing the rewritten history to a new repository, which has a new id
([ADR-0612](0612-a-repository-is-shared-by-the-people-on-its-access-list.md)).
Every app then reconnects to the new repository, and every clone is cloned
again.

## Consequences

- No clone can push a branch that drops another clone's commits.
- Bytes committed by mistake stay readable to everyone on the access list
  until the history is rewritten into a new repository.
- A purge costs every grant and every clone: each app connects again, and
  each device clones again. A clone of the old repository cannot push the
  purged bytes back, because its remote names the old id.

## Considered alternatives

- **Accept a force push (ADR-0595).** Every other clone merges the old
  commits back on its next sync unless it is reset by hand, so the repair
  holds only if every device cooperates.
- **A rewrite on the server.** A second history editor, for a purge that a
  new repository performs with plain Git.
