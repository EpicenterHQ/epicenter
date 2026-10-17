# 0532. A folder is the directory its ID names, with its remote in Git configuration

- **Status:** Accepted
- **Date:** 2026-10-14
- **Supersedes:** [ADR-0497](0497-browser-folders-use-scoped-opfs-directories.md)
- **Amended by:** [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md) at "the folder's first write, which publishes `epicenter.json` just before it": a first write publishes nothing.
- **Relates:** [ADR-0508](0508-folder-opening-overwrites-root-definition-json.md) publishes the declaration with a handle's first write. [ADR-0531](0531-the-page-runs-the-folder-engine-and-the-shell-grants-the-directory.md) lets a desktop page set `origin` only to a network URL. [ADR-0503](0503-file-authoritative-workflows-preserve-information-and-tolerate-repairable-states.md) is the test each dropped guarantee was held to. [ADR-0521](0521-a-folder-syncs-over-plain-git-with-a-token-to-a-server-the-person-chooses.md) chooses the server a remote names and how a folder reaches it.

## Context

A browser folder lived at `Epicenter|Epicenter Dev / local|accounts/<key> / <id>`
in the origin private file system. A ready marker in `.git` named that address
and the remote the folder was made with, and an opener refused a directory
whose marker named anything else. `downloadFolder` recorded a pending download
in the marker and turned it ready last; `inspectFolder` read the same decision
without writing. Opening created the directory, the marker, the repository,
and `epicenter.json`, so a person who opened Todos to download an account's
todos already had local changes the download refused.

The desktop host grouped installed apps' folders the same way under
`~/Epicenter`, under a hash of the account identity: `local/<id>` signed out,
`accounts/<account-key>/<id>` signed in, so signing in changed which dataset an
app opened. Signed in, an app's folder arrived only by an explicit download
from the connector, and its pushes went through a loopback relay in the Bun
host to the account's pairing (`hosted.rs`, `account-git-relay.ts`).

The account layer above both paired a folder ID with a GitHub repository on
the hosted connector. A browser relayed Git through a path pinned to the
pairing's revision, the desktop host relayed it the same way, and Todos asked
a person to choose the Local demo or their account before anything opened.

Each browser app is its own origin, so its private file system already belongs
to that app alone.

## Decision

**A folder is the directory its ID names at its root.** The root is the
origin's private file system in a browser and the Epicenter root on the
desktop:

```text
browser    <OPFS root>/so.epicenter.todos/
desktop    ~/Epicenter/so.epicenter.todos/        (~/Epicenter Dev/ in development)
```

`openFolder({ id: 'so.epicenter.todos' })` opens that directory. An ID that
cannot name one directory is refused; nothing is escaped. There is no marker,
scope, channel, owner, or account in the address, and a directory someone else
wrote under that ID is that folder. Signing in, signing out, or changing
accounts opens the same folder. Web Locks and the hint channel are named from
the ID.

**In a browser, opening writes nothing; the first write creates the folder.**
The directory and its repository appear together with the folder's first
write, which publishes `epicenter.json` just before it
([ADR-0508](0508-folder-opening-overwrites-root-definition-json.md)). Each
table's directory appears with its first row. Reads never write: a folder
nobody wrote to lists nothing and has no history, and a commit of it writes
nothing. On the desktop the shell creates the directory when it grants it
([ADR-0531](0531-the-page-runs-the-folder-engine-and-the-shell-grants-the-directory.md)).

**The remote is `remote.origin.url` in the folder's Git configuration, on the
folder's own branch, and `folder.sync.connect(url)` is the only call that sets
it.** The folder records no account and no pairing. Connecting sets the URL, then runs Sync:

| Folder | Remote | Sync does |
| --- | --- | --- |
| files, no history | no branch | commits and pushes |
| empty | history | takes it |
| files, no history | history | merges them over an empty base; a differing path is a choice |
| its own history | related | an ordinary sync |
| its own history | unrelated | `Unrelated`, writing nothing, until `allowUnrelatedHistories` combines them |

The remote stays set whatever the sync answers. Every transfer reads the
configuration again, so a remote another tab or program set is the one used.
Connecting again with another URL swaps the remote. On the desktop the page
sets it through the shell, which allows only a network URL (`https://`,
`ssh://`, `user@host:path`), so a push never writes another repository on the
computer.

**A transfer uses the URL as written and a token for that server.** Every
host sends Git to `remote.origin.url` itself, with no rewriting, and presents
the token the server issued for that repository, or, on the desktop, the
person's own Git credentials
([ADR-0521](0521-a-folder-syncs-over-plain-git-with-a-token-to-a-server-the-person-chooses.md)). Nothing but the folder records
which repository it uses.

## Consequences

- One folder per folder ID per root. Accounts share it: signing in as another
  account does not give it another copy, and a server that refuses the new
  account's token refuses the transfer, visibly.
- A download that stops partway leaves some files and no record of it. The
  next Sync commits them and merges them with the remote; identical files
  merge cleanly. Nothing is lost, and nothing needs repair.
- The same URL works in Git, in the desktop app, and in any clone, because it
  is the repository's own URL.
- A repository deleted and recreated under the same name is the folder's
  remote; no stored repository ID tells them apart.
- Browser folders at the old layout are left where they are and are no longer
  opened. Work that was synced comes back through Connect; work that never
  synced stays in the browser's storage at its old path.
- Private runtime state (SQLite, keyring entries, blobs) keeps its app and
  account ownership outside the folder, in the host's private storage.
- Folders left under `local/` and `accounts/` are not moved or opened; they
  stay where they are. Installed apps, which used them, are parked.
- Deleted: the ready marker, `downloadFolder`, `inspectFolder`, browser scopes,
  `browser.remote`, `createIfMissing`, `confirmLegacyRemoteBranch`, the
  `Absent`, `RemoteMismatch`, `AuthorRequired`, and `InvalidBrowserScope`
  refusals, `DownloadFolderError`, and Todos' account folder gate and start
  choice. Todos opens its folder at once in every build, and Connect replaces
  the Local-or-account choice.

## Considered alternatives

- **Keep `local` and `accounts/<key>` directories.** Separate copies per
  account on one device, at the cost of a scope on every opener, a dataset
  that changes with sign-in, and a download path that must not mix them. The
  server already refuses a token that cannot reach the repository.
- **Record the account in Git configuration and refuse a transfer as anyone
  else.** The server already refuses a token that cannot reach the repository,
  and one that can reach it is allowed. The record would only block legitimate
  syncs and add a second record that must agree with the session.
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
