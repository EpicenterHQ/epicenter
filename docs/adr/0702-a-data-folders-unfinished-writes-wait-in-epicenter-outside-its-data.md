# 0702. A data folder's unfinished writes wait in `.epicenter`, outside its data

- **Status:** Accepted
- **Date:** 2026-11-01
- **Supersedes:** [ADR-0494](0494-file-folders-reserve-epicenter-for-rebuildable-caches.md): `.epicenter/` is reserved for unfinished writes only, and one layout module per language owns it.
- **Amends:** [ADR-0551](0551-every-write-to-a-folder-file-is-one-save-that-merges-by-the-files-kind-and-sync-settles-with-the-same-merge.md) at step 1's "swap on that hash" for a desktop folder: the check runs right before an atomic rename with no lock held, and a new file is placed instead of renamed; [ADR-0562](0562-the-cli-and-the-shell-take-turns-writing-a-folder-under-one-save-lock.md) at its save lock and its amendments of 2026-10-31 and 2026-11-01: no save lock, `.epicenter` holds only `saves/` and `recordings/`, and a new file is placed; [ADR-0568](0568-a-folder-takes-every-writer-in-turn-under-its-save-lock-and-refuses-none.md) at every writer taking turns under the save lock, and its amendments of 2026-10-31 and 2026-11-01: no writer takes a lock; [ADR-0543](0543-a-recording-streams-into-its-folder-from-the-moment-it-starts.md) at where a desktop recording is written while it records and how it reaches its path, and its amendments of 2026-11-01 on `.epicenter`, the root, and what `stop` and `recoverRecordings` answer.
- **Relates:** [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) (the file contract, whose `over` is the version a write names).

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
  (`storage::list`, `directory-store.ts`); whoever reads a listing skips them.
- The Epicenter app refuses a hidden directory, or a directory inside one, as
  a folder to sync (`admission::check_sync_directory`).
- `epicenter sync` commits a hidden path when Git's rules let it, as it
  commits `.gitattributes` and `.gitignore`, and never commits `.epicenter`.

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
├── saves/        a save's bytes before their rename, and a stopped recording's
│                 encode before it is placed; always safe to delete when no app runs
└── recordings/   a desktop recording from its first sample, at its own path
                  (<stem>.wav), until stop or recovery; may hold audio until the
                  app opens once
