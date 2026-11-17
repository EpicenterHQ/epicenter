# 0910. An Epicenter is one private repository, and each app keeps its code beside its data

- **Status:** Accepted
- **Date:** 2026-11-14
- **Amended by:** [ADR-0911](0911-export-copies-an-apps-committed-code-into-a-refreshable-directory.md): local code export and refresh; publication still uses a separate history and ordinary Git.
- **Implementation:** Source retains the existing container lock, tolerant reads, HTTP/MCP actions, UI builds, private input and serve-owned clock. This change adds code/data siblings under `apps/`, root checkpoints, committed code copying, and single-clone restore; it removes action Git bookkeeping.
- **Migration:** On 2026-11-14 the root and 18 app repositories were combined into one private repository, with exact original signed objects under archival tags. On 2026-11-15 the personal home moved onto Vault history instead (see "Personal Vault home, 2026-11-15" below). The earlier combined history remains as archive refs on that home's origin. Its separate GitHub repository and the 17 individual app repositories were deleted after their histories and media were verified on the surviving origin. The stopped originals remain in local recovery archives.
- **Supersedes:** [ADR-0877](0877-an-apps-code-and-its-data-are-two-repositories-and-sharing-an-app-shares-its-code.md): separate code and data repositories and sharing their existing histories; [ADR-0884](0884-an-epicenter-is-a-repository-that-lists-the-repositories-inside-it-and-init-from-rebuilds-it.md): a root that excludes apps, records their repositories, and restores them with separate clones.
- **Amends:** [ADR-0842](0842-an-action-is-a-commit-and-the-repository-is-the-sync.md): withdraw per-action commits and app-repository sync.
- **Amends:** [ADR-0870](0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md): root checkpoints retain the local-file exclusion and refusal.
- **Amends:** [ADR-0876](0876-an-apps-records-live-under-data-and-everything-else-in-it-is-code.md): withdraw code at the container's top; retain `data/` paths and the write boundary.
- **Amends:** [ADR-0883](0883-an-epicenter-is-its-git-repositories-and-serve-and-its-host-keeps-runs-and-guards-them.md): replace per-app repositories and backups with one root checkpoint; retain the host and listener boundary.
- **Amends:** [ADR-0885](0885-an-epicenters-apps-live-in-apps-which-its-repository-ignores-with-one-line.md): withdraw ignoring `apps/`; retain the wrapper.
- **Amends:** [ADR-0887](0887-a-program-keeps-a-clone-of-an-apps-data-repository-and-the-host-files-what-it-pushes.md): withdraw the assumption that an app's data is a separately cloneable repository; leave the device protocol undecided.
- **Amends:** [ADR-0893](0893-a-records-path-is-its-path-in-the-apps-data-repository.md): withdraw repository-relative record paths; retain container-relative `data/...` paths without redesigning the data-root API.

- **Amends:** [ADR-0896](0896-each-collection-has-one-writer-of-record-and-epicenter-never-reconciles-two-writable-copies.md): source authority remains; preserving a stray edit before a pull requires a manual checkpoint.

The live Epicenter uses this layout. Source implementation and migration of
the person's files were checked separately. The root MIGRATION.md records
recovery paths and the archival tag namespace. Code-only publication and
updates remain deliberate copies; no managed publisher or updater was added.

- **Proposed amendment:** [ADR-0916](0916-export-saves-a-local-checkpoint-before-copying-code.md) adds local checkpointing before export, factual checkpoint subjects, and backup uploads outside the root lock.

## Context

The previous source shape gave each app two repositories:
`apps/<app>/` for code and `apps/<app>/data/` for records. The root was another
repository whose `.gitignore` excluded `apps/`. It rewrote `repositories.json`
to record each nested repository and its origin, then restored them with
separate clones.

A write call snapshotted pending data before its first write and committed
again when it ended. `Code-Commit` and `Code-Dirty` trailers described the
code loaded for that call. The CLI supplied `history`, `undo`, `sync`, and
`update`. `new --from` cloned an app into place and kept its remote as
`upstream`; `update` merged that remote's later changes.

