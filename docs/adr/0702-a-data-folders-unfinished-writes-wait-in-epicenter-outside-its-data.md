# 0702. A data folder's unfinished writes wait in `.epicenter`, outside its data

- **Status:** Superseded
- **Date:** 2026-11-01
- **Superseded by:** [ADR-0899](0899-the-folder-sync-product-is-retired.md): the folder sync product is retired, and this record is its history.
- **Amends:** [ADR-0551](0551-every-write-to-a-folder-file-is-one-save-that-merges-by-the-files-kind-and-sync-settles-with-the-same-merge.md) at step 1's "swap on that hash" for a desktop folder: the check runs right before an atomic rename with no lock held, and a new file is placed instead of renamed; [ADR-0562](0562-the-cli-and-the-shell-take-turns-writing-a-folder-under-one-save-lock.md) at its save lock and its amendments of 2026-10-31 and 2026-11-01: no save lock, `.epicenter` holds only `saves/` and `recordings/`, and a new file is placed; [ADR-0568](0568-a-folder-takes-every-writer-in-turn-under-its-save-lock-and-refuses-none.md) at every writer taking turns under the save lock, and its amendments of 2026-10-31 and 2026-11-01: no writer takes a lock; [ADR-0543](0543-a-recording-streams-into-its-folder-from-the-moment-it-starts.md) at where a desktop recording is written while it records and how it reaches its path, and its amendments of 2026-11-01 on `.epicenter`, the root, and what `stop` and `recoverRecordings` answer.
- **Relates:** [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) (the file contract, whose `over` is the version a write names); [ADR-0494](0494-file-folders-reserve-epicenter-for-rebuildable-caches.md) (folder queries, which write nothing under `.epicenter/`).

## Context

Thirteen amendments dated 2026-10-31 and 2026-11-01, on ADR-0562, ADR-0568,
and ADR-0543, described how a desktop writes a data folder, each correcting
the one before:

- ADR-0562 and ADR-0568 had every writer take turns under one save lock, an
  exclusive SQLite transaction: first `.<name>.epicenter-save-lock` beside the
  folder, then (`1e66c2134b`) `<root>/.epicenter/save-lock`, with staged saves
  in `<root>/.epicenter/scratch` and `epicenter sync` holding the lock across
  its merge.
- ADR-0543's first amendment wrote a desktop recording in progress to
  `.epicenter/recording/<path>.wav`.
- Name checks kept `.epicenter` out: listings skipped it (`isOwnDirectory`),
  watchers dropped it, and admission refused it (`check_namespace`).

The lock kept only Epicenter's own programs from overwriting each other. An
external editor, a script, an agent, and `git` never took it, and it cost a
cross-process lock in Rust and in Bun and a sync round that waited on apps.
The lock was deleted (`7240db4fe7`), and the layout, the hidden-path rule,
sync's exclusion, and placement followed in separate commits, each recorded
as another amendment.

## Decision

**A data folder's files are its data, and a path with a hidden segment is
not.** A note is a `.md` file; every other file that is not hidden is stored
with Git LFS (`storedWithLfs` in `@epicenter/definition/contract`). A hidden
path has a segment starting with `.` (`isHiddenPath`, and
`paths::is_hidden_path` in the folder core, both held to
`packages/tauri-plugin-epicenter-folder/fixtures/path-rules.json`). It is the
only rule for what is not data:

- A contract cannot name one: a path template refuses a hidden segment, and
  `checkContract` skips hidden paths.
- No watcher reports a change under one: the folder plugin's `watch.rs`,
  Bun's `native/watch.ts`, and `epicenter sync --watch`.