```

- One module per language spells the layout:
  `packages/tauri-plugin-epicenter-folder/core/src/state.rs` and
  `packages/folder/src/state.ts` (`STATE_DIRECTORY`, `savesDirectory`; only
  the shell writes `recordings/`). Both, and the OPFS worker's inlined copy, are held to
  `packages/tauri-plugin-epicenter-folder/fixtures/state-layout.json`, and
  `bun run check:state-paths` (`scripts/check-state-paths.ts`) fails when
  other production code spells `.epicenter`. A new kind of unfinished write
  gets its own part there, never from its caller.
- On Unix, before anything is staged, `.epicenter` and `saves/` are made, or
  tightened, to `0700`, and each staged file is created with `create_new` at
  `0600` (`make_private` and `create_scratch` in the folder core's
  `storage.rs`; `privateDirectory` in `packages/folder/src/directory-node.ts`).
  An inheritable access control entry on the person's folder is kept: it is
  a grant they chose, files other programs make there inherit it, and
  Epicenter's inherit it too. Either directory is refused when it is a link
  or not a directory.
- A recording's WAV is created with `create_new` under `recordings/`, so
  nothing already at its name is written through.
- Opening a folder removes, from `saves/` alone, regular files with a stager's
  scratch name more than an hour old (`storage::sweep_scratch`,
  `sweepStaleScratch`). Nothing sweeps `recordings/`; only `recoverRecordings`
  finishes what a quit or a crash left there.
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
and nothing else (`Expectation` in `packages/folder/src/boundary.ts` and in
the folder core's `storage.rs`): there is no unconditional write, and an
existing name only some disks hold is replaced or removed over its version
like any other. A store answers `stale` when the file no longer matches, and
the client answers `Conflict { current }`.

| Store | Check, then land |
| --- | --- |
| Desktop folder, replacing or removing a file (`storage::put`, `directory-store.ts`) | stage in `.epicenter/saves`; taking the path's turn in this process, walk and check the path, rename over it or remove it |
| Desktop folder, a new file (the shell and Bun) | stage; taking the path's turn, check, then place by a hard link (`storage::place`, `place` in `directory-node.ts`) |
| Browser (OPFS) | one Worker, holding a Web Lock named for the path (`epicenter-device:<path>`) across the check and the write |
| Repository (`openRemote`) | read, compare with `over`, send the write with that base; the server settles it against `main` and moves `main` by compare-and-swap |

Within one process, a desktop path's writes take turns from the check to the
rename or removal: a per-path queue in Bun (`createPathTurns`, used by
`directory-node.ts`) and a per-path turn in the shell (`Turn` in the folder
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
`storage::place` in the folder core makes a hard link at the target, which
the system refuses when any entry has the name, then removes the staged name.
A link a cut-off placement already made is the same file at both names and
counts as placed. Where the disk has no hard links (FAT, exFAT, some network
shares), the file is renamed only while nothing is at the target. `put` uses
it for a write expecting `absent`, answering `stale` when something appeared
after the check, and the recorder uses it for every recording it places. The
Bun host places a new file the same way, so of writers creating one path, in
one process or several, exactly one lands.

**A save across a mount point fails.** A target on another file system than
`.epicenter` (a mount point inside the folder) is one no rename or hard link
from `saves/` reaches (`EXDEV`). The save fails saying it cannot save across a
mount point (`storage::rename_failure`, and the Bun host), and nothing is
copied.

**A desktop root is always an absolute path.** `openDevice(contract, { path,
create? })` from `@epicenter/folder/tauri` requires `path`, and the shell's
`open_folder` refuses a relative one (`Refused`). Every command of the folder,
recorder, and transcription plugins takes the root `open_folder` answered
(`rootOf(device)`); none falls back to the window's own directory. So a
folder's `.epicenter` is always at that folder's root.

**A desktop recording is a WAV in `.epicenter/recordings` until it stops, and
Opus in WebM at its path after.**

- `startRecording({ device, path })` refuses when `<path>.webm` or
  `<path>.wav` exists, then creates `.epicenter/recordings/<path>.wav` before
  the microphone opens and writes it from the first sample.
- `stop` finalizes the WAV and answers `{ durationMs, placed }` without
  waiting for the encode (about 24 s for an hour of speech). The shell then
  encodes it once to Opus in WebM, in a scratch file in `saves/`, on a thread
  of its own, places that at `<path>.webm`, and then removes the WAV; until
  then the WAV is held from recovery. `placed` resolves with `{ path }` once
  it is there. When encoding fails, the WAV itself is placed at `<path>.wav`
  and `placed` says why (`unencoded`); when it cannot be placed, `placed` is
  an error and the WAV stays for recovery. A quit during the encode leaves
  the WAV, which recovery encodes again. `start` answers no path.
- After a quit or a crash, `recoverRecordings({ device, under })` repairs each
  WAV under `.epicenter/recordings/<under>` and settles it the same way,
  placing it at `<stem>-recovered[-n]` beside a taken path. It answers
  `{ path, durationMs }` for each, with `durationMs` null for a leftover that
  is not a WAV.
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
- Folders written before these changes are not migrated: an old `scratch/`,
  `recording/`, or `save-lock` stays where it is, and nothing recovers a WAV
  left in `.epicenter/recording/`.
- Deleting `.epicenter` while no app runs can lose a cut-off recording;
  deleting `saves/` alone loses nothing.
- `epicenter sync` never commits a half-written recording, and its watch is
  not woken by a recording's header rewrite, about once a second.

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
  hidden path was already outside the contract.
- **A second, unconditional mode (`any`, with `present` behind it for an
  existing nonportable name):** it was offered for a cache, but no production
  write used it; every caller had a version to name or was creating. Keeping
  it meant every host carried a write that could replace a file its caller
  never read.
- **Callers that know where unfinished bytes go:** each new caller would
  spell `.epicenter` again, which `check:state-paths` now refuses.
- **Staging outside the folder** (beside it, or in AppData): a rename from
  another file system is not one step, and saving made files outside the
  folder.
