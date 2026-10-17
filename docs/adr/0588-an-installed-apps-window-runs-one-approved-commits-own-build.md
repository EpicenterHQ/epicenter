# 0588. An installed app's window runs one approved commit's own build

- **Status:** Accepted
- **Date:** 2026-10-17
- **Amends:** [ADR-0540](0540-an-app-is-installed-by-building-its-source-and-approving-a-commit-trusts-it-fully.md) at "A commit made on this machine ... runs without asking" and at building in the clone, and [ADR-0561](0561-rust-serves-every-app-from-one-epicenter-app-origin.md) at the installed app's URL, which becomes `epicenter-app://localhost/apps/<app-id>/<commit>/` and is resolved from that commit, not from `builds/<app-id>/current`.
- **Amended by:** [ADR-0589](0589-an-app-is-one-git-repository-of-built-files-at-an-address.md) at building the approved commit on the machine, `builds/<app-id>/`, and `epicenter-app://localhost/apps/<app-id>/<commit>/`: the build moves to a publish step, and the paths and URL take the app's encoded address; a window still runs one approved commit's bytes.
- **Unbuilt:** removing a build no window runs; every earlier commit's directory stays in `builds/<app-id>/`.

## Context

[ADR-0540](0540-an-app-is-installed-by-building-its-source-and-approving-a-commit-trusts-it-fully.md)
let a commit made on this machine run without approval when every commit
since the approved one was unreachable from every remote-tracking ref and
from `FETCH_HEAD` (`mayRun` in `packages/cli/src/installed-apps.ts`). A
commit pulled from a URL that is not a remote passes that test once a later
fetch moves `FETCH_HEAD`, so code from elsewhere built unapproved.

The build ran in the clone, `Apps/<app-id>/`. `requireClean` ran
`git status --porcelain --untracked-files=no`, so an untracked file (a new
route) or an ignored one (`.env.local`) could enter
`builds/<app-id>/<commit>/` though `<commit>` does not contain it. A rebuild
of a commit moved its directory aside and replaced it.

[ADR-0561](0561-rust-serves-every-app-from-one-epicenter-app-origin.md)
served `/apps/<app-id>/` from whichever commit `builds/<app-id>/current`
named at each request. After an update a window could load its document from
one build and a chunk from the next, so the shell reloaded every window of
the app when `current` changed (`reload_installed_windows`), discarding page
state; an update run from a terminal reloaded nothing.

## Decision

**Every build a window runs was approved when it was built.** `inspect`
reports `needsApproval` for any `HEAD` that is not the commit
`approvals.json` names, including one a person or an agent committed in
`Apps/<app-id>/`, and only `settle` for an approved commit writes
`builds/<app-id>/current`. `open_installed_app` asks the CLI
(`epicenter app update --commit=<commit>`) before every open and opens only
the commit it answers ready. A window opened earlier keeps the build it
opened on, which was approved then and may since have been superseded.

**A build holds one commit's tree.** `build` checks the approved commit out
with `git --no-replace-objects worktree add --force --force --detach` into
`<cache_dir>/checkouts/<app-id>/`, with every filter driver the clone's
configuration names emptied and not required, so no smudge, clean, or
process command runs, and with `core.sparseCheckout=false`, so the clone's
sparse checkout does not narrow it. It runs `bun install --frozen-lockfile --ignore-scripts`
at the checkout's root and `bun run build:installed` in the app's folder,
copies `dist/` to a sibling of `builds/<app-id>/<commit>/`, renames it into
place, writes `builds/<app-id>/<commit>.built`, and removes the checkout with
`git worktree remove --force --force`. Nothing is built in the clone, and no other
worktree of the clone is pruned. The build's other inputs are the person's:
global and system Git configuration other than filters and hooks (such as
`core.autocrlf` and `eol` attributes), Bun's global package cache, global
`bunfig.toml` and `.npmrc`, the inherited environment, and module
resolution that walks above the checkout (`~/node_modules`).

**A window keeps the build it opened on.** Each build is served at its own
path, and a finished build is never replaced or removed:

```txt
epicenter-app://localhost/apps/<app-id>/<commit>/…   <cache_dir>/builds/<app-id>/<commit>/…
builds/<app-id>/<commit>.built                       the build at <commit>/ finished
builds/<app-id>/current                              the commit a newly opened window loads
```

The scheme serves a commit's directory only when neither it nor
`builds/<app-id>/` is a symbolic link, and names a commit only in the
lowercase hex Git prints. A window's navigation stays below
`/apps/<app-id>/<commit>/`, so its top-level page and the relative assets it
loads come from its own build. Navigation is not a fence for requests: every
app shares the one origin and is trusted fully
([ADR-0540](0540-an-app-is-installed-by-building-its-source-and-approving-a-commit-trusts-it-fully.md)),
so a page may still fetch another build's files.

The shell records the commit each installed app window opened on
(`InstalledWindowCommits` in `apps/epicenter/src-tauri/src/lib.rs`). Opening
an app whose window is already open on the folder reveals that window when
it opened on the requested commit, and otherwise leaves it and refuses with
"<title> is open on another version. Close its window, then open it
again." Building a commit whose directory carries its `.built` file makes
it current as it is; a directory without one, partly copied or left by
another pipeline, is built again once. `epicenter app remove` deletes the
clone and the approval and leaves `builds/<app-id>/` for windows still
running a build.

## Consequences

- Every local commit costs one approval before it runs, the same click as an
  update. Approval by local authorship can return with fork support, which
  would know which commits a person made.
- Every open runs one `epicenter app update --commit` before its window
  appears, which reads the clone and `approvals.json`. When that commit is
  already approved and current it answers without the build lock, so an
  open never waits on another app's build.
- Installed apps cannot use Git LFS: the checkout runs no LFS filter, so a
  file LFS tracks builds as its pointer.
- A `.built` file guards against a crash, not a power loss: nothing is
  synced to disk, so a power loss can leave the file beside a build whose
  files were lost. Deleting `builds/<app-id>/<commit>/` makes it build
  again.
- Each build runs `bun install` in a fresh checkout, so a build no longer
  reuses the clone's `node_modules`; Bun's global cache supplies the packages.
  The clone has no `node_modules` or `dist/`; it gains a
  `.git/worktrees/<app-id>/` entry only while a build runs.
- A newer build reaches a window only when the window is closed and opened
  again. Nothing reloads a page.
- A build directory is written once and kept, even after removal, so
  `builds/<app-id>/` grows by one directory per approved commit until
  cleanup is built.

## Considered alternatives

- **`git archive` of the commit instead of a worktree.** Skips files marked
  `export-ignore`, so the build would not be the commit, and streams the
  whole tree through one buffer.
- **Keep serving `/apps/<app-id>/` and reload windows on a new build.**
  Discards page state, and misses a build the shell did not start.
