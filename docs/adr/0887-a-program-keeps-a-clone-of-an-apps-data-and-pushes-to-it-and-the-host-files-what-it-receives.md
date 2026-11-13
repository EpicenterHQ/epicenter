# 0887. A program keeps a clone of an app's data and pushes to it, and the host files what it receives

- **Status:** Proposed
- **Date:** 2026-11-13
- **Amends:** [ADR-0883](0883-an-epicenter-is-its-git-repositories-and-serve-and-its-host-keeps-runs-and-guards-them.md) at "One writer: the host": a client proposes a change by a call or by pushing a clone's branch, and the host's filing of a push is a write like an action's run. [ADR-0846](0846-epicenter-owns-no-infrastructure-and-each-repository-has-one-meeting-point.md) at its `incoming/<device>` merge, which returns as `clone/<name>` with a merge that never refuses (ADR-0888).
- **Relates:** [ADR-0851](0851-an-app-has-one-home-and-an-optional-push-only-backup.md) (the backup, which this does not change), [ADR-0864](0864-epicenter-is-a-data-server-for-repositories-of-files-and-code-runs-where-its-owner-trusts-it.md) (clients that ask), [ADR-0877](0877-an-apps-code-and-its-data-are-two-repositories-and-sharing-an-app-shares-its-code.md) (the data repository), [ADR-0888](0888-when-a-push-and-the-host-change-the-same-thing-the-later-edit-stays-and-the-other-stays-in-history.md) (the merge), [ADR-0889](0889-an-app-and-a-program-meet-at-the-apps-contract-and-a-programs-starter-lives-beside-it.md) (programs).
- **Unbuilt:** all of it: `serve`'s Git route at `/.git/<app>`, filing a pushed branch, the status line for a branch not filed, and Whispering's connect.

## Context

The bridge between a program on another device and an Epicenter has been
decided three ways. ADR-0846 had a clone push to `incoming/<device>` and the
host merge it with `git merge-tree`, refusing any conflict. ADR-0864 had
Whispering keep a copy that pulled and pushed over SSH, with a
`push-to-checkout` hook on the Studio and conflicts resolved on the device.
ADR-0851 then removed copies: a program would send its data through an action,
with "a possible later offline outbox", and that path was never built.

The question kept reopening because no record named what decides it. This
does: **a program whose own work must go on while the Epicenter is
unreachable needs the files, so it needs a clone; and a clone that can change
needs one place where changes meet.** Whispering records with no network.
A queue of calls would be a second data path inside the program (local files
for its own recordings, calls for everything else), plus a queue format,
idempotent replay, and a way to learn what changed on the host. Git already is
that queue.

## Decision

**A program that must work offline keeps a clone of an app's data repository.
It commits what it writes and pushes to its own branch on the host, and the
host files that branch into `main`. The clone never merges.**

```txt
host: ~/Epicenter/apps/whispering/data/          laptop: ~/Whispering/
  main            ← only the host writes it        main  (fast-forwards to the host's)
  clone/laptop-whispering  ← only that clone       a commit per recording
                             pushes it
```

- **The door is `serve`.** `serve` answers Git's smart HTTP protocol for an
  app's data repository at `<address>/.git/<app>`, by running stock
  `git http-backend`. Its own paths start with `.`, which no app name can
  (ADR-0864). Whoever may call the app's actions may clone and push: the
  tailnet on the owner's server, and on a hosted Epicenter the token its host
  checks (ADR-0883).
- **A clone pushes only `refs/heads/clone/<name>`.** `<name>` is chosen when
  the program connects and names the device and the program, such as
  `laptop-whispering`. `serve` refuses a push to any other ref, `main`
  included. A clone pushes `+HEAD:refs/heads/clone/<name>`: the branch is that
  clone's alone, so replacing it loses nothing the host has filed.
- **The host files a pushed branch at once, under the app's lock.** It first
  snapshots pending edits on the host (ADR-0850). Then it runs
  `git merge-tree --write-tree --allow-unrelated-histories main clone/<name>`
  with the merge of ADR-0888, writes a commit with both parents named
  `<app>: filed <n> commits from <name>`, moves `main` only if it has not
  moved since, and updates the working tree. The folder never holds a merge in
  progress.
- **The clone fast-forwards.** After a push, the clone runs
  `git fetch` and `git merge --ff-only` against the host's `main`. If it
  committed again before the host filed its push, the fast-forward is refused,
  and it pushes again. No merge code runs on a device.
- **Connecting is the ordinary push.** The first push from a folder with its
  own history merges with unrelated histories allowed; ADR-0888 says what
  happens to a file both sides already have.
- **A branch the host could not file stays.** `epicenter <app>` shows
  `clone/<name>: <n> commits not filed: <reason>`, and `serve` files every
  unfiled clone branch when it starts. `main` is never touched by a failed
  filing.
- **Only data repositories have clones.** An app's code repository has one
  writer, the host, as ADR-0883 decided for agents changing code from
  elsewhere.

## Consequences

- No outbox, replay protocol, or file-upload API: a program that is offline
  commits, and its commits wait in the clone. Its count of unsent changes is
  `git rev-list --count <remote>/main..HEAD`.
- A program's data code is the same alone and connected. Connecting adds Git
  beside the program; disconnecting is removing the remote.
- A pushed file skips the app's actions, as a hand edit on the host does. A
  rule only an action enforces, such as a check across files, is not enforced
  for a push; reads report a file that does not fit.
- Every clone is a backup of the text it holds.
- The host's files change when a push is filed, as when a phone calls an
  action. An agent with an unsaved buffer on the host sees the file change
  under it.
- `serve` grows one route that proxies `git http-backend`: measured at about
  20 lines in a prototype that cloned and pushed (scratch, 2026-11-13). Audio
  waits for Git LFS's endpoints in `serve`, which are unbuilt.
- A connected program needs Git on its device, as a linked library or a
  downloaded `git`.

## Considered alternatives

- **Calls, with an outbox for offline work (ADR-0851).** A queue format,
  idempotent replay, a cursor for what changed on the host, and a byte path,
  and the program writes local files for its own recordings and calls for
  everything else.
- **A copy over SSH with a `push-to-checkout` hook (ADR-0864).** A second door
  with its own guard, which phones and hosted containers lack, and conflicts
  resolved on each device, so every program ships a merge.
- **Merge on the device, then push `main`.** Two places run the merge, so they
  must agree, and a merge driver's command lives in `.git/config`, which a
  clone does not carry.
- **Refuse a push that conflicts (ADR-0846).** The person at the device can
  do nothing about a conflict with an edit they cannot see.
- **GitHub as the place clones meet, which the host pulls from.** A timer or
  webhook before the host sees a push, and a second service in the path.
