# 0884. An Epicenter is a repository that lists the repositories inside it, and `init --from` rebuilds it

- **Status:** Accepted
- **Date:** 2026-11-12
- **Relates:** [ADR-0883](0883-an-epicenter-is-its-git-repositories-and-serve-and-its-host-keeps-runs-and-guards-them.md) (every file is in Git, a cache, or a renewable credential; a host rebuilds the folder when it is missing), [ADR-0877](0877-an-apps-code-and-its-data-are-two-repositories-and-sharing-an-app-shares-its-code.md) (an app's two repositories), [ADR-0851](0851-an-app-has-one-home-and-an-optional-push-only-backup.md) (a push-only backup), [ADR-0868](0868-an-epicenter-is-any-folder-that-says-it-is-one-and-a-computer-runs-as-many-as-it-has.md) (`EPICENTER.md`), [ADR-0870](0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md) (`.local` files).

## Context

ADR-0883 says every file in an Epicenter is in Git, a cache, or a credential
the person renews, and that a host rebuilds the folder from Git when it is
missing. Neither was true. On the owner's Studio, on 2026-11-12, each app's
code and data were repositories with origins, but `EPICENTER.md`, `AGENTS.md`,
and `Zhongwen/`, a folder that is not an app, were in no repository, and
Time Machine was not set up: an agent's mistake there had no undo, and a lost
disk lost them. Nothing recorded which repositories made up the Epicenter, and
nothing rebuilt one.

The risk is the disk, not shutdown: a restart keeps every file, while an
agent's deletion, a failed drive, or a new Mac does not.

## Decision

**The Epicenter's folder is a repository of its own. It tracks everything that
is not in a repository inside it, lists those repositories with their origins
in `repositories.json`, and `epicenter init --from <its origin>` rebuilds the
Epicenter from that list.**

```txt
~/Epicenter/              the Epicenter's repository
  EPICENTER.md AGENTS.md  tracked
  Zhongwen/               tracked: not an app, and it need not become one
  repositories.json       { "vocab": "<origin>", "vocab/data": "<origin>", "notes": null }
  .gitignore              *.local, *.local.*, node_modules/, .DS_Store, then
                          /vocab/ in lines epicenter rewrites
  vocab/                  a repository of its own: listed, never tracked
```

- **One walk writes the list and the ignore lines.** Before each snapshot,
  `epicenter` finds every folder inside with a `.git`, without following a
  link or entering `node_modules`, lists each with its `origin`, and ignores
  each that no other one holds. So the two cannot disagree, and the list is
  current after every backup. A repository with no origin is listed as `null`.
- **A repository inside is never committed as one.** Git records a nested
  repository it is asked to add as a link a clone cannot fill in. The snapshot
  refuses while the index holds one, with `git rm --cached` as the step, and
  while one appears unignored.
- **The list holds no credentials.** An http(s) origin loses a user and
  password written into its URL; an SSH user stays.
- **It is backed up as an app is.** `serve`'s clock syncs it after the apps,
  as `<Epicenter>: changed outside epicenter`, and `epicenter sync` with no app
  named does too. It pushes to its own `origin` and never pulls (ADR-0851).
- **`init` makes it.** A new Epicenter starts as a repository with its first
  commit, `<Epicenter>: start the Epicenter`. Where `git-lfs` is installed, its
  `.gitattributes` routes the binaries an app's starter does through LFS.
- **`init --from <url> [<folder>]` rebuilds.** The folder must be missing or
  empty. It clones the Epicenter's repository, then each listed repository
  into its place, parents first, leaving one already there as it is; then it
  installs each app. It reports repositories listed with no origin, and that
  `.local` files stay on the computer that made them.

## Consequences

- `Zhongwen/` and `AGENTS.md` gain history, an undo through Git, and a backup,
  without becoming apps.
- A restore is tested end to end: an Epicenter backed up to bare repositories
  and rebuilt in an empty folder matches file for file, without its `.local`
  files.
- Whatever lands in the folder is committed on the next tick, as an app's data
  is. A large file that is not routed through LFS goes into Git whole.
- An Epicenter made before this is not a repository until its owner runs
  `git init` there and adds an origin; the clock skips it until then.
- The list is visible, and its file is the Epicenter's own; a person edits
  neither it nor the marked `.gitignore` lines.

## Considered alternatives

- **The list in `EPICENTER.md`.** A person edits the marker; the clock would
  rewrite a file someone may be editing.
- **Git submodules.** They pin each repository to one commit, so every backup
  of an app would change the Epicenter's repository.
- **Ignore every folder and track only named files.** A new folder would have
  no backup until someone named it, which the invariant refuses.
- **A separate `restore` command.** `init` already makes an Epicenter, and
  `new --from` already means "start from a repository".