Agents edit live code and records in place. Per-call commits miss direct
edits as units of intent and can attribute concurrent edits to an unrelated
call. Nine apps require nineteen repositories, each with an index, branch,
and backup to inspect. Updating an app by merging its starter is a promise
we do not want to maintain.

An earlier draft on another branch used number `0904` for "copying is the
only way to take an app's code". Another used `0905` for one repository whose
apps were direct children and whose checkpoint ran in a separate LaunchAgent.
Neither draft is in this tree; those numbers belong to other records. This
record restates committed code copying, keeps the `apps/` wrapper, and keeps
the checkpoint clock in `serve`.

## Decision

**An Epicenter has one private Git repository, normally on `main`.**
Code and records change together under agents, so they share history, one
optional remote, and one recovery procedure. Git commands use the checked-out
branch; they do not switch to `main`. The person chooses the origin, such as
a private GitHub repository or another host. It receives every app's records,
so it stays private. An Epicenter without origin still runs and commits locally.

```txt
<Epicenter>/                         one private Git repository
  .git/
  EPICENTER.md  AGENTS.md
  .gitignore  .gitattributes
  theme.css                         optional shared theme
  apps/
    <app>/                          stable app container
      code/                         ordinary editable Bun project
        epicenter.ts  package.json  bun.lock  README.md
        node_modules/               ignored
        ui/                         source
          dist/                     ignored build
      data/                         records and settings
        tasks/<time>.md
        google.local.md             credentials kept on this computer
```

**Code and data are sibling directories, and records never live inside `code/`.**
`code/` is an ordinary Bun project for actions, tests, and the UI. `data/` holds
records, settings, and `.local` credentials. Copying or replacing code is an
operation on one directory that leaves records beside it. Epicenter creates
no nested `.git` under `apps/`.

**The app container is the runtime identity and the write-lock boundary.**
`context.folder` and `folder.path` refer to the real `apps/<app>` directory.
Collection and contract paths still start with `data/`. Writes through
`folder` stay under `data/` and refuse any `.git*` segment. The app lock flocks
the container inode from a call's first write until it ends, including a throw
or stop. Replacing `code/` does not split or release that lock.

A separate real `codePath` names `code/`. The runner uses it to check
`engines`, import `epicenter.ts`, invalidate modules, install dependencies,
link `@epicenter/app`, and build, fingerprint, and serve `ui/dist/`. These
operations must not move the folder API into `code/`. The open data-root API
redesign in ADR-0893 remains out of scope.

**Actions coordinate file writes and perform no Git work.**
They make no snapshot, commit, or code trailer. The CLI has no `history`,
`undo`, `sync`, or `update` command. The container lock remains because two
read-modify-write calls must take turns even when no commit follows them.
Read-only calls take no lock; their permitted `.local` writes stay local.

**Manual checkpoints and serve's clock run the same root operation.**
`epicenter checkpoint [-m <message>] [--json]` serializes with `hold(root)`.
The existing clock runs it at startup, five minutes after each scheduled pass
completes, and on stop, with the existing ten-second shutdown wait. No separate
scheduler is added.

A checkpoint defers during a merge, rebase, revert, or cherry-pick. It retries
an index-lock collision briefly, then defers if Git remains busy. It refuses:

- Untracked `.local` paths that Git would include, and tracked `.local` files
  until their index entries are removed.
- Included embedded repositories and index gitlinks. Ignored cache/build
  directories and symlink targets are not traversed.
- Pending LFS paths when the LFS process filter is missing.

Tracked ignore rules decide what a checkpoint records. A file under `data/`
that an ignore rule matches, such as a regenerable rendition or a provider
mirror kept on one computer, stays out of the index and the commit and does
not block included files. Each such rule names the app and directory it covers.

It stages everything included with `git add -A`, consumes the shared index,
and makes one commit named `checkpoint` or the supplied message. It pushes
only to `origin`, without pull, merge, rebase, or force. It refuses a push
whose unpushed history contains `.local` additions. A push has a ten-minute
process-group deadline. A refusal leaves the remote unchanged; a later pass
retries an outstanding push even when no new commit is needed.

