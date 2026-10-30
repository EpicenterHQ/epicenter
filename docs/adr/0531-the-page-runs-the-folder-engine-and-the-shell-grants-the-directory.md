# 0531. The page runs the folder engine and the shell grants the directory

- **Status:** Accepted
- **Date:** 2026-10-14
- **Supersedes:** [ADR-0476](0476-whisperings-desktop-folder-uses-one-rust-library-in-both-tauri-shells.md), which chose one Rust folder implementation for desktop shells.
- **Amended by:** [ADR-0559](0559-all-desktop-git-runs-in-the-epicenter-cli-over-system-git.md) at "history through the system `git`, which the shell runs for it" (`run_git`): the `epicenter` CLI runs whole Git operations for the page, one child each, under the same rules, while files through the shell's read and checked change commands are unchanged; and [ADR-0581](0581-a-desktop-pages-folder-storage-is-one-shell-command-per-storage-method.md) at the read and change commands, reads reaching `.git`, changes to staging files and index copies, the four expectations, and the seven-call directory handle: the page's storage is one shell command per storage method over data paths, and the shell stages and publishes each put.
- **Amended by:** [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) at history through `run_git` and `hash-object -w`: the page has no history.
- **Relates:** [ADR-0457](0457-a-row-filename-is-its-exact-id-and-a-title-is-a-field.md) names rows by their exact stem, now under the shared path rule below. [ADR-0503](0503-file-authoritative-workflows-preserve-information-and-tolerate-repairable-states.md) is the test each dropped guarantee was held to.
- **Unbuilt:** a real desktop run of every shell; on Windows, Git for Windows honoring a `core.hooksPath` under `.git/epicenter/no-hooks`.

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
directory the shell grants: files through the shell's own read and change
commands, history through the system `git`, which the shell runs for it.**

The shell registers each folder for the windows that may edit it, and may
permit another window later. Each window's page runs its own engine over the
same directory; several editors are safe because the shell checks every
publish (below). The first `grant_directory`, from any of those windows,
creates an application's directory (never a data folder's), refuses a directory that is a link and a linked
`.git`, and takes the folder's one cross-process lock until shutdown, which
keeps out a second Epicenter process whose saves this shell would not
serialize. It adds nothing to the app's access control. Rust makes every read
(`read_folder_file`, `read_folder_directory`, `stat_folder_path`) and every
change (`write_folder_file` and its siblings) itself, after checking the
path on disk: the root or beneath it, and no link on the way. A read may
reach anything there, `.git` included; a final link is described and never
followed. A change must also be a data path the shared path rule accepts or,
inside `.git`, only the engine's staging files and private index copies, each
created as a new file. A rename that publishes a file, and a removal, carry
what the page expects at the path (nothing, a file, a file with a given
SHA-256, or anything); Rust checks it and makes the change under one lock
per root, so no other change through the shell, from any window, lands
between them. A save that carries what it read (a hash, or nothing for a
create) and that another window overtook is `Conflict`; an overwrite is
last-writer-wins by contract
([ADR-0535](0535-an-existing-folder-opens-with-its-own-declaration.md)).
The shell keeps no list of a
folder's files: an app's definition, a Sync, or a file browser may write any
data path.

