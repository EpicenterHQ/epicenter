# 0962. Whispering 8 writes every file inside its folder, at or beside its final path

- **Status:** Accepted (2026-11-18)
- **Date:** 2026-11-18
- **Amends:** [ADR-0858](0858-where-a-file-lives-decides-whether-it-travels-survives-or-dies-with-its-program.md) at `.cache/` holding "the recording in progress": on the desktop a take in progress is `recordings/<id>.webm`.
- **Relates:** [ADR-0894](0894-whispering-8-keeps-its-recordings-and-their-audio-in-its-own-data-directory-and-needs-no-epicenter.md) (the folder and `Files`; its bullets on `write` and on recording state this rule), [ADR-0939](0939-what-stays-on-this-computer-lives-in-an-apps-local-folder.md) (a home app's `local/`, where the home stages its own writes), [ADR-0940](0940-git-stores-the-home-and-epicenter-does-not-wrap-it.md) (the home's checkpoint), [ADR-0856](0856-binary-files-go-through-git-lfs.md) (audio through Git LFS), [ADR-0870](0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md) (a file that never leaves its computer), [ADR-0900](0900-a-program-may-hand-its-new-records-over-to-a-home-which-then-holds-them.md) (hand-over), [ADR-0943](0943-epicenters-core-invariants.md) (what a simplification removes, and who accepts it). Four superseded records decided where an unfinished recording waits: [ADR-0205](0205-a-recording-is-a-row-that-fills-and-a-crash-finishes-it.md) (in a row's blob slot, finished at launch), [ADR-0543](0543-a-recording-streams-into-its-folder-from-the-moment-it-starts.md) (at its path in the folder from the first sample), [ADR-0702](0702-a-data-folders-unfinished-writes-wait-in-epicenter-outside-its-data.md) (in `.epicenter/` at the folder's root), [ADR-0822](0822-only-epicenter-syncs-on-a-computer-and-a-folder-holds-only-its-content.md) (in a hidden file beside its path).
- **Unbuilt:** all of it. The branch `whispering-keeps-its-recordings-local` is building it.

## Context

ADR-0894 gave Whispering 8 a folder of plain files. It said the recorder
"writes audio to a staging file as it records, places it at
`recordings/{id}.{ext}` when the take ends, and repairs a take a crash cut
short". The branch `whispering-keeps-its-recordings-local` built that to
keep one promise: the folder never holds an unfinished file, even for a
moment.

```txt
<appLocalDataDir>/local/.tmp/<random>         a save, staged, then renamed into the folder
<appLocalDataDir>/local/recording/<id>.webm   a take while it records; Stop finishes it and moves it in
<folder>/recordings/.ep-<random>.save         a copy beside the target, made when the folder is on another disk
clear, clear_saves                            delete what a crash left in local/.tmp/ and beside targets
recover, finish_cut_off                       at the next launch, finish a take a crash cut off and move it in
```

The moves are `place` and `copy_across` in
`whispering-keeps-its-recordings-local:apps/whispering/packages/whispering-files/src/place.rs`.
The repair is `recover` in `takes.rs` and `finish_cut_off` in `webm.rs`,
both in that branch's `tauri-plugin-epicenter-recorder`.

**The promise answers a tension that a folder cannot settle.** Epicenter
promises that records are plain files in an open folder: Git, a file
syncer, an agent, or another program can read them. A program that writes
those files needs a private place to work on the same disk. It replaces a
file by renaming a finished copy over it, and a rename cannot cross disks.
A folder has no way to say "this file is here but is not part of the
folder". So each program that watches a folder needs its own rule for what
to skip, and no one rule reaches all of them. Git reads `.gitignore`.
iCloud Drive and Syncthing do not. The `.local` suffix (ADR-0870), a home
app's `local/` folder (ADR-0939), `.env`, and Whispering's
`.ep-<random>.save` are each one such rule.