Checkpoints sample the working tree. They do not identify a call's effects,
wait for an agent to finish, or make an action transactional. A person or
agent makes a named commit before a risky change.

**Records remain readable while code and data disagree.**
There is no global migration gate. Reads return fitting fields, `problems`,
and, on a full record read, `other`. They do not erase the original file.
Change code, then repair the records with an agent or action. Checkpoints
record both kinds of edit. Missing or broken code never hides the app's data
from a checkpoint.

**An app's owner changes its code, and taking code is a committed copy.**
`new --from <path|url>[#folder]` takes a repository root, a subfolder, or an
app container's tracked `code/` into `apps/<app>/code/`. It excludes `data/`,
`.local` paths, any `node_modules` segment, `ui/dist`, and old `SOURCE.md`.
It creates no `.git` or upstream remote and promises no later merge. It writes
provenance in `code/SOURCE.md`; no command reads that file.

Copies preserve executable modes and symbolic links. For example,
`code/ui/src/theme.css -> ../../../../../theme.css` resolves only when the
destination Epicenter has that root theme. `new` reports dangling links and
leaves their targets unchanged. There is no updater, version or baseline
manager, app registry, or registry of data mounts. Each collection's authority
is its local files or an outside source; Epicenter does not force a writable
mirror between them.

**Publishing code uses a separate history made deliberately by the person.**
That history contains only code, never private records. The private root
history is not a publication source to push as a whole. No publication command
is built. Make or clone the code-only publication repository outside the private
Epicenter: a Git repository inside it makes every checkpoint refuse.

**Recovery selects code, records, or both by path.**
Inspect first, then restore the intended paths:

```sh
git log --oneline -- apps/<app>/
git restore --source=<c> -- apps/<app>/code/    # code only
git restore --source=<c> -- apps/<app>/data/    # records only
git restore --source=<c> -- apps/<app>/         # both
```

A whole-app restore reverts both directories and deletes tracked files added
after that commit. Inspect the tree before restoring: migrations can change
paths, and an imported per-app commit can hold only code or only data.
Restoring the whole app from that commit deletes the absent sibling. Restore
its code or data prefix instead. Archive refs are separate from `main`; the
root `MIGRATION.md` records which histories and paths a home preserves.

## Personal Vault home, 2026-11-15

The personal home at `~/Epicenter` uses the existing Vault repository and
its history as its foundation. That private GitHub repository was renamed
in place to `epicenter` and is the home's only origin. Vault programs live in
`apps/vault/code/`; authored records, paid assets, settings, and local state
live in `apps/vault/data/`. The nine other apps entered `main` as a current
snapshot of their code/data paths. Their earlier histories were not merged.

`main` is the working history: Vault's commits, the move into `apps/vault/`,
the app snapshot, and later checkpoints. Older histories stay on the same
origin outside `main`: the earlier combined history at
`refs/tags/retired-epicenter-20261115/main`, the per-repository migration tags,
and earlier rehearsal branches. These retain the nine apps' earlier commits;
the origin also retains their historical Git LFS media. The home fetches
`main` only, without tags. To inspect earlier app history, explicitly fetch
an archive ref into a separate recovery checkout and fetch its LFS media
when needed. Keep the live home on its current branch. Vault commits from
before the move use Vault's old root paths; the nine apps' history on `main`
begins at the snapshot.

This home uses ordinary Git blobs. Existing LFS media was materialized and
its staged bytes were checked before import. Ten nested LFS attribute files
were omitted; the root attributes file contains only a comment recording the
ordinary-Git choice. That file also prevents fresh initialization from adding
LFS rules. The active repository has no local LFS configuration, hook, or cache.
The original Vault all-ref scan found no LFS pointer files. Archive refs
added later do contain LFS pointers; the origin retains their media objects.
No Vault history was rewritten to remove historical references. Generic CLI
support for older LFS homes remains available.

