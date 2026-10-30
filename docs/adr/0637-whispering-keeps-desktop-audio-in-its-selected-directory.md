# 0637. Whispering keeps desktop audio in its selected directory

- **Status:** Proposed
- **Date:** 2026-10-19
- **Amends:** [ADR-0621](0621-epicenters-library-writes-only-text-to-a-repository-in-v1.md) only at Whispering's desktop audio being outside the selected data directory; [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md) at desktop audio being separate app storage; and [ADR-0592](0592-a-folders-gitignore-decides-what-stays-on-one-machine.md) at the placement of Whispering's ignored audio. The library's text-only write boundary remains.
- **Relates:** [ADR-0633](0633-apps-open-local-data-before-connecting-services.md) (the selected local data), [ADR-0634](0634-hosted-inference-is-independent-of-repository-sync.md) (transcription does not sync audio).
- **Unbuilt:** standalone Whispering's native directory and recorder integration, migration from its current hosted desktop shell, and a data-safe migration of existing browser audio when the browser data engine changes. This record adds no generic binary-write API.

## Context

Whispering's current desktop recorder writes `audio/<id>.<extension>` inside
the directory containing its Markdown recording rows. ADR-0621 plans to move
audio into separate app storage because the new data library writes only text.
That would leave a copied or moved directory with rows naming recordings whose
audio was left behind. An agent inspecting the directory could not inspect or
repair those files together.

Native recording does not need a general binary-write method on the folder
handle: the recorder already writes its stream into its granted directory.
The new browser engine has a different constraint. It saves text in IndexedDB
and has no local binary-write path; a browser cannot promise that copying a
disk directory copies its private audio.

## Decision

**On desktop, Whispering records audio as an ordinary file inside the
selected data directory.** A recording row stores its relative `audioPath`,
such as `audio/<id>.wav`. The native recorder creates and finishes that file
under the selected directory. Whispering reads the named file for playback
and transcription and reports a missing file without replacing or guessing
its contents. A person's directory copy therefore includes the row and its
local audio.

**Audio is local by default.** Whispering puts `audio/` in the directory's
`.gitignore` while preserving existing rules. A Git clone normally has the
Markdown row but no audio, so the app shows that the recording cannot be
played on that device. Ignore rules do not stop a person from deliberately
committing audio with ordinary Git. The separate automatic-commit policy must
define what happens if audio becomes eligible for an Epicenter-created commit.

**The shared data library still writes only text in v1.** The recorder owns
native binary creation. This decision does not add generic binary writes,
streaming, or binary merge to `folder.files`. Browser audio follows
ADR-0621's origin-local app storage rather than a promised unified folder
namespace. Replacing the current browser folder engine must carry its saved
audio without loss; the exact browser media API and export workflow remain
separate work.

## Consequences

- Copying or moving the chosen desktop directory carries Whispering's saved
  recordings with its text. A Git clone does not carry ignored audio.
- Whispering's desktop data can live anywhere the person selected. Audio
  needs no second machine-local directory or mapping to find it.
- Browser and desktop recording use different byte-storage mechanisms. The
  app retains the recording row's relative audio path and reports missing
  bytes on either target.
- A universal binary folder API, browser media export, Git LFS, and hosted
  media synchronization are not required to preserve the desktop copy rule.

## Considered alternatives

- **Store desktop audio outside the selected directory under ADR-0621.** A
  directory copy then leaves behind the bytes its recording rows name.
- **Make all browser and desktop audio writable through `folder.files` now.**
  Requires a binary store, streaming and crash recovery, path collision and
  deletion rules, and a complete browser export path before the desktop
  placement guarantee can ship.
- **Commit audio as ordinary Git blobs by default.** A recording can then
  travel to every clone without a person choosing media synchronization.
