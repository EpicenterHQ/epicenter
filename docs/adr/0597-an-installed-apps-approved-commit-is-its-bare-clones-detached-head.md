# 0597. An installed app's approved commit is its bare clone's detached HEAD

- **Status:** Superseded
- **Date:** 2026-10-17
- **Superseded by:** [ADR-0605](0605-an-app-is-an-ordinary-single-page-app-in-a-forkable-git-repository.md): nothing approves a commit, an installed app is the person's clone of its source with a working tree, and the desktop builds a commit into app data; a window keeping the build it opened on stands, as ADR-0588 decided.
- **Amends:** [ADR-0588](0588-an-installed-apps-window-runs-one-approved-commits-own-build.md) at `approvals.json`, `builds/<app-id>/current`, the checkout by `git worktree add` with every filter driver emptied, `<commit>.built`, "a finished build is never replaced", and the rejected alternative "`git archive` of the commit instead of a worktree": the approved commit is the clone's detached `HEAD`, a build directory is a `git archive` of that commit checked against it at every open, and per-commit directories, URLs, and window pinning stand. [ADR-0589](0589-an-app-is-one-git-repository-of-built-files-at-an-address.md) at "`approvals.json` keys an approval by the readable address and the commit": the approval is the clone's `HEAD`, and the clone is bare. [ADR-0569](0569-the-installed-apps-are-the-clones-in-apps-not-rows-in-so-epicenter.md) at "the approvals in `approvals.json`": the clones alone record what is installed and approved. [ADR-0586](0586-you-open-a-folder-never-an-app.md) at `approvals.json` in its app-data tree: there is no such file.
- **Unbuilt:** the encoded address in the clone and build paths, since ADR-0589's addresses are unbuilt: clones are `<data_dir>/apps/<app-id>/` and builds `<cache_dir>/builds/<app-id>/<commit>/`. A build directory as an archive of the approved commit itself: until ADR-0589 moves the build to publishing, the commit is built from source (extracted by `git archive` into `<cache_dir>/sources/<app-id>/`), its `dist/` is written into the clone as the tree `refs/epicenter/builds/<commit>`, and the build directory is a `git archive` of that tree, checked against it at every open.

Retired source files below use their last tracked Git snapshot (`commit:path`);
inspect one with `git show commit:path`.

## Context

An installed app is a clone in app data (ADR-0586, ADR-0589). Which commit
may run is a second record beside it, `approvals.json`
(`readApprovals` and `recordApproval`,
`f16c69134b49:packages/cli/src/installed-apps.ts`, `:345`), and which build a new
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
  deletes every ref the clone wrote (its own `refs/heads/<default>`, and any
  a refspec in a person's global configuration mapped), fetches once, and
  detaches `HEAD` at the commit the person approves
  (`git update-ref --no-deref HEAD <commit>`). A clone whose `HEAD` is still
  a symbolic ref has no approved commit and opens nothing; with its branch
  deleted, no local ref remains that `rev-parse` could take for another
  name.
- Fetching writes `refs/remotes/origin/<default>` and never `HEAD`, and
  never fetches the `template` branch or tags (ADR-0598). Every fetch passes
  the clone's one refspec on the command line with `--refmap=` and
  `--no-tags`, so no refspec in a person's global or system configuration
  writes another ref. An update is available when
  `refs/remotes/origin/<default>` differs from `HEAD`.
- Approving names the commit the person was shown and fetches nothing, so
  an approval never covers a commit nobody saw.
- `git pull` and `git merge` refuse to run in a bare repository ("this
  operation must be run in a work tree"), so nothing but approving moves
  `HEAD`.
- Approving a commit is `git update-ref --no-deref HEAD <commit>`. A newly
  opened window loads `HEAD`.
- A build's tree is read only from the exact ref
  `refs/epicenter/builds/<commit>` (`git show-ref --verify`), and only when
  that ref names a tree object, never a commit peeled to one, so no upstream
  branch or tag of that name can supply it.

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
tree, by path and blob hash. A difference, or a check that cannot finish,
is a damaged build.

**A damaged build is replaced only when no window runs it.**
`open_installed_app` asks the CLI once without restoring, so opens of an
intact build never reserve it or refuse each other. When the CLI answers
that the build is damaged, the shell reserves that commit, which succeeds
only when `InstalledWindowCommits` (`apps/epicenter/src-tauri/src/lib.rs`)
names no window on it and no other open holds it, and asks the CLI again
with `--restore`: the CLI extracts the commit into a new sibling directory,
checks it, moves the damaged directory aside, renames the fresh one into
place, and removes the damaged one. Every window is pinned to its commit
before its WebView is created, so no page loads a build being replaced.
Without `--restore` the CLI writes nothing. When the reservation fails, the
shell opens nothing and reports the damaged build to the person, so the
windows on that commit are closed before it is replaced.
ADR-0588's per-commit directories and URLs, and a window keeping the build
it opened on, stand.

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
- Every open reads each file of the build once and hashes it, and a
  restore hashes the fresh copy once more. An app's build is a few
  megabytes.
- The build is verified when an app opens, not as each file is served:
  bytes a local process changes under `builds/` after that check are
  served until the next open. That is the trust ADR-0540 already grants
  local processes; the check catches a damaged or partial build, not a
  process racing the scheme.
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
