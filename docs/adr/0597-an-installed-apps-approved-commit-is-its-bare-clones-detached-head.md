# 0597. An installed app's approved commit is its bare clone's detached HEAD

- **Status:** Accepted
- **Date:** 2026-10-17
- **Amends:** [ADR-0588](0588-an-installed-apps-window-runs-one-approved-commits-own-build.md) at `approvals.json`, `builds/<app-id>/current`, the checkout by `git worktree add` with every filter driver emptied, `<commit>.built`, "a finished build is never replaced", and the rejected alternative "`git archive` of the commit instead of a worktree": the approved commit is the clone's detached `HEAD`, a build directory is a `git archive` of that commit checked against it at every open, and per-commit directories, URLs, and window pinning stand. [ADR-0589](0589-an-app-is-one-git-repository-of-built-files-at-an-address.md) at "`approvals.json` keys an approval by the readable address and the commit": the approval is the clone's `HEAD`, and the clone is bare. [ADR-0569](0569-the-installed-apps-are-the-clones-in-apps-not-rows-in-so-epicenter.md) at "the approvals in `approvals.json`": the clones alone record what is installed and approved. [ADR-0586](0586-you-open-a-folder-never-an-app.md) at `approvals.json` in its app-data tree: there is no such file.
- **Unbuilt:** all of it: bare clones in `<data_dir>/apps/<encoded address>/` with a detached `HEAD`, their `info/attributes`, extraction by `git archive`, the check at open, and the deletions below.

## Context

An installed app is a clone in app data (ADR-0586, ADR-0589). Which commit
may run is a second record beside it, `approvals.json`
(`readApprovals` and `recordApproval`,
`packages/cli/src/installed-apps.ts:303`, `:345`), and which build a new
window loads is a third, `builds/<app-id>/current` (`CURRENT_BUILD`, `:81`;
`currentBuild`, `:591`). `inspect` (`:653`) compares the clone's `HEAD` with
the approval and `settle` (`:933`) writes `current`. A clone with a working
tree has a `HEAD` that `git pull` or `git merge` moves, so the approval has
to live somewhere Git does not write.

A build checks its commit out with `git worktree add`, after
`checkoutOptions` (`:1131`) reads every `filter.<driver>.*` key in the
clone's configuration and empties each one, so no smudge, clean, or process
command runs. ADR-0588 rejected `git archive` because it drops files marked
`export-ignore`. Neither approach neutralizes line-ending conversion or
`working-tree-encoding`, which the person's global configuration or the
commit's `.gitattributes` can turn on.

ADR-0588 serves a finished build directory without reading it again, so an
edit to a file under `builds/` is served to every window that opens on that
commit.

## Decision

**Each installed app is a bare clone, and its detached `HEAD` names the
approved commit.**

```txt
<data_dir>/apps/<encoded address>/      git clone --bare --single-branch --no-tags of the default branch
  HEAD                                  detached: the approved commit
  config                                remote.origin.fetch = +refs/heads/<default>:refs/remotes/origin/<default>
                                        remote.origin.tagOpt = --no-tags
  info/attributes                       * -filter -text -eol -ident -export-ignore -export-subst -working-tree-encoding
```

- Installing clones bare with `--single-branch --no-tags`, which fetches
  only the default branch, records `remote.origin.tagOpt=--no-tags`, and
  writes no fetch refspec. The installer reads
  `<default>` from the clone's symbolic `HEAD`, writes the refspec above,
  fetches once, and detaches `HEAD` at the commit the person approves
  (`git update-ref --no-deref HEAD <commit>`). A clone whose `HEAD` is still
  a symbolic ref has no approved commit and opens nothing.
- Fetching writes `refs/remotes/origin/<default>` and never `HEAD`, and
  never fetches the `template` branch or tags (ADR-0598). An update is
  available when `refs/remotes/origin/<default>` differs from `HEAD`.
- `git pull` and `git merge` refuse to run in a bare repository ("this
  operation must be run in a work tree"), so nothing but approving moves
  `HEAD`.
- Approving a commit is `git update-ref --no-deref HEAD <commit>`. A newly
  opened window loads `HEAD`.

**A build directory is `git archive` of its commit, byte for byte.** The
installer extracts `git archive <commit>` into a sibling of
`<cache_dir>/builds/<encoded address>/<commit>/` and renames it into place.
`$GIT_DIR/info/attributes` outranks every `.gitattributes` in the tree and
the person's global attributes file, and its one line unsets every
attribute that changes bytes on the way out: filters, end-of-line
conversion, `ident`, working-tree encoding, `export-subst`, and
`export-ignore`, so no file is dropped. `core.autocrlf` converts nothing
for a path whose `text` is unset.

**Opening an app checks its build directory against the commit.** The
check runs in the CLI, inside `epicenter app update --commit=<commit>`,
which `open_installed_app` already runs before every open (ADR-0588). It
compares `<cache_dir>/builds/<encoded address>/<commit>/` with the commit's
tree, by path and blob hash. On any difference, or a check that cannot
finish, the CLI extracts the commit into a fresh sibling directory and
answers that the build was damaged.

**A damaged build is switched only when no window runs it.** When
`InstalledWindowCommits` (`apps/epicenter/src-tauri/src/lib.rs`) names no
window on that commit, `open_installed_app` moves the damaged directory
aside, renames the fresh one into place, removes the damaged one, and
opens. Otherwise it leaves both directories, opens nothing, and reports the
damaged build to the person, so the windows on that commit are closed
before it is replaced. ADR-0588's per-commit directories and URLs, and a
window keeping the build it opened on, stand.

Deleted: `approvals.json`, `readApprovals`, and `recordApproval`;
`CURRENT_BUILD`, `currentBuild`, and `settle`'s write of `current`;
`checkoutOptions`, `checkOut`, `removeCheckout`, and
`<cache_dir>/checkouts/`; `<commit>.built` and `isCompleteBuild`, since the
check at open finds a partial build as it finds an edited one.

## Consequences

- What is installed and what is approved are both read from the clones:
  `git -C <clone> rev-parse HEAD` per app, no file to keep in step.
- A person or an agent can approve by hand with the same `git update-ref`,
  as one could write `approvals.json` before: approval guards against
  remote code, not local processes (ADR-0556).
- Every open reads each file of the build once and hashes it. An app's
  build is a few megabytes.
- A file Git LFS tracks is extracted as its pointer, as under ADR-0588.
- A commit whose tree holds a symbolic link extracts the link, and the
  scheme refuses to serve through it (ADR-0588).

## Considered alternatives

- **Keep `approvals.json` beside a non-bare clone.** A second record of one
  fact, kept because the clone's own `HEAD` can be moved by `git pull`.
- **Keep the worktree checkout with filter drivers enumerated and
  emptied.** It names each driver the configuration declares, and leaves
  line endings and encoding to the person's configuration.
- **Trust a finished build directory.** An edit under `builds/` would run
  as if it were the approved commit.
