# 0532. A browser folder is its ID, written lazily, and its remote is its Git configuration

- **Status:** Proposed
- **Date:** 2026-10-14
- **Supersedes:** [ADR-0497](0497-browser-folders-use-scoped-opfs-directories.md)
- **Relates:** [ADR-0508](0508-folder-opening-overwrites-root-definition-json.md) now publishes the declaration with a handle's first write. [ADR-0531](0531-the-page-runs-the-folder-engine-and-the-shell-grants-the-directory.md) lets a desktop page set `origin` only to a network URL. [ADR-0503](0503-file-authoritative-workflows-preserve-information-and-tolerate-repairable-states.md) is the test each dropped guarantee was held to.
- **Unbuilt:** moving desktop installed apps' hosted datasets off connector pairings (`account-git-relay.ts`, `hosted.rs`), after which the pairing routes and their storage go; a redirect from a renamed GitHub repository answers `upstream_unavailable` instead of naming the rename.

## Context

A browser folder lived at `Epicenter|Epicenter Dev / local|accounts/<key> / <id>`
in the origin private file system. A ready marker in `.git` named that address
and the remote the folder was made with, and an opener refused a directory
whose marker named anything else. `downloadFolder` recorded a pending download
in the marker and turned it ready last; `inspectFolder` read the same decision
without writing. Opening created the directory, the marker, the repository,
and `epicenter.json`, so a person who opened Todos to download an account's
todos already had local changes the download refused.

The account layer above it paired a folder ID with a GitHub repository on the
hosted connector. A browser relayed Git through a path pinned to the pairing's
revision, and Todos asked a person to choose the Local demo or their account
before anything opened.

Each browser app is its own origin, so its private file system already belongs
to that app alone.

## Decision

**A browser folder is the directory named by its ID at the root of its
origin's private file system.** `openFolder({ id: 'so.epicenter.todos' })`
opens `<root>/so.epicenter.todos/`. An ID that cannot name one directory is
refused; nothing is escaped. Web Locks and the hint channel are named from the
ID. There is no marker, scope, channel, or account in the address, and a
directory someone else wrote under that ID is that folder.

**Opening writes nothing; the first write creates the folder.** The directory
and its repository appear together with the folder's first write, which
publishes `epicenter.json` just before it ([ADR-0508](0508-folder-opening-overwrites-root-definition-json.md)).
Each table's directory appears with its first row. Reads never write: a folder
nobody wrote to lists nothing and has no history, and a commit of it writes
nothing.

**The remote is `remote.origin.url` in the folder's Git configuration, on the
folder's own branch, and `folder.sync.connect(url)` is the only call that sets
it.** Connecting sets the URL, then runs Sync:

| Folder | Remote | Sync does |
| --- | --- | --- |
| files, no history | no branch | commits and pushes |
| empty | history | takes it |
| files, no history | history | merges them over an empty base; a differing path is a choice |
| its own history | related | an ordinary sync |
| its own history | unrelated | `Unrelated`, writing nothing, until `allowUnrelatedHistories` combines them |

The remote stays set whatever the sync answers. Every transfer reads the
configuration again, so a remote another tab or program set is the one used.
On the desktop the page sets it through the shell, which allows only a network
URL (`https://`, `ssh://`, `user@host:path`), so a push never writes another
repository on the computer.

**A browser reaches GitHub through the connector by the repository's canonical
clone URL.** The folder keeps `https://github.com/<owner>/<name>.git`. The app's
Git transport rewrites each smart-HTTP request for it to
`/api/git/github/repos/<owner>/<name>.git/...` as the signed-in account. The
connector reads the repository by name with the account's GitHub grant, then
reaches it only with a token scoped to its ID. Nothing but the folder records
which repository it uses.

## Consequences

- One folder per app per browser. Signing in as another account does not give
  it another copy; a repository the new account cannot reach is refused at
  the relay, visibly.
- A download that stops partway leaves some files and no record of it. The
  next Sync commits them and merges them with the remote; identical files
  merge cleanly. Nothing is lost, and nothing needs repair.
- The same URL works in Git, in the desktop app, and in any clone, because it
  is the repository's own URL rather than an Epicenter address.
- Folders at the old layout are left where they are and are no longer opened.
  Work that was synced comes back through Connect; work that never synced
  stays in the browser's storage at its old path.
- A relayed Git request costs one more GitHub REST call than a paired one, to
  read the repository by name.
- Deleted: the ready marker, `downloadFolder`, `inspectFolder`, browser scopes,
  `browser.remote`, `createIfMissing`, `confirmLegacyRemoteBranch`, the
  `Absent`, `RemoteMismatch`, `AuthorRequired`, and `InvalidBrowserScope`
  refusals, `DownloadFolderError`, and Todos' account folder gate and start
  choice. Todos opens its folder at once in every build, and Connect replaces
  the Local-or-account choice.

## Considered alternatives

- **Keep `local` and `accounts/<key>` directories.** Separate copies per
  account in one browser, at the cost of a scope on every opener and a
  download path that must not mix them. One person per browser is the common
  case, and the relay already refuses a repository the account cannot reach.
- **Storage Buckets for named roots.** Chromium only, and a folder ID already
  names a directory.
- **A marker or record of the remote outside Git.** A second source of truth
  for what Git configuration already says, which every Git program can read
  and change.
- **Publish `epicenter.json` with each commit.** A folder with saves but no
  version would not describe itself, and a staged commit would miss it.
- **Create the repository on the first read that needs one.** Then reading
  status would write; the repository comes with the directory instead.
- **Keep pairings and relay by folder ID and revision.** A second record of
  the folder's remote on the server, which every client had to agree with.
