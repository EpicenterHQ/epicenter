# tauri-plugin-epicenter-folder

One native owner per folder, shared by every window of a Tauri shell.

A shell registers a directory under a scope ID and names the windows that may
use it. The Rust owner publishes files, records Git history when the folder is
free, and tells every attached window what changed. A page names the scope and nothing else: it
never supplies a root, an author, a remote, or a commit policy.

## Layout

| Path | What it is |
| --- | --- |
| `core/` | `epicenter-folder-core`: the owner, the registry, and the cross-process lock. No Tauri; its tests need only `git` and `bun`. |
| `src/` | The Tauri plugin: commands, events, sessions. |
| `../folder/src/native/bindings.gen.ts` | TypeScript commands, events, and types, generated from the Rust plugin into `@epicenter/folder`, whose desktop adapter is their only user. Do not edit. |
| `fixtures/commit-subjects.txt` | Commit subject vectors shared by the Rust port and `commitSubject` in `@epicenter/folder`. |

This crate has no JavaScript package of its own. A page reaches it through
`@epicenter/folder` (or `@epicenter/folder/tauri`).

## Registering folders in a shell

Install the plugin once. Register each folder from trusted Rust code after the
shell has resolved its paths, which is in `setup`, not before:

```rust
use tauri_plugin_epicenter_folder::{Author, FolderConfig, FolderExt, ScopeConfig};

tauri::Builder::default()
    .plugin(tauri_plugin_epicenter_folder::init())
    .setup(|app| {
        let todos = resolve_todos_directory(app)?;
        app.folders().register(ScopeConfig {
            scope: "so.epicenter.todos".into(),
            folder: FolderConfig {
                // Keep the identity and the `origin` a person already
                // configured in this directory; `author` is the fallback.
                use_repository_author: true,
                use_repository_origin: true,
                ..FolderConfig::new(
                    todos,
                    Author { name: "Todos".into(), email: "todos@localhost".into() },
                )
            },
            windows: vec!["todos".into()],
        })?;
        Ok(())
    })
```

Grant the windows the plugin's commands in a capability:

```json
{ "windows": ["todos"], "permissions": ["epicenter-folder:default"] }
```

The capability only lets a window call the plugin. Which folder it reaches is
decided by `windows` in `ScopeConfig`. A scope's configuration cannot change
once registered.

`FolderConfig` fields:

| Field | Default | Meaning |
| --- | --- | --- |
| `branch` | `main` | The local branch, and the remote branch when a remote exists. |
| `author` | required | Who commits. With `use_repository_author`, the fallback for whichever of name and email the repository does not configure. |
| `remote` | none | Where to push and fetch. |
| `use_repository_author` | `false` | Read `user.name` and `user.email` when the folder opens. |
| `use_repository_origin` | `false` | Read `remote.origin.url` when the folder opens and use it as the remote. |
| `transport` | none | Where each push and fetch gets a relay URL; see "Relayed transfers". Without one, Git is given the remote's URL. |
| `require_existing_repository` | `false` | Refuse to open a root that is not already a repository (`has_repository`: a real `.git` with `HEAD`, `objects`, and `refs`) instead of initializing one. Checked inside the open, with the lock held. |
| `watch_events` | `true` | Watch filesystem events for changes made outside the owner. |
| `watch_interval` | 2 s | Also compare file sizes and times this often. |
| `page_engine` | `false` | Open no owner: grant the page the directory and run its `git` instead (see "A folder the page opens itself"). Only `root`, `author`, `branch`, and `page_files` then apply. |
| `page_files` | none | For a page-engine folder, the files the page may write, as glob patterns relative to the root. |

The two `use_repository_*` options select author and transfer destination
independently. Neither enables automatic network work. Leaving
`use_repository_origin` off means an `origin` configured in the directory is
never read. A
`remote` given in `FolderConfig` is used either way, and is the fallback when
origin discovery is on and the repository has no `origin`. Both are read once,
inside the open, after the cross-process lock is held and the Git layout is
verified.