One always-on computer runs the working home. Taking a current app snapshot
avoids importing and maintaining another set of histories that the running
software does not need. Ordinary blobs remove a second media fetch and upload
procedure from this home's restore. Restore the working home with a
`--single-branch --branch main --no-tags` clone; the origin backs up `main`.
The archival refs and stopped filesystem copies preserve the cutover state;
new checkpoints do not update those archives.

Reviewed ignore rules decide inclusion, including Vault's deliberately local
mirrors and regenerable output. The separate secret-file refusals remain.
A complete filesystem backup preserves ignored bytes and literal symlinks;
Git alone does not recover them or external symlink targets. Both original
trees and Git indexes remain outside the active home for rollback. The old
`~/Code/vault` path is a shortcut to the one Vault data directory.
The origin holds what the last successful checkpoint pushed. Later edits
remain local until the next push. Ignored files, including local credentials,
require a separate filesystem backup. Checkpoints do not retain every
intermediate edit.

The new Vault entrypoint offers read-only search and check actions. Its legacy
CLI and publishing rules remain, with the required path and dependency fixes.
This migration did not port every domain command, render media, add a UI,
rewrite records or publication metadata, publish, or deploy. A fresh private
main clone recovered every included file with Git LFS disabled; all ten apps
loaded, MCP reads passed, and the restarted service made a signed checkpoint.
The personal root's `MIGRATION.md` records layout and recovery paths; the
verification artifacts record commit identities.

## Consequences

- Deleted machinery: per-app repository creation, repository lists, per-call
  snapshots and commits, code trailers, backup status per app, and the
  `history`, `undo`, `sync`, and merge-based `update` commands.
- Kept machinery: `apps/` discovery, file contracts, tolerant reads, container
  locks, local credentials, HTTP/MCP, and UI builds.
- Checkpoints can contain partial direct edits or part of a running action.
  Uncommitted intermediate states are not recoverable from Git.
- Deleting `apps/<app>` deletes its working-tree records too. A later
  checkpoint records those deletions.
- A branch switch, stash, or reset changes live code and records together.
  Experiments belong outside the live Epicenter.
- A migration states whether it imports app histories or takes a current
  snapshot. It preserves complete originals outside the active home and
  verifies a private-origin round trip. Ordinary CLI commands do not move
  an existing home into this layout automatically.

## Not decided

- A scheduler independent of `serve`, including the earlier draft's separate
  LaunchAgent. The source keeps the serve-owned clock.
- A storage policy for other Epicenters. The personal Vault home uses ordinary
  blobs; existing LFS support remains for older homes.
- The code-only publication workflow. Local export is subsequently settled by
  [ADR-0911](0911-export-copies-an-apps-committed-code-into-a-refreshable-directory.md);
  repository provisioning and automated publication remain outside the CLI.
- What a program on another device clones under ADR-0887 after data stops
  being its own repository.
- How revised guidance reaches existing Epicenters. `init` preserves an
  existing `AGENTS.md`.

## Considered alternatives

- **Keep per-app code and data repositories.** Nineteen repositories for nine
  apps preserve a bookkeeping problem that agents do not need.
- **One repository for code and another for records.** A code change and its record
  repair still need coordinated histories and two restores.
- **One repository per app.** The split shrinks, but root restore and backup
  still need a list of repositories.
- **Apps as direct root children.** It confuses apps with routines, scripts,
  and other root folders. `apps/` makes the discovery boundary explicit.
- **Data inside code.** Replacing or copying code can delete or disclose records.
- **A merge-based updater.** It promises compatibility and later merges for
  code an agent is expected to change in place.
- **A private index or checkpoint branch.** A second version of the working
  tree hides how checkpoints interact with the person's branch and index.
- **Commit per call or watch every file.** Calls miss direct-edit intent;
  watchers guess when an editor or agent is finished. Named commits supply
  intent, and checkpoints supply sampled history.
- **Refuse every ignored file under `apps/*/data`.** Regenerable renditions and
  local mirrors are ignored on purpose, so the refusal blocked every app's
  checkpoint. The reviewed ignore rules already state what stays out.
