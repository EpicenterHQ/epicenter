# 0851. An app has one home and an optional push-only backup

- **Status:** Proposed
- **Date:** 2026-11-08 (revised 2026-11-11: one home replaces copies meeting at `origin`)
- **Supersedes:** [ADR-0862](0862-notes-merge-field-by-field-and-every-conflict-is-listed-for-repair.md): one home makes merging notes between computers unnecessary.
- **Amends:** [ADR-0842](0842-an-action-is-a-commit-and-the-repository-is-the-sync.md) at `epicenter sync`: it snapshots pending changes and pushes, without pulling or rebasing.
- **Relates:** [ADR-0849](0849-your-server-is-one-always-reachable-computer-that-runs-named-actions.md) (reaching the home), [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (snapshots), [ADR-0852](0852-an-app-is-a-folder-with-a-declared-shape-and-each-job-takes-the-least-powerful-form.md) (`origin`), [ADR-0864](0864-epicenter-is-a-data-server-for-repositories-of-files-and-code-runs-where-its-owner-trusts-it.md) (one copy).
- **Built:** `epicenter sync` (`packages/cli/src/sync.ts`) and `serve`'s backup clock (`packages/cli/src/http.ts`). 2026-11-11: an app's status saying `not backed up` (no `origin`) or `never backed up` (an `origin` that has not received the branch), with the step that settles it, and `epicenter new` saying so (`packages/cli/src/snapshot.ts`, `listing.ts`, `new.ts`).
- **Unbuilt:** access to home actions from programs on other devices, such as Whispering.
- **Unbuilt:** two repositories per app, each with its own private `origin` that `sync` and the clock push ([ADR-0877](0877-an-apps-code-and-its-data-are-two-repositories-and-sharing-an-app-shares-its-code.md)).

## Context

Earlier designs let two computers edit copies of one app when they could not
reach each other. Each copy pulled from a meeting point and merged changes.
That design required network fetches, could change files under an open editor,
and needed a way to merge notes. An Epicenter now lives on one home computer.
Other devices reach its apps through actions. The home keeps Git history as
snapshots of pending changes; runs do not commit (ADR-0850).

## Decision

**An Epicenter lives on one home computer.** Its app folders and their Git
history live there. A phone, browser, agent, another computer, or a program
such as Whispering on another device calls the home's actions to read or
change them. A program on the home may write the folder directly.

Each app's optional `origin` is a backup that the home pushes to. It can be
GitHub, GitLab, another Git host, SSH, or a disk. Normal use never pulls from
it. An app without a remote still runs and keeps local snapshots.

`epicenter sync [<app>]` snapshots pending changes, then, when the app has
that remote, pushes to `origin` with `git push origin HEAD:<branch>` if the
branch is ahead of its `origin` tracking ref or has none yet. It does not
fetch, pull, rebase, or autostash, and it never force pushes. `epicenter serve`
does the same for every app when it starts, every 5 minutes, and when it stops
(ADR-0850). No other command touches `origin`: `epicenter undo` commits, and
the next sync pushes it.
`epicenter update` still fetches `upstream`, the
starter; `upstream` is separate from the backup and receives no pushes.

If the backup has commits the home lacks, a non-fast-forward push leaves the
backup untouched and the home's snapshot intact. `sync` says that the backup
at `origin` has changes this computer does not and was not overwritten, gives
a next step (fetch and inspect those commits, for example with
`git -C <app> fetch origin` and `git -C <app> log HEAD..origin/<branch>`), and
exits 1 for that app; other apps continue. `serve`'s clock logs the same
message on stderr, once until it changes. Nothing stores the failure: the app's status
derives what is pending from `git status` and how many snapshots the backup
lacks from `origin/<branch>..HEAD`, so it stays true however the problem is
fixed. That count reads the last fetched `origin/<branch>`, which `sync` does
not refresh.

**Every app should have a backup, and Epicenter says when one does not.** A
backup is optional to run an app and expected to keep one. An app's status
names a missing backup in two cases:

| The app | Status says | Next step |
| --- | --- | --- |
| has no `origin` | `not backed up` | `git -C <folder> remote add origin <url>`, then `epicenter sync <app>` |
| has an `origin` but no `origin/<branch>`: never pushed | `never backed up` | `epicenter sync <app>` |

The listing (`epicenter`) marks such an app, and `epicenter <app>` shows the
line above its actions. `epicenter new` ends its stderr with the same line, so
an app is never born silently without a backup. Epicenter creates no
repositories on a host: the person picks where the backup lives (a private
GitHub repository, for example with `gh repo create <name> --private`, or a
bare repository on a disk or another computer). Apps that hold mail or a
journal may prefer the latter.

To restore an app, clone its backup onto a computer and make that computer
the home. A program on another device sends its data to the home through an
action; this path for Whispering is not built yet. Binary files the app tracks
use Git LFS. Epicenter adds no encryption; anyone with access to the backup
can read its history.

## Consequences

- The home owns the only working copy used in normal operation. A refused
  push does not merge remote commits into that copy or overwrite the backup.
- A remote is optional to run. Without one, `sync` makes a local snapshot,
  and the app's status says `not backed up` until it has one.
- The backup holds what Git holds. `.local` files (ADR-0870) and the
  Epicenter's own `EPICENTER.md` and `AGENTS.md` are in no repository; the
  computer's own backup keeps them.
- A device that cannot reach the home cannot change its apps through actions.
  A possible later offline outbox would queue action calls and replay them
  when the home is reachable.

## Considered alternatives

- **A Git remote where copies meet.** The earlier design gave the server's
  app a GitHub backup and let a program such as Whispering keep a copy whose
  `origin` pointed to the server over SSH. `sync` committed pending changes,
  pulled with `--rebase --autostash` on the copy, and pushed. A
  `push-to-checkout` hook updated the server's working tree. That served
  editing one Epicenter on two computers that could not reach each other.
  One home removes that need and avoids unattended changes to its working
  tree. The proposed field merge in ADR-0862 is unnecessary for the same
  reason.
- **Pull before every run.** A remote fetch delays each action and can merge
  into the folder a person is editing on the home.
- **GitHub as a meeting point that the home pulls from.** A timer or webhook
  would delay when the home sees a push, and the home would merge unattended.
- **Cloudflare Artifacts as every copy's meeting point.** That needs a copy
  on every device.
- **An end-to-end encrypted remote.** It needs key management or re-uploads
  history, and it rules out hosted runs.
- **Push after every commit the runner makes.** Runs no longer commit; a
  slow push also should not delay an action's answer.
- **Git and editors without `epicenter sync`.** The home needs one command
  to snapshot edits made outside an action and push the backup.
- **`sync` as an MCP tool.** `serve` snapshots and pushes after writes, while
  the terminal command handles pending edits made directly in the folder.