**A home does not feel the tension, because it owns the level above the
open folder.** In `apps/<app>/`, `data/` is the open folder. `local/` sits
beside it, on the same disk, under one ignore line (`/apps/*/local/`). The
home's `put` (`packages/cli/src/disk.ts`) stages there. Whispering is
handed only the open folder: the person picks it, and Whispering owns
nothing above it.

**`local` was answering two questions.** The first is where a program
keeps its own long-lived files: sign-ins, caches, settings. Those never
need to be near the records. The second is how an unfinished file reaches
an open folder. That takes milliseconds for a note and minutes for a take,
and it has to happen on the folder's disk. The branch answered the second
question with the first one's place. That place can be on a different
disk from the folder, so the branch also needed the other-disk copy, a
hidden name inside the folder after all, and two sweeps.

**All of the staging served the one promise.** Without the promise, none
of it is needed. That left one question: is an unfinished take a broken
file that needs its own name and a repair?

**An unfinished take is already a playable file.** The recorder writes
Opus in WebM as one Segment of unknown size, then one Cluster a second,
each written whole in one write (`webm.rs`). Nothing is written back into a
Cluster. A file cut off at any moment is whole Clusters, with at most a
torn one at its end. A browser's `MediaRecorder` writes the same shape, with
unknown sizes and no Duration. Whispering's browser build keeps those files
as they are, and `audioDurationMs`
(`whispering-keeps-its-recordings-local:apps/whispering/packages/recorder/src/container.ts`)
reads their length from their last blocks.

A test on 2026-11-18 checked that the desktop plays such a file. A scratch
program included the branch's `webm.rs` and `opus.rs` unchanged and wrote a
6.5 s tone three ways. Each file was played muted in the system WKWebView
on macOS 26.5.2 from a `Blob` typed `audio/webm`, as
`apps/whispering/src/routes/components/AudioPlayer.svelte` plays a
recording.

| File | WKWebView `duration` | `audioDurationMs` | ffmpeg decodes |
| --- | --- | --- | --- |
| Finished by `finish` | 6.5 s | 6500 ms | 6.50 s |
| Dropped without `finish`, as a crash leaves it | 5.9935 s | 6000 ms | 5.99 s |
| That file less its last 200 bytes, as a crash in the middle of a write leaves it | 5.9335 s | 5940 ms | 5.93 s, warning "File ended prematurely" |

All three loaded, played to the end, and seeked to 3 s. The test did not
cover Whispering's own transcription decoder, cloud transcription of a
cut-off file, Windows, Linux, or a long recording.

**Four earlier records decided where an unfinished recording waits, and
each is superseded.**

| Record | What it chose | Why it was left |
| --- | --- | --- |
| ADR-0205, 2026-08-03 | A recording fills a row's blob slot, and each launch runs the `stop` procedure on a partial file | Rows stopped owning blobs (ADR-0393, ADR-0366), and unfinished capture became disposable |
| ADR-0543, 2026-10-15 | A desktop recording is `recordings/<name>.wav` in its folder from the first sample, "the one data file written in place rather than staged and renamed" | Its amendment of 2026-11-01 moved the file under `.epicenter/` so that "`epicenter sync` never commits a half-written WAV, and readers never see a growing file at a data path" |
| ADR-0702, 2026-11-01 | Unfinished writes wait in `.epicenter/saves/` and `.epicenter/recordings/` at the folder's root, and `recoverRecordings` finishes a cut-off recording before a page lists, plays, or transcribes it | ADR-0822 took Epicenter's state out of the folder, because a copy of the folder carried `.epicenter/` along |
| ADR-0822, 2026-11-06 | Hidden files beside the target: `.ep-<random>.save` for a save, `.ep-<random>.recording` for a recording | The folder sync product was retired (ADR-0899) |

The decision below returns to ADR-0543's first rule. Three things differ
from the day that rule was left:

- **No Epicenter program syncs or watches the folder.** ADR-0543's
  amendment and ADR-0702 kept a growing file away from `epicenter sync`,
  which committed whatever sat at a data path, and from its watch, which a
  recording's writes woke about once a second. ADR-0899 retired that
  product. Whispering is the folder's one writer and keeps no watcher
  (ADR-0894). What can still read a growing take is a home's checkpoint or
  a file syncer the person chose.
