# 0595. The self-hosted Git store accepts a force push

- **Status:** Superseded
- **Date:** 2026-10-17
- **Superseded by:** [ADR-0620](0620-history-in-a-repository-only-grows.md): no store accepts a force push.
- **Amends:** [ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md) at "unrelated history is refused as not a fast-forward, so a second folder cannot land in a repository by taking its name": the pushing Git client refuses a push that is not a fast-forward, and a forced push replaces the branch on the self-hosted store.
- **Relates:** [ADR-0592](0592-a-folders-gitignore-decides-what-stays-on-one-machine.md) (a file committed by mistake is repaired by rewriting history in Git, which reaches a remote only as a force push).
- **Unbuilt:** all of it: dropping `receive.denyNonFastForwards` from the disk store and inverting its test. Whether Cloudflare Artifacts accepts a force push is not verified; Epicenter does not promise that a hosted repository accepts one until a forced push to the deployed binding has replaced a branch.

Retired source files below use their last tracked Git snapshot (`commit:path`);
inspect one with `git show commit:path`.

## Context

The Bun entry's Git store runs every `git` with
`receive.denyNonFastForwards=true` and `receive.denyDeletes=true`
(`safety` in `packages/server/src/git-disk-store.ts:46-58`), "so unrelated
history to an existing name is refused here, whatever the client was told
to force" (`:11-14`). The test "unrelated history to an existing name is
refused, even forced" expects a `git push --force` to fail
(`packages/server/src/routes/git.postgres.test.ts:406-420`).

ADR-0592 leaves a file committed by mistake, such as a recording, to Git:
a person or an agent rewrites history and pushes it. With the store
refusing every non-fast-forward, that repair cannot reach the remote, and
the next Sync on any device brings the file back.

Epicenter's own sync never forces. The desktop pushes `<oid>:refs/heads/<branch>`
with no `+` (`c87a47f8783f:packages/folder/src/git/native-backend.ts:418-421`), and the
browser passes `force: false` to isomorphic-git, which refuses a
non-fast-forward before it sends the update
(`9d13dd25854e:packages/folder/src/git/browser-backend.ts`).

## Decision

**The self-hosted Git store accepts a push that is not a fast-forward.**
`safety` in `git-disk-store.ts` drops `receive.denyNonFastForwards=true`
and keeps `receive.denyDeletes=true`: rewriting a branch is the repair
ADR-0592 names, and deleting one is not. The test at
`routes/git.postgres.test.ts:406` keeps its plain push refused, which the
pushing client now decides, and expects the forced push to succeed and the
repository to hold the forced history.

**Epicenter states the same of its hosted service only after it is
verified on Cloudflare Artifacts.** Until then the hosted promise is
unstated, and a repair that needs a force push on the hosted service is
not offered.

## Consequences

- A person or an agent who rewrites a folder's history pushes it with
  `git push --force`. Every other device still holds the old commits, and
  its next Sync merges them with the rewritten branch and pushes the file
  back, unless that device is reset to the new branch or cloned again
  first. The repair is per device, and Epicenter does not coordinate it.
- A plain push of unrelated history to an existing name is still refused,
  by the pushing client. A forced one replaces the repository's branch, so
  Connect's protection against taking an existing name holds only because
  Connect never forces.
- The comment in `packages/server/src/routes/git.ts:36-37` that the store
  refuses unrelated history, and the store's header, change with it.

## Considered alternatives

- **Keep refusing non-fast-forwards and offer a server-side rewrite.** A
  second history editor on the server, for a repair Git already performs.
- **Allow branch deletion too.** No repair needs it, and deleting a
  repository is its own operation.
