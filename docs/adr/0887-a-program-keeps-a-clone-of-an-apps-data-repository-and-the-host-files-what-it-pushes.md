# 0887. A program keeps a clone of an app's data repository, and the host files what it pushes

- **Status:** Accepted (2026-11-13)
- **Date:** 2026-11-13
- **Amends:** [ADR-0883](0883-an-epicenter-is-its-git-repositories-and-serve-and-its-host-keeps-runs-and-guards-them.md) at "One writer: the host": a client proposes a change by a call or by pushing a clone's branch, and the host's filing of that branch is a write like an action's run. [ADR-0846](0846-epicenter-owns-no-infrastructure-and-each-repository-has-one-meeting-point.md) at its `incoming/<device>` merge, which returns as `clone/<name>` with a merge that never refuses (ADR-0888).
- **Amended by:** [ADR-0903](0903-the-home-is-a-computer-its-person-controls-owned-or-rented.md): "the host's token on a hosted Epicenter" is withdrawn; whoever may call the app's actions on the home may clone and push.
- **Relates:** [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (filing is a writer under the app's lock), [ADR-0851](0851-an-app-has-one-home-and-an-optional-push-only-backup.md) (the backup, which this does not change), [ADR-0877](0877-an-apps-code-and-its-data-are-two-repositories-and-sharing-an-app-shares-its-code.md) (the data repository), [ADR-0888](0888-the-host-merges-with-gits-line-merge-and-a-file-it-cannot-merge-takes-the-later-side-whole.md) (the merge), [ADR-0889](0889-an-app-runs-on-epicenter-a-program-works-with-it-and-they-meet-at-the-apps-contract.md) (programs), [ADR-0890](0890-a-programs-folder-is-its-own-and-holds-only-what-its-apps-contract-declares.md) (a program's folder), [ADR-0893](0893-a-records-path-is-its-path-in-the-apps-data-repository.md) (one path per record).
- **Unbuilt:** all of it: `serve`'s Git route at `/<app>.git`, filing a pushed branch, the status line for a branch not filed, `undo` of a filing, and Whispering's connect.

## Context

The bridge between a program on another device and an Epicenter has been
decided three ways. ADR-0846 had a clone push to `incoming/<device>` and the
host merge it with `git merge-tree`, refusing any conflict. ADR-0864 had
Whispering keep a copy that pulled and pushed over SSH, with a
`push-to-checkout` hook on the Studio and conflicts resolved on the device.
ADR-0851 then removed copies: a program would send its data through an
action, with "a possible later offline outbox", and that path was never built.

What decides it: **a program whose own work must go on while the Epicenter is
unreachable needs the files, so it needs a clone; and a clone that can change
needs one place where changes meet.** Whispering records with no network. A
queue of calls would be a second data path inside the program (its own files
for its recordings, calls for everything else), with a queue format, replay,
and a way to learn what changed on the host. Git is already that queue.
git-annex keeps the same shape: each repository pushes to its own
`synced/<branch>` and merging happens where they meet.

## Decision

**A program that must work offline keeps a clone of an app's data
repository. It commits what it writes, pushes to a branch only it writes, and
fast-forwards to what the host files. Only the host merges.**

```txt
host: ~/Epicenter/apps/whispering/data/      laptop: ~/Whispering/
  main                   ← the host alone       main  ← fast-forwards to the host's
  clone/laptop-k3x9      ← that clone alone     a commit per recording
```

- **The door is `serve`.** `serve` answers Git's smart HTTP protocol for an
  app's data repository at `<address>/<app>.git` by running stock
  `git http-backend`. Whoever may call the app's actions may clone and push:
  the tailnet on the owner's server, the host's token on a hosted Epicenter
  (ADR-0883). `serve` sets `receive.hideRefs` to `refs/` and
  `!refs/heads/clone/` in each data repository when it starts, so the guard
  survives a rebuild from backup, and Git itself refuses a push to `main` or
  any other ref.
- **A clone's branch is `clone/<device>-<id>`,** where `<id>` is random and
  generated at connect, such as `clone/laptop-k3x9`. A clone pushes without
  force: after it fast-forwards to the host's `main`, every new commit
  descends from what it pushed before.
- **Connecting starts from the host's `main`.** A folder that already holds
  files becomes one commit on top of it, so the host's `.gitignore` and
  `.gitattributes` apply before anything is committed:

  ```sh
  git init -q -b main
  git remote add epicenter http://studio:4747/whispering.git
  git fetch -q epicenter && git reset -q epicenter/main
  git ls-files --deleted -z | xargs -0 git restore --
  git add -A && git commit -qm 'whispering: connected laptop-k3x9'
  git push -q epicenter HEAD:refs/heads/clone/laptop-k3x9
  ```

  A file the folder and the host both hold keeps the folder's version, the
  host's stays in history, and the program adds a `Replaced:` trailer for
  each to the connect commit with `git commit --trailer` (ADR-0888), one-file collections such as a settings record
  included. Connecting needs `git` installed on the device.
- **The host files a pushed branch at once, under the app's lock** (ADR-0850).
  It snapshots pending edits on the host, merges by ADR-0888, writes one merge
  commit with `main` as its first parent and the clone's tip as its second,
  named `whispering: filed 3 commits from laptop-k3x9`, and lands it with
  `git merge --ff-only`. The folder never holds a merge in progress.
- **The clone fast-forwards** with `git fetch` and `git merge --ff-only`
  against the host's `main`. If it committed again before the host filed its
  push, the fast-forward is refused, and it pushes again.
- **A branch the host could not file stays.** `epicenter <app>` shows
  `clone/laptop-k3x9: 3 commits not filed: <reason>`, and `serve` retries on
  its clock and when it starts. `main` is untouched by a failed filing.
- **`epicenter undo` reverts a filing whole,** to its first parent; the
  clone's commits stay on its branch and in history, and the clone's next
  fast-forward removes those files from the device too.
- **A filing commit carries no `Code-Commit` trailer** (ADR-0850): it runs no
  app code.
- **Only data repositories have clones.** An app's code repository keeps one
  writer, the host (ADR-0883).

## Consequences

- No outbox, replay protocol, or upload API. An offline program commits, and
  its commits wait in the clone; its count of unsent changes is
  `git rev-list --count epicenter/main..HEAD`.
- A program's data code is the same alone and connected. Connecting adds Git
  beside the program; disconnecting is `git remote remove epicenter`.
- A pushed file skips the app's actions, as a hand edit on the host does. A
  rule only an action enforces is not enforced for a push; reads report a
  file that does not fit.
- Every clone is a backup of the text it holds. A branch not yet filed is
  not in the app's backup, which `sync` pushes from `main` only; it is still
  on the device that pushed it.
- The host's files change when a push is filed, as when a phone calls an
  action; an agent with an unsaved buffer on the host sees the file change.
- Audio travels in no clone yet: until `serve` answers Git LFS, a program
  names audio `<id>.local.<ext>` (ADR-0870), and the device's own backup keeps
  it.
- The host needs Git 2.43 or later, for `git merge-tree -X`.
- `serve` grows one route that proxies `git http-backend`: about 20 lines in a
  prototype that cloned and pushed (scratch, 2026-11-13).

## Considered alternatives

- **Calls, with an outbox for offline work (ADR-0851).** A queue format,
  replay, a cursor for what changed on the host, and a second data path in
  the program.
- **A copy over SSH with a `push-to-checkout` hook (ADR-0864).** A second door
  with its own guard, which phones and hosted containers lack, and conflicts
  resolved on each device, so every program ships a merge.
- **Merge on the device, then push `main`.** Two places run the merge and must
  agree, and a merge driver's command lives in `.git/config`, which a clone
  does not carry.
- **Connect by pushing the folder's own history, merged with unrelated
  histories allowed.** Commits files the host's `.gitignore` would exclude,
  and needs a rule for files both sides created.
- **Force-push a branch per device.** A restored device would erase commits
  the host has not filed.
- **Refuse a push that conflicts (ADR-0846).** The person at the device can do
  nothing about a clash with an edit they cannot see.
- **GitHub as the place clones meet, which the host pulls from.** A timer or
  webhook before the host sees a push, and a second service in the path.
- **The Git route at `/.git/<app>`, beside `serve`'s other own paths.**
  Proxies and security tools commonly block paths starting with `/.git/`.