- **Nothing is written back into the file while it records.** ADR-0543's
  file was a WAV whose header was rewritten about once a second, so a
  cut-off WAV stated a wrong length until `recoverRecordings` rewrote it.
  The WebM writer that ADR-0702 introduced appends whole Clusters and
  rewrites nothing until Stop.
- **A test replaced an assertion, for the player only.** ADR-0702 made
  recovery a gate because "a cut-off file reads wrong (no length in a
  player, a torn block in the transcription decoder) until it is finished".
  The test above found that WKWebView states a length for a cut-off file
  and plays it. The decoder half of that sentence is still untested.

ADR-0822's hidden `.ep-<random>.recording` needed recovery to find it and
give it its name. A take written at its final path needs neither.

## Decision

**Whispering 8 writes every file inside the folder the person chose: a
take at its audio's path from its first second, and a note through a
temporary file beside it. Nothing waits outside the folder, and nothing
repairs a file.**

```txt
<folder>/                          the folder the person chose, on any disk
  recordings/k3x9.webm             a take, from its first second; finished in place at Stop
  recordings/k3x9.md               its note, written after Stop
  recordings/(hidden temporary)    a note being saved; renamed over k3x9.md
  settings.md                      replaced the same way as a note
<appLocalDataDir>/local/           this computer's own files; nothing on its way into the folder
```

- **A take is `recordings/<id>.webm` from its first second.** On the
  desktop the recorder creates the file at that path when recording starts
  and appends one Cluster a second. No file in the app's local data
  directory holds the take, the take has no other name while it records,
  and no rename follows.
- **Stop finishes the file in place, then the note is written.** Finishing
  writes the last Cluster, the Cues, the Duration, and the Segment's size,
  and flushes them to the disk (`LiveWebm::finish`). Whispering then writes
  `recordings/<id>.md`.
- **Nothing repairs a take a crash cut off.** The file stays as the crash
  left it: whole Clusters, perhaps a torn one at its end, no Duration, no
  Cues, and a Segment of unknown size. It has no note, so it lists as an
  untitled recording, as audio with no note already does (ADR-0894).
  Whispering plays it and reads its length with `audioDurationMs`.
- **A note or `settings.md` is replaced by a rename from beside it.**
  `write` puts the bytes in a hidden temporary file in the target's own
  directory, flushes it, and renames it over the target. `checkPath`, the
  path rule of `Files`, refuses a hidden name, so the temporary file is
  never listed or read as a note. When the folder opens, Whispering deletes
  any temporary file of its own that a crash left there.
- **`local/` in the app's local data directory holds only this computer's
  own files,** such as the local engine's state
  (`local-transcription.json`, ADR-0894). These go:

  ```txt
  local/.tmp/                       a save is written beside its target
  local/recording/                  a take is written at recordings/<id>.webm
  place, place_into, copy_across    nothing is moved into the folder
  .ep-<random>.save                 nothing is copied from another disk
  clear, clear_saves                one deletion of leftover temporary files when the folder opens
  recover, finish_cut_off           a cut-off take is left as it is
  ```

- **The folder may be on any disk.** A take is written where it stays, and
  a temporary file is renamed within one directory, so no write crosses
  disks. An external drive or a network drive needs no second path.
- **The browser build follows the same rule for the folder.** Every file
  it writes goes into its folder through `Files`, whose `createWritable()`
  changes reach the file when the stream closes. It still holds a take in
  memory and writes it once at Stop.
- **Whispering does not list the take it is recording.** The record screen
  (`RecorderCard.svelte`) shows that take. The recordings list leaves its
  id out until Stop answers.

## Consequences

- A crash of Whispering loses at most the second of audio held in memory.
  The file it leaves states no Duration and has no Cues. A Cluster is
  written but not flushed to the disk while recording (`LiveWebm::push`), so
  a power cut or a kernel panic also loses what the operating system had
  not yet written.
