# 0851. An app has one home and an optional push-only backup

- **Status:** Proposed
- **Date:** 2026-11-08 (revised 2026-11-11: one home replaces copies meeting at `origin`)
- **Amends:** [ADR-0842](0842-an-action-is-a-commit-and-the-repository-is-the-sync.md) at `epicenter sync`: it snapshots pending changes and pushes, without pulling or rebasing.
- **Relates:** [ADR-0861](0861-whats-yours-is-everywhere-and-everything-else-is-used-where-it-is.md) (access from other devices), [ADR-0849](0849-your-server-is-one-always-reachable-computer-that-runs-named-actions.md) (reaching the home), [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (snapshots), [ADR-0852](0852-an-app-is-a-folder-with-a-declared-shape-and-each-job-takes-the-least-powerful-form.md) (`origin`).
- **Unbuilt:** The one-home sync behavior and access to home actions from other devices. The earlier fetch after a refused push and ahead/behind listing are to be removed.

## Context

Earlier designs gave each computer a copy of an app. The computers met at a
Git remote, pulled each other's changes, and merged notes. That arrangement
served editing one Epicenter on two computers that could not reach each other.
It also made a routine action depend on a network fetch and could change files
under an open editor. An app now lives on one home computer. Other devices and
programs reach that home through its actions.

Runs do not commit. History consists of snapshots of pending changes. The home
makes a snapshot before `epicenter sync` pushes.

## Decision

**An Epicenter lives on one home computer.** Its app folders and their history
live there. A phone, browser, agent, another computer, or a program such as
Whispering on another device calls the home's actions to read or change them.
A program on the home may write the folder directly.

**An app's `origin` is an optional backup.** It may be any Git remote: GitHub,
GitLab, SSH, or a disk. The home pushes to it. Normal use never pulls from it.
An app without `origin` still has local history.

**`epicenter sync <app>` makes a snapshot, then pushes** with
`git push origin HEAD:<branch>`. It does not fetch, rebase, or autostash. It
never forces a push. With no remote, sync only makes the snapshot. `serve` may
also push after a snapshot; it follows the same refusal rule.

**A refused push does not overwrite the backup.** If `origin` has commits the
home lacks, the app's status says that the backup has changes this computer
does not and was not overwritten. It gives a next step to fetch and inspect
them, for example `git -C <app> fetch origin` and
`git -C <app> log HEAD..origin/<branch>`. Background pushes through `serve`
report the same failure and keep logging it on stderr. The home does not merge
the backup automatically.

**`epicenter update` still fetches `upstream`.** That remote supplies the app's
starter. It is distinct from the `origin` backup.

## Consequences

- Restore an app by cloning its backup on a computer and making that computer
  its home. That computer then serves the app's actions.
- A phone or another computer needs a route to the home to use its actions.
  An offline outbox that queues calls for replay when the home is reachable
  is a possible later design.
- A refused push leaves both the home and backup intact until someone inspects
  their histories and resolves the difference.
- An app with no remote has snapshots on its home and no remote backup.

## Considered alternatives

- **`origin` as a meeting point and backup for several working copies.** Each
  computer would commit, pull with `--rebase --autostash`, merge notes, and push.
  This served editing one Epicenter on computers that could not reach each
  other. One home removes that need and avoids merges into an active folder.
- **Pull before every run.** This fetched on every call and could change the
  folder while a person was editing it.
- **Your server as a meeting point with a separate backup.** This pushed into
  a folder someone might be editing and required two remotes per app.
- **An end-to-end encrypted remote.** This needs key management and complicates
  restoring a home.
