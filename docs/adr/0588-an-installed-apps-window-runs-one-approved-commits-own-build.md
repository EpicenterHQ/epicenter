# 0588. An installed app's window runs one approved commit's own build

- **Status:** Accepted
- **Date:** 2026-10-17
- **Amends:** [ADR-0540](0540-an-app-is-installed-by-building-its-source-and-approving-a-commit-trusts-it-fully.md) at "A commit made on this machine ... runs without asking" and at building in the clone, and [ADR-0561](0561-rust-serves-every-app-from-one-epicenter-app-origin.md) at the installed app's URL, which becomes `epicenter-app://localhost/apps/<app-id>/<commit>/` and is resolved from that commit, not from `builds/<app-id>/current`.
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

**A commit runs only when `approvals.json` names it, wherever it was made.**
`inspect` reports `needsApproval` for any `HEAD` that is not the app's
approved commit, including one a person or an agent committed in
`Apps/<app-id>/`.

**A build holds one commit and nothing else.** `build` checks the approved
commit out with `git worktree add --detach` into
`<cache_dir>/checkouts/<app-id>/`, runs
`bun install --frozen-lockfile --ignore-scripts` at its root and
`bun run build:installed` in the app's folder, copies `dist/` to a sibling of
`builds/<app-id>/<commit>/`, renames it into place, and removes the checkout.
Nothing is built in the clone.

**A window keeps the build it opened on.** Each build is served at its own
path, and a commit's build directory is never replaced:

```txt
epicenter-app://localhost/apps/<app-id>/<commit>/…   <cache_dir>/builds/<app-id>/<commit>/…
builds/<app-id>/current                              the commit a newly opened window loads
```

`open_installed_app` opens a window at `/apps/<app-id>/<commit>/`, the
current commit, and its navigation stays below that path. A window already
open on the folder is revealed as it is. Building a commit whose directory
exists makes that directory current without building again.

## Consequences

- Every local commit costs one approval before it runs, the same click as an
  update. Approval by local authorship can return with fork support, which
  would know which commits a person made.
- Each build runs `bun install` in a fresh checkout, so a build no longer
  reuses the clone's `node_modules`; Bun's global cache supplies the packages.
  The clone has no `node_modules` or `dist/`.
- A newer build reaches a window only when the window is closed and opened
  again. Nothing reloads a page.
- A build directory is written once and kept, so `builds/<app-id>/` grows by
  one directory per approved commit until removal is built.

## Considered alternatives

- **`git archive` of the commit instead of a worktree.** Skips files marked
  `export-ignore`, so the build would not be the commit, and streams the
  whole tree through one buffer.
- **Keep serving `/apps/<app-id>/` and reload windows on a new build.**
  Discards page state, and misses a build the shell did not start.