- When the folder is `apps/whispering/data` in a home, the home's
  checkpoint (`git add -A` every five minutes, ADR-0940) commits a take
  while it grows. The take already has its final name, so no ignore line
  can match it. Where the home's `.gitattributes` has a `*.webm` line, the
  take goes through Git LFS (ADR-0856). Each checkpoint stores the take so
  far as a new object. A one-hour take
  at the recorder's 24 kbit/s is about 11 MB when finished, and the twelve
  checkpoints during it store about 70 MB. The cost is space. The audio is
  the person's own and was going into that history anyway.
- A file syncer may upload a take while it grows, and another device may
  receive it before Stop. That copy plays as far as it reached.
- A home's checkpoint that runs during a save, or after a crash left a
  temporary file behind, commits that file. The checkpoint after the file
  is gone commits its removal. The file is a copy of a note that is
  committed anyway.
- A name that starts with a dot is not hidden on Windows, so Explorer shows
  the temporary file for as long as it exists. ADR-0702 rejected hidden
  siblings partly for this.
- The take is captured on the folder's disk. Unplugging that disk during a
  recording loses the rest of the take. The staged design captured on the
  app's own disk and would have kept it.
- A take a crash cut off is never completed. Whispering and WKWebView play
  it and show its length; another player may show no length for it.
- One write path serves every folder, on any disk. The other-disk copy,
  the two sweeps, and the recovery at launch go.
- **What this removes, and who accepts it** (ADR-0943):

  | Removed | Who loses what | Who takes on the work |
  | --- | --- | --- |
  | The promise that the folder never holds an unfinished file, and any name that marks one | Git, a file syncer, or another program may read a take while it grows, and no ignore line or glob can skip it; a home's checkpoints during a recording cost space | The person, who pays the space; Whispering's maintainers, who keep the growing take out of the list |
  | Repair of a take a crash cut off | Another player may show no length for that file | The person; Whispering's maintainers, who test that the player, `audioDurationMs`, and the transcription decoder read a cut-off file |
  | Capture on the app's own disk | Unplugging the folder's disk during a recording loses the rest of the take | The person |

## Not decided

- Whether the home's `put` (`packages/cli/src/disk.ts`), which stages in
  `local/.tmp/` (ADR-0939), should write its temporary file beside the
  target instead. The home keeps its rule.
- What Whispering does when its transcription decoder or a cloud
  transcription service refuses a cut-off file. Neither was tested, and
  ADR-0702 said the decoder meets "a torn block" in one.
- Whether a quit or a closed window finishes the take in place, as Stop
  does. ADR-0543 had the shell finish a recording whose window left.
- The mode of the temporary file. ADR-0822 created its save file `0600`,
  and ADR-0702 noted that a staged file beside its target is open to
  another account for a moment without a private directory around it.
- Whether a cut-off take behaves the same on Windows and Linux, and at the
  length of a long recording.

## Considered alternatives

- **Stage outside the folder and rename in,** as the branch built it. The
  folder never holds an unfinished file. It costs the two staging
  folders, the other-disk copy, the sweeps, and the repair, to keep out a
  file that plays.
- **Record beside the target as `<id>.webm.part` and repair it when the
  folder opens.** Git can ignore a growing take, and the name shows its
  state. It costs a rename, a finish step, and the repair, for a file that
  already plays.
- **Hold the take in memory and write it once at Stop,** as the browser
  does. No unfinished audio exists anywhere, and an hour is about 11 MB of
  memory. A crash loses the whole take.
- **Refuse a folder on another disk.** It removes the other-disk copy, and
  it refuses external and network drives.
- **Point the setting at a container that holds `data/` and `local/`,** as
  a home app's folder does. A file syncer would sync `local/` with the
  recordings, and a second program sharing `local/.tmp/` could delete
  another's files.
- **Record "unfinished" inside the note.** Git, file syncers, and globs act
  on names, not on contents.