## A folder the page opens itself

A scope whose `FolderConfig` sets `page_engine` has no owner. A permitted
window calls `grant_directory(scope)` instead of `attach`;
`@epicenter/folder/tauri` does this first for every scope and attaches only
when the grant answers `UsesOwner`. An `attach` to such a scope is
`UsesPageEngine`. The first grant:

1. creates the root if it is missing and resolves it to its canonical path;
2. takes the same cross-process lock an owner takes (`lock.rs`), held until
   `shutdown`;
3. refuses a `.git`, `.git/epicenter`, or scratch directory linked elsewhere.

Each window's first grant then adds a capability for that window alone
(`directory_capability`): the fs plugin's reading commands
(`DIRECTORY_COMMANDS`) on the root and everything beneath it. The fs scope
resolves every existing path, links included, before matching, so a link in
the folder that points outside it is refused. A grant returns
`{ root, branch, authorName, authorEmail }`; later grants return the same
root.

The page changes files through this crate instead (`write_folder_file`,
`rename_folder_path`, `remove_folder_path`, `make_folder_directory`), because
a scope matches a path that does not exist yet as text, and under a link
that already points elsewhere a new file's path would look like the
folder's. `page_files.rs` checks the whole path on disk first: it must be
under the granted root with no `.` or `..`, and no existing component on the
way may be a link. Then it must be a file the shell declared
(`FolderConfig::page_files`, such as `todos/*.md`) or a directory on the way
to one, with no component that starts with a dot, is a Windows short name
such as `GIT~1`, or is named `HEAD`, so no nested repository can be
assembled; or, inside `.git` (compared case-insensitively), the engine's
staging directory and its private index copies. A declared file is replaced
by a staged copy renamed over it, so a hard link is replaced, not written
through. The page writes no Git object: the engine stores each with
`git hash-object -w`, which names and checks it.
`fixtures/page-file-changes.json` records every change the engine makes in
`@epicenter/folder`'s real-Git tests, and this crate's tests check each.

The page keeps the folder's history with the system `git`, which it asks
this crate to run (`run_git`, stopped by `cancel_git`). `page_git.rs` runs a
command only in a root granted to the calling window, only while that root's
`.git` is its own directory (not a link or a `gitdir:` file), and only when
the arguments are exactly one of the operations the folder engine runs, each
value checked for its kind. Push and fetch reach only the URL
`remote.origin.url` names. Every command runs with `core.hooksPath` naming an
empty directory only this crate writes, fsmonitor off, without the inherited
variables that point Git elsewhere or trace it, and without a terminal
prompt. `GIT_INDEX_FILE` may name only a private index copy in the root's
`.git`. Transfers use the person's own credential helper or SSH.
`fixtures/page-git-calls.json` records every call the engine makes in
`@epicenter/folder`'s real-Git tests, and this crate's tests run the
validator over each.

A shell that registers a page-engine folder must:

- install `tauri-plugin-fs` and set `plugins.fs.requireLiteralLeadingDot` to
  `false`, so `.git` and other dot files inside the granted root are
  reachable;
- list `DIRECTORY_COMMANDS` in the window's capability with no path, so its
  build checks the names; only a grant gives them a directory. No fs
  command that changes files is listed.

Nothing in this crate reads, writes, or records history for such a folder
but these `git` commands. The page's work drains through the host's
departure round before shutdown releases the lock.

## Using a folder from a page

```ts
import { openFolder } from '@epicenter/folder';

// The scope is the folder's ID, which the page names; the definition names none.
const opened = await openFolder({ id: 'so.epicenter.todos', definition });
if (opened.error) return show(opened.error.message);
const folder = opened.data;

folder.location;                // { kind: 'directory', root }, for showing to a person
await folder.tables.todos.create({ stem: 'buy-milk', fields: { title: 'Buy milk', done: false } });
folder.git.subscribe((snapshot) => render(snapshot));
folder.onFilesChanged((paths) => refresh(paths));
const terminal = folder.terminal();
await terminal.exec('git status');
await folder.close();           // detaches this page only
```