- Listings still list hidden files, leaving out only `.git` at the root
  (`storage::list`, and Bun's `device/node-store.ts`); whoever reads a
  listing skips them.
- `epicenter sync` commits a hidden path when Git's rules let it, as it
  commits `.gitattributes` and `.gitignore`, and never commits `.epicenter`.

**A data folder can be any directory, except inside a `.git` or `.epicenter`
directory, which belong to Git and to Epicenter.** The Epicenter app, before
it sets a folder up for sync (`admission::check_sync_directory`), and an app
window, before it opens a root (`scope::Refusals` in the folder plugin),
refuse a directory when any segment of its canonical path is `.git` or
`state::DIRECTORY`, in any case (`admission::is_reserved_directory`), and
`epicenter init` and `epicenter clone` refuse by the same rule before they
make anything (`isReservedDirectory` in the CLI, with `STATE_DIRECTORY`;
`fixtures/reserved-directories.json` holds both languages to it): a disk
that ignores case keeps a directory made as `.GIT` under that name, and Git
takes it for its own. `x/.git/y` and `x/.epicenter/recordings/y` are refused;
`~/.notes` is a folder. This names where a folder's root cannot be, not what
inside a folder is data, which the hidden-path rule alone decides. The
Epicenter app's checks that a folder is not inside, equal to, or holding its
application data or the library root (`~/Epicenter`), and `epicenter init`'s
refusal of a folder inside another repository, stay.

**State that is not data lives where its lifetime puts it.**

| State | Lives in |
| --- | --- |
| The folder's data | its paths that are not hidden |
| History and sync's coordination (`epicenter-sync.lock`, `refs/epicenter/last-seen`) | `.git/` |
| Unfinished writes | `.epicenter/` at the folder's root |
| This computer's settings and file-system grants | the app's AppData root (`settings.md`, `.persisted-scope`) |
| Secrets | the keychain |

**`.epicenter/` holds only unfinished writes, one part per operation.** A file
there finishes at its real path, or the next open recovers or removes it.

```txt
<root>/.epicenter/
├── saves/        a save's bytes before their rename; always safe to delete
│                 when no app runs
└── recordings/   a desktop recording from its first sample, at its own path
                  (<stem>.webm), until stop or recovery; may hold audio until
                  the app opens once
```

- One module per language spells the layout:
  `packages/tauri-plugin-epicenter-folder/core/src/state.rs` and
  `packages/folder/src/state.ts` (`STATE_DIRECTORY`, `savesDirectory`; only
  the shell writes `recordings/`). Both, and the OPFS worker's inlined copy, are held to
  `packages/tauri-plugin-epicenter-folder/fixtures/state-layout.json`, and
  `bun run check:state-paths` (`scripts/check-state-paths.ts`) fails when
  other production code spells `.epicenter`. A new kind of unfinished write
  gets its own part there, never from its caller.
- On Unix, before anything is staged, the desktop shell makes `.epicenter`
  and `saves/`, or tightens them, to `0700`, and creates each staged file
  with `create_new` at `0600` (`make_private` and `create_scratch` in the
  folder core's `storage.rs`). An inheritable access control entry on the
  person's folder is kept: it is a grant they chose, files other programs
  make there inherit it, and Epicenter's inherit it too. Either directory is
  refused when it is a link or not a directory. The Bun store makes them
  `0700` and stages at `0600` when it creates them, and neither tightens nor
  refuses one already there.
- A recording's file is created with `create_new` under `recordings/`, so
  nothing already at its name is written through.
- The desktop shell's open removes, from `saves/` alone, regular files with
  a stager's scratch name more than an hour old (`storage::sweep_scratch`).
  The Bun store sweeps nothing; it names its saves in the same grammar
  (`scratchName` in `packages/folder/src/state.ts`), so what a stopped Bun
  process left goes at the shell's next open. Nothing sweeps `recordings/`;
  only `recoverRecordings` finishes what a quit or a crash left there.
- `epicenter init` writes `.epicenter/` into `.gitignore` (`REPOSITORY_IGNORE`),
  and `epicenter sync` excludes it itself, whatever `.gitignore` says: `git add`,
  `git diff --cached`, and `git commit` take
  `-- . ':(exclude,glob)**/.epicenter/**'` with `GIT_LITERAL_PATHSPECS=0`
  (`COMMITTED` and `MAGIC` in `packages/cli/src/sync/sync.ts`). The glob
  matches `.epicenter` at any depth, as the `.gitignore` line does. The literal
  `:(exclude).epicenter` is not used because `git add` fails on an exclusion
  that names an ignored path literally. The variable is set to `0` because
  sync runs its other commands with literal pathspecs, under which Git reads
  no pathspec magic.
- In a browser the OPFS worker stages a new file in `.epicenter/saves/` of the
  origin's private files and moves it to its path.

**Every write names the version it read, and the store checks it right before
the write lands. Within one process, writes to one path take turns, and a
create lands only where nothing is; across processes, a replacement's
check-to-rename gap is accepted.** A version is the SHA-256 of a
file's bytes on a device and the Git blob id on `main` in a repository. A
write expects `absent` for a create or the version it read (`{ sha256 }`),
and nothing else (`DeviceExpectation` in `packages/folder/src/device/store.ts`
and `Expectation` in the folder core's `storage.rs`): there is no unconditional write, and an
existing name only some disks hold is replaced or removed over its version
like any other. A store answers `stale` when the file no longer matches, and
the client answers `Conflict { current }`.

| Store | Check, then land |
| --- | --- |
| Desktop folder, replacing or removing a file (`storage::put`, Bun's `device/node-store.ts`) | stage in `.epicenter/saves`; taking the path's turn in this process, check the path, rename over it or remove it |
| Desktop folder, a new file (the shell and Bun) | stage; taking the path's turn, place by an exclusive rename in the shell (`storage::place`) and a hard link in Bun (`place` in `device/node-store.ts`) |
| Browser (OPFS) | one Worker, holding a Web Lock named for the path (`epicenter-device:<path>`) across the check and the write |
| Repository (`openRemote`) | read, compare with `over`, send the write with that base; the server settles it against `main` and moves `main` by compare-and-swap |

Within one process, a desktop path's writes take turns from the check to the
rename or removal: a per-path queue in Bun (`createPathTurns`, used by
`device/node-store.ts`) and a per-path turn in the shell (`Turn` in the folder
core's `storage.rs`), each held only across the check and the change and
gone once the path is idle. It costs nothing across processes and makes the
check exact within one: of two writers over one version, one lands and the
other is `stale`. The save lock this replaces gave the same turns inside a
process (`lockTurns`); without them, two Vocab adds of one word both landed,
and a note edit and a stage change over one version replaced each other.
Across processes nothing holds a desktop path between a replacement's check
and its rename. Another program's save landing in that instant can be
replaced, and Git history is the backstop: what `epicenter sync` committed
stays in history. No writer takes a save lock, `epicenter sync` included.

**One function places a staged file only where nothing is.**
`storage::place` in the folder core renames the staged file to the target by
a rename the system refuses when any entry has the name: `renamex_np` with
`RENAME_EXCL` on macOS, `renameat2` with `RENAME_NOREPLACE` on Linux,
`MoveFileExW` without `MOVEFILE_REPLACE_EXISTING` on Windows. A crash leaves
the file at one name, staged or placed. Where the disk refuses that rename
(exFAT on macOS, a file system without the flag on Linux) or the platform has
none, it makes a hard link at the target, which
the system also refuses when the name is taken, then removes the staged name;
a link a cut-off placement already made is the same file at both names and
counts as placed. Where the disk has no hard links either (exFAT on macOS has
neither), the file is renamed only while nothing is at the target. `put` uses it for a
write expecting `absent`, answering `stale` when something appeared after the
check, and the recorder uses it for every recording it places. The Bun store
places a new file by the hard link, as `node:fs` has no exclusive rename, so
of writers creating one path, in one process or several, exactly one lands.

A file that ever had a second name is one macOS's FSEvents never reports
deleting, so a note the shell created by a hard link and another program
then deleted would stay listed; that is why the shell renames. A note the
Bun store created has the same limit; that host serves the CLI and scripts,
and `epicenter sync` stages the deletion on its next round.

**A save across a mount point fails.** A target on another file system than
`.epicenter` (a mount point inside the folder) is one no rename or hard link
from `saves/` reaches (`EXDEV`). The save fails saying it cannot save across a
mount point (`storage::rename_failure`, and the Bun store), and nothing is
copied.

**The desktop shell is the strict folder host; the Bun store is plain.**
The folder core's `storage.rs` walks each path literally: it refuses a path
through a link, a name stored under another spelling on a disk that ignores
case, and a file where a directory should be, and its vectors
(`packages/tauri-plugin-epicenter-folder/core/src/storage_outcomes.json`)
are its own tests. The Bun store
(`device/node-store.ts`), which serves `epicenter check` and `epicenter
format`, scripts, and tests, keeps only what this decision needs of every
host: the version check on every write, the exclusive create, the per-path
turns, staging in `.epicenter/saves`, the mount point refusal, the path rule
(`pathProblem`, never making a nonportable name), and listings that leave
hidden files to their reader. It writes only paths it listed or a contract
made, so the shell's edge cases do not reach it.

**A desktop root is always an absolute path.** `openDevice(contract, { path,
create? })` from `@epicenter/folder/tauri` requires `path`, and the shell's
`open_folder` refuses a relative one (`Refused`). Every command of the folder,
recorder, and transcription plugins takes the root `open_folder` answered
(`rootOf(device)`); none falls back to the window's own directory. So a
folder's `.epicenter` is always at that folder's root.

**A desktop recording is Opus in WebM from its first sample: in
`.epicenter/recordings` until it stops, at its path after.**

- `startRecording({ device, path })` refuses when `<path>.webm` exists, then
  creates `.epicenter/recordings/<path>.webm` before the microphone opens.
  The shell encodes each 20 ms as it is captured and writes the file a
  second at a time: each one-second Cluster is held in memory until it is
  whole, then written with its size in one write, so the file is always
  whole seconds and nothing in it is written back while it records. Its
  length (the Segment's size, the Duration, the Cues) stays unstated.
- `stop` finishes the file in place (the last second, its padding trimmed,
  the Cues, the Duration, and last the Segment's size, flushed to the disk
  first, so a stated size marks a finished file), places it at
  `<path>.webm` without replacing anything there, and answers
  `{ path, durationMs }`. This is the same few milliseconds for a recording
  of any length: nothing is encoded at Stop. A file it cannot place stays
  in `.epicenter/recordings`, and `stop` says why and where it is kept.
  `start` answers no path.
- A quit or a crash loses at most the second held in memory and the
  encoder's 6.5 ms lookahead. `recoverRecordings({ device, under })` is the
  gate: a page runs it when it opens its folder, before it lists, plays, or
  transcribes a recording, because a cut-off file reads wrong (no length in
  a player, a torn block in the transcription decoder) until it is
  finished. It finishes each leftover under `.epicenter/recordings/<under>`
  from its whole seconds, dropping a torn one at its end, and places it as
  `stop` does; a file whose Segment states its size is left as it is, so a
  second run writes nothing. A whole recording is never deleted by
  inference: a leftover whose path holds another file stays pending,
  finished, and is never placed beside it, because nothing can tell that
  file is this recording rather than another one that took its path (a
  move cut off between linking the path and removing the pending name is
  the same file at both, one device and inode, which `storage::place`
  finishes and counts as placed). A leftover holding no whole second holds
  no audio and is deleted. It answers `recovered`, `{ path, durationMs }`
  for each placed, from the length its file states, and `unplaced`,
  `{ path, pending }` for each left pending, on every run until a person
  moves one of the two; an app says where that audio is (Whispering's
  start does), at `pending` under `.epicenter/recordings`.
- A disk that fills ends the capture (`storageFailed`): the second that did
  not fit is cut back off the file, and `stop` finishes what reached it, or,
  when even that does not fit, says so and leaves the file for recovery.
- In a browser, `@epicenter/recorder/browser` appends each MediaRecorder piece
  to `<path>.m4a` or `<path>.webm` in the origin's private files, and
  `recoverRecordings` cuts a file a closed tab left back to its last whole
  piece and answers every recording no tab is writing, cut or already whole.

**Every protection of a data folder passes one test:**

> Protect what a person would notice losing in ordinary use. Accept small,
> rare losses at the edges (a crash, two writers in the same instant, quitting
> mid-keystroke), especially where Git history or the next open already
> recovers them. A protection that guards only an edge case must cost very
> little.

The save lock failed it: it guarded only Epicenter's own programs writing one
file in the same instant, and cost a cross-process lock in Rust and in Bun and
a sync round that waited on apps. The per-path turns within one process pass
it: they cost nothing across processes, and without them two Vocab adds of
one word both landed.

## Consequences

- No cross-process lock guards a save: the folder plugin's `lock.rs`, its
  `rusqlite` dependency, and Bun's `holdingSaveLock` are gone. The CLI keeps
  one file lock (`packages/cli/src/file-lock.ts`) for sign-in refreshes and
  for one sync round at a time per repository.
- Two writers in different processes replacing one file in the same instant
  can both land, the later replacing the earlier, whether both are
  Epicenter's or one is an editor. Within one process they take turns, and
  the second is `stale`.
- A new file never replaces one that appeared after its check, in the shell
  or in Bun, whoever made it.
- A file below a mount point inside a folder cannot be saved.
- On Windows, `.epicenter` and `saves/` have the access their parent passes
  on, and a placement cut off between its link and its removal is not
  recognized as placed: `place` answers that the path is taken.
- A Bun process saving through a link, onto a case variant of a name, or
  into an `.epicenter` another account can read is not refused, and its
  stopped saves wait for the desktop shell's next open to be swept.
- Folders written before these changes are not migrated: an old `scratch/`,
  `recording/`, or `save-lock` stays where it is, and nothing recovers a WAV
  left in `.epicenter/recording/`.
- Deleting `.epicenter` while no app runs can lose a cut-off recording;
  deleting `saves/` alone loses nothing.
- `epicenter sync` never commits a half-written recording, and its watch is
  not woken by a recording's writes, about once a second.
- A desktop recording costs its CPU while it records (about half a second of
  one core a minute of audio) instead of at Stop, and a crash loses up to
  about a second where a WAV lost at most its last buffered quarter second.
  There is no WAV to fall back on: an encoder that cannot start fails the
  recording at Start.

## Considered alternatives

- **Keep the save lock** (ADR-0562, ADR-0568): only Epicenter's own programs
  took it, so it kept a promise that editors, scripts, agents, and `git` broke.
- **Unfinished files as hidden siblings, `.<name>.epicenter-pending`** (built
  in `2acea42bf5`, reverted in `6096cad46b`): it could save below a mount
  point, but it gave up the `0700` directory, so for a few microseconds
  another account could open a staged file the mode bits would otherwise
  have kept from it; Windows Explorer showed every unfinished file; and the
  sweep walked the whole folder.
- **A second "not data" rule naming `.epicenter`** (`isOwnDirectory`,
  `check_namespace`): two rules that had to agree in every host, where every
  hidden path was already outside the contract. Admission names `.epicenter`
  for another question, where a folder's root cannot be.
- **Refusing every hidden directory as a folder** (`is_hidden_directory`):
  one rule for data and for roots, but it refused `~/.notes`, a folder a
  person chose, to keep out only `.git` and `.epicenter`.
- **A second, unconditional mode (`any`, with `present` behind it for an
  existing nonportable name):** it was offered for a cache, but no production
  write used it; every caller had a version to name or was creating. Keeping
  it meant every host carried a write that could replace a file its caller
  never read.
- **Holding the Bun store to every outcome of the shell's** (a second
  literal path walker, `FileError`, and one vector file both hosts ran): it
  kept a Bun process answering a link or a case variant exactly as the
  desktop does, for callers that never write such a path, at the cost of a
  second strict host to keep in step.
- **Callers that know where unfinished bytes go:** each new caller would
  spell `.epicenter` again, which `check:state-paths` now refuses.
- **Staging outside the folder** (beside it, or in AppData): a rename from
  another file system is not one step, and saving made files outside the
  folder.
- **A WAV while it records, encoded to WebM at Stop** (built in `84320e900a`,
  `8ac9e0e143` and `e5c7a8803a`, replaced since): a crash lost at most a quarter second,
  and a WAV the encoder refused could be kept as it was, but Stop took
  about 24 s for an hour of speech, so the page answered first and said
  "Finishing…" while a thread encoded; recovery repaired a header and
  encoded again, and a taken path got a `-recovered` copy, which needed the
  encode to be byte-for-byte repeatable.
- **Writing each packet as it is encoded** (a Cluster of unknown size,
  sized once it is full, with recovery keeping a torn Cluster's whole
  blocks): a crash would lose only the encoder's 6.5 ms lookahead, but it
  writes back into the file every second and recovery must read torn
  Clusters. Holding each second until it is whole loses at most that
  second, a small, rare loss the test above accepts.
- **Deleting a recovered recording whose path holds a file** (built in
  `796087b737`): a recording is finished before it is placed, so a leftover
  there was taken for one placed before the cut. A move cut off that way is
  the same file at both names, which `storage::place` already counts as
  placed; any other file there is not known to be this recording, so the
  deletion could lose a whole recording. Keeping it pending and saying
  where it is costs one list in `recover`'s answer.