**One path rule holds for every folder, in the engine and in the shell.**
`pathProblem` in `@epicenter/folder` and `path_problem` in the plugin refuse
the same paths, checked against one vector file: `.git` and `HEAD` in any
case, and any name that does not mean only itself on every disk (a trailing
dot or space, a reserved or control character, a Windows device name, a
Windows short name such as `GIT~1`, an ignorable code point), since such a name can reach `.git` or
another file by another spelling. Leading dots are ordinary. Sync checks an
incoming update against the rule before it writes anything. Git stores every
object (`hash-object -w`). Rust runs `git`
for the page (`run_git`) only in a granted root whose `.git` is its own
directory, checked again before every run (no shared object store, no link
for its objects, refs, or logs, and an empty no-hooks directory), only as the exact operations the engine uses, pushing and
fetching only `origin`, which a page may set only to a network URL (plain
`http` only to this computer's loopback), with no
hook, fsmonitor, terminal prompt, or inherited repository variables. A push or
fetch to an `https` origin may carry one credential, which Git reads from its
environment as a header for that URL alone
([ADR-0521](0521-a-folder-syncs-over-plain-git-with-a-token-to-a-server-the-person-chooses.md)). Fixtures recorded from the engine's real-Git
tests keep both checks and the engine in step.

The page opens a directory folder: the browser's file storage over a
directory handle built on seven calls, and the native Git backend over a
host of a `git` runner and the same calls. The repository is used as Git
left it, and Git's configuration names the remote and author.

Every desktop folder opens this way: Todos, Capture, and Whispering in
Epicenter ([ADR-0493](0493-whisperings-only-desktop-shell-is-epicenter.md)), and the standalone Honeycrisp and Git lab shells. The Rust owner,
its page protocol, and the desktop adapter that spoke it are deleted.

**Quitting is immediate** ([ADR-0542](0542-quitting-is-immediate-because-unfinished-work-already-lives-in-its-folder.md)):
no page is asked and nothing is waited for, because every save is an atomic
rename and unfinished work already lives in its folder. A page reload or a
closed window cancels that window's `git` runs, killing the process and its
helpers.

## Consequences

- One engine serves browser and desktop. Desktop Todos gains Sync and the
  merge review from code the browser and Bun already run. History on disk is
  real Git: packed refs, `git gc`, Git's lock files, and the person's
  credential helper or SSH work as they do for any Git program.
- The browser and the desktop differ only in their history backend, behind
  one interface; their merge, review, and recovery rules are shared.
- Guarantees of the Rust owner are dropped, each because the state it
  protected stays visible and repairable: a `git` run a reloading page started
  is cancelled; other programs' edits are not watched for, and pages read again on
  focus and after their own actions; an incoming update that stops partway
  keeps no record, and the next Sync records and merges what it wrote; two
  windows of one folder do not share one view of it, and each sees the
  other's saves when it reads again or as a `Conflict`; and quitting
  abandons only what was never saved (ADR-0542).
- The desktop bundle carries the directory folder and the folder plugin's
  commands in a chunk loaded only for a granted folder, and none of the browser
  folder's storage address, download, or private Git. It needs no HTTP
  plugin.
- The page names paths inside the granted directory. "A page never names a
  path" becomes "a page reads only the directory the shell granted it, and
  changes only data paths in it". It cannot write outside that directory or
  into Git's private state, and cannot assemble a nested repository.
- File names that do not survive every desktop disk are refused everywhere,
  browser included; a promise that any file name works is withdrawn.
- Each object is a `git` process on the desktop, so a commit of many new
  files is slower than an in-process write.
- A link another program swaps in between Rust's check and its change is
  not defended against; a page cannot make one. Links deeper than the first
  level of `.git/objects`, `.git/refs`, and `.git/logs` are not looked for.
- A compromised page keeps the powers the engine needs, which are about
  integrity, not escalation: it can move the branch (`update-ref`), reset
  the index, and change or delete the folder's data. Each is visible and
  repairable from the reflog and the remote.
- Verified on macOS on 2026-10-14 with Whispering's native quit harness, since
  deleted ([ADR-0542](0542-quitting-is-immediate-because-unfinished-work-already-lives-in-its-folder.md)):
  a quit during a 4000-file batch leaves only whole files.

## Considered alternatives

- **isomorphic-git over the real `.git`** (built first). A review found it
  forks a branch native Git had packed, rewrites `.git/config`, leaves empty
  objects that native Git takes for real ones, takes none of Git's lock
  files, and cannot see system configuration. Making it safe means
  reimplementing Git's on-disk protocol and auditing every isomorphic-git
  operation on a shared repository.
- **Keep the Rust owner and add Sync to it.** Builds Connect, remote changes,
  merge parity, and every later folder feature a second time.
- **A list of the files each folder may write** (built first, as glob
  patterns). The shell cannot know an installed app's definition, a file
  browser writes anywhere, and a Sync bringing a file outside the list was
  refused halfway through publishing.
- **Exactly one window per folder** (built first). It kept the engine from
  sharing files with another window's, but a folder browser could not open
  an application's folder while the application had it open. Once the shell
  checked and published every save (ADR-0535), several windows became safe.
- **Several windows on one folder coordinated by Web Locks and
  `BroadcastChannel` alone.** Those cover one origin, so a check in one page
  and a rename in another could still interleave across origins.
- **Tauri's fs plugin for reads under a runtime capability** (built first).
  Before Tauri 2.12, a capability added at run time numbered its scopes from
  zero, so the grant's path scope collided with a scope the app already had,
  and every read failed to deserialize it. The fs scope check follows links,
  so a link to outside the folder read as refused rather than as a link, and
  the plugin needed a version pin and a setting that lets its scope match a
  leading dot.
- **Tauri's shell plugin running `git`.** A page could pass a working
  directory or environment that makes Git run another program.
- **The engine in the Bun host.** Several windows would share one engine,
  but it needs the sidecar that standalone shells are removing, and a new
  page-to-host protocol.
- **A disk-shaped file interface with OPFS as one adapter**, instead of the
  OPFS-shaped directory handle. Would remove the remaining OPFS emulation;
  kept for a later pass, since the handle now publishes only by rename and
  history no longer depends on it.
