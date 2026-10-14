# 0531. The page runs the folder engine and the shell grants the directory

- **Status:** Proposed
- **Date:** 2026-10-14
- **Relates:** [ADR-0476](0476-whisperings-desktop-folder-uses-one-rust-library-in-both-tauri-shells.md) (Proposed) chose one Rust folder implementation for desktop shells; this record chooses the opposite for every folder that moves to it. [ADR-0503](0503-file-authoritative-workflows-preserve-information-and-tolerate-repairable-states.md) is the test each dropped guarantee was held to.
- **Unbuilt:** moving Capture, Whispering, Honeycrisp, the Git lab, and installed apps to page-engine scopes, then deleting the Rust owner; a file watcher for other programs' edits; checking that Web Locks and `BroadcastChannel` reach every window of a Tauri shell on macOS and Windows; a real desktop run.

## Context

`@epicenter/folder` had two engines that implement the same rules: the
TypeScript engine (file storage, history, merge, recovery) and a Rust owner
the desktop shell runs (`tauri-plugin-epicenter-folder`), about 20,000 lines
with a versioned page protocol. Every folder feature was built twice, and the
desktop folder could not Sync.

The TypeScript engine already had two history backends behind one
interface: isomorphic-git over a private OPFS `.git` for browsers, and the
system `git` for directories in Bun (`git/native-backend.ts`), which changes
the index and refs only through `git` and so shares a repository with other
Git programs. Its file storage reaches OPFS only through a small directory
handle.

## Decision

**A desktop folder is opened by the page, with the TypeScript engine, over a
directory the shell grants: files through Tauri's fs plugin, history through
the system `git`, which the shell runs for it.**

The shell registers the folder with `page_engine`. Its first
`grant_directory` creates the directory, refuses a linked `.git`, takes the
cross-process lock until shutdown, and adds a capability for the calling
window: the fs plugin's reading commands on the root and beneath it. The fs
plugin must not require a literal leading dot. Rust makes every change
itself (`write_folder_file` and its siblings), after checking the whole path
on disk: under the root, no link on the way, one of the files the shell
declared for the folder (`page_files`) with no dot-named, short-name, or
`HEAD` part, or inside `.git` only the engine's staging and private index
copies. Git stores every object (`hash-object -w`). Rust runs `git`
for the page (`run_git`) only in a granted root whose `.git` is its own
directory, only as the exact operations the engine uses, pushing and
fetching only `origin`, which a page may set only to a network URL, with no
hook, fsmonitor, terminal prompt, or inherited repository variables. Fixtures recorded from the engine's real-Git
tests keep both checks and the engine in step.

The page opens a directory folder: the browser's file storage over a
directory handle built on seven calls, and the native Git backend over a
host of a `git` runner and the same calls. The repository is used as Git
left it, and Git's configuration names the remote and author.

Folders move one scope at a time. `@epicenter/folder/tauri` asks for a grant
first and attaches to the Rust owner only when the shell answers `UsesOwner`.
Todos is the first page-engine scope.

## Consequences

- One engine serves browser and desktop. Desktop Todos gains Sync and the
  merge review from code the browser and Bun already run. History on disk is
  real Git: packed refs, `git gc`, Git's lock files, and the person's
  credential helper or SSH work as they do for any Git program.
- The browser and the desktop differ only in their history backend, behind
  one interface; their merge, review, and recovery rules are shared.
- Three guarantees of the Rust owner are dropped, each because the state it
  protected stays visible and repairable: work a reloading page was running
  stops; other programs' edits are not watched for, and pages read again at
  their own moments; an incoming update that stops partway keeps no record,
  and the next Sync records and merges what it wrote.
- The desktop bundle carries the directory folder and the fs plugin client
  in a chunk loaded only for a granted folder, and none of the browser
  folder's storage address, download, or private Git. It needs no HTTP
  plugin.
- The page names paths inside the granted directory. "A page never names a
  path" becomes "a page reads only directories the shell granted it, and
  changes only the files the shell declared for them". A page cannot write
  any other file on the desktop, `.gitignore` included.
- Each object is a `git` process on the desktop, so a commit of many new
  files is slower than an in-process write.
- A link another program swaps in between Rust's check and its change is
  not defended against; a page cannot make one. The engine's own staging
  files and index copies in `.git` are written in place, so a hard link
  another program planted there would be written through.
- A compromised page keeps the powers the engine needs, which are about
  integrity, not escalation: it can move the branch (`update-ref`), reset
  the index, and change or delete the declared files. Each is visible and
  repairable from the reflog and the remote.
- Unverified until a desktop run: Web Locks and `BroadcastChannel` across a
  shell's windows on macOS and Windows, and Git for Windows honoring a
  `core.hooksPath` under `.git/epicenter/no-hooks`.

## Considered alternatives

- **isomorphic-git over the real `.git`** (built first). A review found it
  forks a branch native Git had packed, rewrites `.git/config`, leaves empty
  objects that native Git takes for real ones, takes none of Git's lock
  files, and cannot see system configuration. Making it safe means
  reimplementing Git's on-disk protocol and auditing every isomorphic-git
  operation on a shared repository.
- **Keep the Rust owner and add Sync to it.** Builds Connect, remote changes,
  merge parity, and every later folder feature a second time.
- **Tauri's shell plugin running `git`.** A page could pass a working
  directory or environment that makes Git run another program.
- **The engine in the Bun host.** Several windows would share one engine,
  but it needs the sidecar that standalone shells are removing, and a new
  page-to-host protocol.
- **A disk-shaped file interface with OPFS as one adapter**, instead of the
  OPFS-shaped directory handle. Would remove the remaining OPFS emulation;
  kept for a later pass, since the handle now publishes only by rename and
  history no longer depends on it.