`openFolder` returns its refusals: an unknown scope, a window the scope does
not list, a folder another process holds, a shell without this plugin, and a
desktop app built for another protocol version. The unreleased protocol is
version 9: version 5 added the incoming record, `recover_incoming`, and the
refusals a pending update causes, version 6 the optional `expectedSha256` on
`replace`, version 7 removed the save number `apply` named and its
`Superseded` refusal, version 8 added `merge_incoming` with unfinished
merges, and version 9 removed unfinished merges: every conflict is refused
(see [Merging incoming history](#merging-incoming-history)). No command
holds the folder across calls or names a terminal lease.
A page built for a different version is refused at attach. It never opens
browser storage instead. `@epicenter/folder/tauri` is the same opener without the
browser adapter in the build.

## File changes

A read returns `{ bytes, sha256 }`. The owner computes the hash from the bytes
it read. `apply` takes ordered changes, each one of:

| Change | Fields | Lands when |
| --- | --- | --- |
| `create` | `path`, `bytes` | Nothing is at the path. |
| `replace` | `path`, `bytes`, `expectedSha256?` | A file is at the path and, when a hash is named, its bytes hash to it. It never creates a file. |
| `overwrite` | `path`, `bytes` | Always, whether or not a file is there. |
| `remove` | `path`, `expectedSha256?` | The file exists and, when a hash is named, its bytes match. |
| `move` | `from`, `to`, `expectedSha256?` | The source exists, matches a named hash, and nothing is at `to`. |

- No change carries the hash of its new bytes. The owner hashes what it reads
  from the folder and never trusts a hash a page computed for new content.
- A `replace`, `remove`, or `move` without `expectedSha256` is a deliberate
  unguarded operation on whatever file is there, as a shell or a table caller
  with no baseline acts. It still requires that file. Changes built from a
  read name the hash.
- `Conflict` is `{ path, expectedSha256, actualSha256 }`: the bytes differ from
  the named hash. `actualSha256` is `null` when a guarded `replace` target is
  missing.
- `Exists` is `{ path }`: a `create` target or a `move` destination already
  holds a file.
- A missing unguarded `replace` target, and a missing `remove` or `move`
  source, is `NotFound`.
- Paths are literal. A filesystem that folds case or normalizes Unicode, as
  APFS and NTFS do, can resolve `note.md` to an existing `Note.md`, or
  `dir/` to an existing `Dir/`. Every change refuses such a spelling, of
  the path or of a directory on the way, before writing anything:
  `InvalidPath` names the existing spelling, and a `create` target or
  `move` destination that is one is `Exists`. A read of such a spelling is
  `NotFound`: no file has that name. Where the filesystem holds both names,
  each is its own file.
- Nothing orders batches by when a page asked for them. See
  [Locking and ordering](#locking-and-ordering).
- The steps reported in a partial batch are `write`, `remove`, and `move`:
  they say what landed, not which kind of change asked for it.

A fast-forward publishes through the same changes: `create` for an added path,
`replace` and a guarded `remove` conditional on the committed bytes. It never
removes or replaces a file without that guard, and refuses before writing
anything if it cannot name one.

## Merging incoming history

`merge_incoming(session, allowUnrelatedHistories, versions)` merges the
already fetched remote head. A branch that is behind fast-forwards; one that
is ahead or equal changes nothing; a diverged one with exactly one merge base
is merged, under the same admission, record, and recovery as a fast-forward. Root `kv.json` changed on both sides merges by key
(`kv_merge`); every other file follows Git's rules, with `git merge-file` for
a file both sides changed. The same paths are refused as in
`@epicenter/folder`'s browser merge: a file whose versions are not all UTF-8
text the browser's line merge keeps is a `binary` conflict, a link,
executable, or submodule among a two-sided change's versions or a `merge`
attribute other than Git's text merge is `Unmergeable`, and several merge
bases are `UnsupportedHistory`.

A conflict writes no file, index entry, ref, or merge state: `MergeError`
`Conflicted` with one entry per reason. This folder never leaves a merge for
a person to finish. Otherwise the merge commit's parents are the head and the
fetched commit, and it is published like a fast-forward:
`{ status: 'merged', from, to, fetched, changedPaths }`.

The two booleans are optional and `false` when absent.

- **`allowUnrelatedHistories`** merges histories with no common commit over
  an empty base, as `git merge --allow-unrelated-histories` does: both heads
  are the merge commit's parents, so both roots stay in history. A path both
  sides hold with different bytes conflicts. Without it such histories are
  `UnsupportedHistory` with `bases: 0` and nothing is written.
- **`versions`** makes a refused `Conflicted` carry, for each conflicted path
  that is not a `shape` conflict, `{ path, ours, theirs }`: the exact committed
  bytes at the pinned head and the pinned fetched commit, `null` where that
  side has no file. Otherwise `versions` is `null`. The snapshot's
  `lastMerge` always records it as `null`, so file bytes are not sent to
  every window with each snapshot.

- **A Git merge a person began** outside Epicenter, while `MERGE_HEAD`
  exists or the index holds unmerged stages, blocks whole-folder commits,
  staged commits, fast-forwards, merges, and recovery,
  as a rebase in progress or a detached HEAD does: `CommitOutcome` `blocked`,
  `PullError` `Blocked`, `GitError` `Failed` for a staged commit, and
  `RecoveryRefused` for recovery, each with the reason "a Git merge is in
  progress; finish or abort it with Git outside Epicenter". Nothing is
  written; saves, fetches, and staging continue.
- **Every staged commit** pins its parent before construction and moves the
  branch only if it still names it. Git writes the tree from a private index
  copy, excluding intent-to-add placeholders while preserving staged empty
  files, modes, and deletions. A concurrent branch move reports
  `BranchMoved { expected, actual }` and leaves the live index unchanged.
  Built-in commits run no commit hooks and are unsigned.

## Incoming updates and their recovery

A fast-forward changes files, then the index, then the branch, and a process
can stop between any two (ADR-0474). Before it changes anything, it pins its
before and after commits under `refs/epicenter/incoming/<operationId>/` and
writes one record, `.git/epicenter/incoming.json`, holding exactly
`operationId`, `branch`, `expectedHead` (`null` for an empty history), and
`nextHead`, which for a merge is the merge commit. A record holding any
other field, such as the `merge` an earlier build wrote for a merge it left
unfinished, is `unreadable`. The record is written to a scratch name,
flushed, and renamed into place. Every path, byte, and index entry is derived from the two pinned trees,
so a later fetch that moves the tracking ref, or a garbage collection, cannot
take the target away. Ordinary saves keep no record.

- **While a record exists**, saves and fetches carry on. Commits, staging,
  staged commits, and new fast-forwards are refused:
  `CommitOutcome` `blocked`, `GitError` `IncomingPending`, and `PullError`
  `IncomingPending`. The snapshot's `pendingIncoming` reports it: `recorded`
  with the four fields, or `unreadable` with the exact reason a record could
  not be read. Opening the folder and `status` read it and never resume it.
- **`recover_incoming`** runs only when asked, under the file gate and the
  Git lock, and reads everything again:
  - nothing pending: `{ status: 'none' }`;
  - the branch already names `nextHead`: the record and pins go, no file is
    written, and later edits stay: `{ status: 'cleared', pending }`;
  - otherwise each changed path must hold its before or its after state, the
    index must hold nothing staged but the update's own entries, and the
    branch must still name `expectedHead`. Paths still at their before state
    are written, removals first, each conditional on the bytes it was found
    with; every path is checked for its after state; the index is written
    through Git's lock; the branch moves by compare-and-swap; then the record
    goes, then its pins: `{ status: 'completed', pending, changedPaths }`,
    where `changedPaths` are the paths this recovery wrote or removed.
  - Recovery looks only at the paths the update changes. Files edited while
    it was pending stay as they are, so after `cleared` or `completed` the
    files observation is marked stale and a real status follows; nothing is
    reported clean that was not looked at.
- **What stops it** keeps the record and writes nothing, or reports what it
  wrote. `RecoveryRefused { pending, paths, reason }` names third bytes, a
  missing file, an empty file where a nonempty one is added (that is not
  absence), a file or directory in the way, a foreign or mixed index entry,
  an unreadable index, a moved branch, HEAD off the branch, a Git operation
  or merge in progress, an unreadable record, or a missing pinned commit.
  `Partial`, `IndexFailed`, `BranchMoved`, and `Unconfirmed { applied, uncertain, error }` say what landed and what is
  unknown; the record stays, and nothing infers that a step did not happen.
- **Files and directories trade places.** A removal goes first, so a file can
  become a directory. Where a file must go and a directory is, the before
  tree says which directories are Git's: those, emptied by the update's
  removals now or by an earlier attempt, are removed deepest first. Any
  other file or directory there, even an empty one, stops the update before
  it writes, and no other directory is pruned.
- A fast-forward whose first look finds a path in neither state, before it
  writes anything, withdraws its record and pins and reports `Dirty`,
  `Collision`, `StagedChanges`, or `BranchMoved` as before. Once it has
  written, it stops like a recovery and keeps its record.
- When the branch moved but could not be read back, or moved and its record
  could not be removed, the fast-forward or recovery is reported as
  published, because the branch did move, and the snapshot still reports
  the record. A later recovery finds the branch at the target and clears it
  without writing a file.

## Lifetimes

- **The owner** opens on a scope's first attach and stays open until the app
  exits or the shell calls `app.folders().shutdown()`. Shutdown refuses new
  work, lets admitted saves and commits already inside the folder finish,
  cancels pushes and fetches, and releases the lock. It commits nothing of its
  own: a save stays saved and uncommitted until a commit is asked for. A commit or fast-forward still
  waiting for the folder when shutdown begins is refused as closed.
- **A session** belongs to the window that attached it. Another window that
  names it is denied. A session ends on `detach`, when its page reloads, and
  when its window is destroyed. Ending a session never cancels a save, a
  commit, or a push or fetch the owner already started, and never affects
  another window. It withdraws the session's pushes and fetches that the
  owner had not started.
- **`folder.close()`** in a page refuses that page's new file, Git, and
  terminal calls without invoking anything, stops waiting for its pushes and
  fetches and withdraws them, waits for the Git calls it already sent, and
  then detaches. It does not wait for file calls already sent: one the
  owner admitted before the detach still lands and replies to its caller,
  and one that arrives after it is denied and writes nothing. A save that
  was called but not yet sent is refused as closed. A terminal command
  running then sends no later step. Close commits nothing. A page that needs
  its saves settled first awaits them, or flushes its row editors, before
  closing.
- **A terminal command** holds nothing. Each of its steps is an ordinary
  command of its session, so other windows' saves land between its steps. A
  rewrite of a file the command read names the hash it read and is
  refused as a `Conflict` if the file changed since. A command that stops
  partway leaves its earlier steps landed.

Each webview keeps its own lifecycle identity in its resource table. The plugin
holds a weak index so it can end sessions after Tauri removes a destroyed
window from its manager. A retained handle to the old webview cannot attach to
or end the sessions of a replacement that reuses its label. Reload cleanup
removes only ended sessions, so an attachment from the new page survives it.

## Locking and ordering

- **Across processes.** The owner holds an exclusive SQLite transaction on
  `.<directory>.epicenter-lock` beside the directory, the same file and
  mechanism the Bun hosts use, so only one process owns a folder. The system
  releases it when the process ends, however it ends. It is unreliable on
  some network filesystems.
- **The file gate** admits one publication at a time: an `apply` batch, a
  directory change, or a fast-forward's file changes. It is held for that
  one publication and never across commands.
- **Saves are last landed wins.** A save can finish hashing or reading after
  a save asked for later, can reach the plugin late, can be delivered twice
  by Tauri's IPC fallback, and can wait for a worker before it reaches the
  gate, which is not first come, first served. The owner does not order
  saves by when they were asked for and does not recognize a second
  delivery: whichever lands last on a path stays, from any page or window.
  Each change's own condition still holds when it lands: a `create` finds
  an occupied path, a `replace` never recreates a removed file, and a
  guarded change is refused as `Conflict` when the bytes moved since the
  read it names. A page that keeps one editor's saves in order runs one at
  a time, as `@epicenter/folder`'s row editor does.
- A save the plugin took before its session ended still lands; one that
  arrives after the session ended is denied and writes nothing. Two scopes
  cannot hold one root at once, since the second cannot take its lock.
- **The Git lock** orders commits, staging, and ref updates.
- Pushes and fetches run outside both. A transport in flight delays no save
  and no commit.
- A commit takes the file gate and then the Git lock. Under both it pins the
  branch head and hard-links the folder into a snapshot. It then releases the
  file gate and, still under the Git lock, hashes the snapshot and moves the
  branch with a compare-and-swap. A save never waits for hashing.
- An explicit commit, fast-forward, or status waits for the file gate. With
  the gate held, a commit or fast-forward tries the Git lock. If it is busy it gives the gate back,
  waits for the Git lock to be released, and starts over, so it reads the
  folder as it is once it holds both.
- Nothing waits for the Git lock while holding the file gate, and nothing
  takes the file gate while holding the Git lock.

## Commits

A save never asks for a commit (ADR-0529). An explicit `commit` waits for the file gate and then the Git lock, reads it once it holds both
locks, and replies with what it did. It never pushes; `commitAndPush` in a
page sends the push as its own command, and only while that caller is still
waiting.

## Pushes and fetches

The owner runs one push at a time and one fetch at a time. A request that
arrives while one is running waits, and every request that arrives during
that run shares the one that follows it. Receiving a command is not starting
its transport: the owner starts a waiting push or fetch only when the running
one has finished, and until that moment its callers can withdraw.

A page asks in two steps. `open_request` registers a request in the page's
session and returns its number; `push` or `fetch` then names it. Because the
owner knows the request before any command names it, `withdraw_request` can
never arrive too early to matter.

- A page asks for nothing on behalf of a caller whose signal has already
  aborted.
- Withdrawing a request, or ending its session, removes that caller from the
  waiting push or fetch. If no other caller is waiting for it, it never
  starts. Other callers sharing it keep it, and it runs once for them.
- A `push` or `fetch` naming a request that was withdrawn, has finished, or
  was never opened by that session is refused and starts nothing. A request
  serves one command; a second command naming it is refused.
- A transport the owner has already started is the owner's. Withdrawing its
  request, or ending its session, does not stop it, and it runs to its end.
- A request belongs to the session that opened it. Another window cannot use
  or withdraw it, even with the number.
- Pushes and fetches are ordered separately. A request is withdrawn from each
  in turn, and a waiting push or fetch is told it was withdrawn only by the
  step that also takes it out of its own queue. It is never told so while it
  can still start.
- A page whose caller left is told `stoppedWaiting` at once. That says the
  caller stopped waiting; whether the transport had started is not known to
  the page at that moment.
- Shutdown stops the running push and fetch and settles the waiting ones as
  cancelled or closed without running them.

### Relayed transfers

A shell can give a folder a `transport` (`transport.rs`). Each push or fetch
then asks it for a `Relay` for one service against the remote captured at
opening: an ephemeral URL Git talks to instead of the remote, and the way to
retire it. The remote stays the folder's canonical destination in `origin` and
in the snapshot; the relay URL is stored nowhere. A transport that refuses
fails that transfer before Git starts and changes nothing else.

A relayed transfer runs with fixed controls: `core.hooksPath` names no
directory, `core.fsmonitor` is off, automatic maintenance and garbage
collection are off, proxies are cleared in configuration and environment, the
relay URL rewrites to itself so no `insteadOf` or `pushInsteadOf` can send Git
elsewhere, and only HTTP is allowed, in tests as in production. A cancel
retires the relay before Git is stopped; failure and completion retire it too,
and a failure reports what the transport saw. Retirement that reports anything
means the transport could not confirm the transfer, so a push Git completed is
`Unconfirmed` (it may have landed; nothing is undone or retried) and a fetch
is an error, its tracking ref left as Git wrote it. A rewrite rule that matches the
whole relay URL would tie with the pin and win, because repository
configuration is read before command-line configuration; a relay URL carries a
token minted for that transfer, so no rule written beforehand can name it.

A relay URL is a capability while the relay lives. It is in Git's argument
list and nowhere else: inherited `GIT_TRACE*` and `GIT_CURL_VERBOSE` are
removed and trace2 is switched off, so no trace file records it; Git's output
is redacted before anything reads it (the URL becomes the canonical remote,
and its path or token becomes `[relay]`), so an error that echoes the relay
keeps its diagnostic and loses the capability; and `Relay`'s `Debug` prints
neither.

Transfer tests reach a loopback `git http-backend` (`testing::GitHttp`)
through this exact transport. Where an environment refuses listeners they
print `SKIPPED` and return; set `EPICENTER_REQUIRE_LOOPBACK=1` to make that a
failure. Control construction, the HTTP-only refusal, cancel ordering, and
redaction of a real Git diagnostic need no listener.

### First downloads

`download::download` fetches a remote's `main` into a dot-prefixed sibling of
an absent destination, under the destination's sibling lock, and publishes it
with a rename that refuses anything already there. It writes each blob's exact
bytes instead of checking out, so no filter, conversion, or hook runs; a tree
an incoming update would refuse (links, executables, attribute conversions,
invalid paths, case collisions) is refused here too. A repository that
advertises no ref at all gives an unborn `main`; one with any other branch or
tag but no `main` is refused with its refs named, and the staging folder, with
`origin` set, is kept. This promise is narrower than the browser folder's
download, which can start `main` beside other refs. It records `origin` before
any transfer, lets the caller bind the staged folder, and retires the relay
before publishing: a retirement that reports anything keeps staging and
publishes nothing. Cancellation is checked again at the rename and just after
it; a cancel that lands with the rename leaves the folder in place and returns
`Interrupted`, never success. A failure after history arrived keeps the
staging directory and names it. Publication uses `renamex_np(RENAME_EXCL)` on Apple platforms and
`renameat2(RENAME_NOREPLACE)` on Linux; other platforms refuse before reserving
anything.

## Noticing outside changes

The owner watches filesystem events and also compares sizes and times every
`watch_interval`. An event makes the owner look at the path it names even when
its size and time are unchanged. Events inside `.git` are ignored except
`HEAD`, the index, and refs, which make the owner check whether history moved.

An event cannot say who wrote the file, so the owner reports every announced
path, its own writes included. A window may therefore hear `filesChanged` for
a file it just saved, and the Git snapshot's file observation turns stale
until the next status or commit. A report requests no scan and no commit, so
the owner's own events do not feed themselves, and a change made outside the
app is never committed until a save or an explicit commit includes it. The periodic
comparison does know the owner's writes and stays quiet about them.

Where the platform cannot watch the directory, the owner
logs a warning, reports it through `FolderOwner::watch_diagnostic`, and relies
on the periodic comparison, which cannot see an edit that restores size and
time.

## What is best effort

- A `replace` checks that a file is there and, when `expectedSha256` is named,
  that its bytes hash to it, once before staging and again before it
  publishes. On macOS, iOS, Linux, and Android it publishes by exchanging the
  staged file with the file at the path (`renamex_np(RENAME_SWAP)`,
  `renameat2(RENAME_EXCHANGE)`), which fails when the file is gone, so a
  removal at any point is `NotFound` (or `Conflict`) and is never undone. A
  filesystem there that cannot exchange is an `Io` failure; nothing falls
  back to a rename. Another program's write between the second check and the
  exchange is still displaced. The exchange is the only operation on the
  path: a displaced entry that is not a regular file, or cannot be
  inspected, stays in `.git/epicenter/scratch`, and the save is `Partial`
  with its write both applied and failed and an `Io` error naming where the
  entry is. An incoming update that stops this way reports `Partial` and
  keeps its record. Windows, and any other target without an exchange, has
  no replacement until a mechanism that requires the file at publication is
  proven: a `replace` there is an `Io` failure naming the platform, the
  staged copy is removed, and this operation does not change the destination.
  The caller keeps its bytes; nothing retries. Creation, reads,
  overwrites, moves, and removals are unchanged by this repair; none is
  verified on Windows. Whether
  this crate builds or runs on Windows has not been checked. The owner
  orders its own windows; it does not lock files against other programs.
- A `remove` or `move` source check is the same: another program can change
  the source between the check and the step. A guarded `move` that reports
  its destination landed names the hash it was guarded by, which says what
  the source held when checked, not what `to` holds afterward.
- A multi-file batch is ordered steps. A failure partway reports which steps
  landed; nothing is rolled back.
- A snapshot is exact against the owner's own writes, which replace files by
  rename or link. A program that edits a file in place can change bytes a
  snapshot links to while it is being hashed.
- A fast-forward or recovery checks every path before it writes and each
  write's own condition again, but another program can still write between
  a check and a rename. Its record keeps a stopped update from being
  committed as a mixed tree; it does not make the transition atomic.
- A commit whose compare-and-swap lost to another Git process is reported as
  `branchMoved` and is not retried. A commit whose branch update landed is
  reported as committed even if the owner could not read the branch back
  afterward; the observation is marked stale instead.
- An outcome the owner or the transport could not confirm is reported as
  `Unconfirmed` and is never retried. Look at the folder before trying again.
- File bytes cross IPC as JSON number arrays. That is acceptable for Markdown
  and slow for large audio saves.

## Commands

```sh
# from this directory
cargo test --offline --workspace          # core and plugin, real Git, mock Tauri runtime
FOLDER_WRITE_BINDINGS=1 cargo test --offline -p tauri-plugin-epicenter-folder bindings
                                          # rewrite ../folder/src/native/bindings.gen.ts

# from packages/folder
bun run gen:vectors                       # rewrite this crate's fixtures/commit-subjects.txt
bun test src/git/commit-subjects.test.ts  # the fixture matches commitSubject
bun test --isolate src/tauri.test.ts
EPICENTER_FOLDER_BRIDGE=1 bun test --isolate src/tauri-native.test.ts
```

The last command runs the TypeScript adapter against the real Rust owner
through Tauri's invoke handler.

Fast-forward pulls refuse incoming filter and byte-normalizing attributes before
writing files or advancing the branch. The check reads the pinned incoming
revision, including nested `.gitattributes`, rather than the working copy. Pull
requires Git with `check-attr --source` support; an unsupported
option fails the pull before publication. Pointer-looking text with no declared
filter remains an ordinary file. This does not add Git LFS support.
