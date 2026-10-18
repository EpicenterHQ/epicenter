# 0577. Audio stays on the machine that recorded it

- **Status:** Accepted
- **Date:** 2026-10-16
- **Amends:** [ADR-0543](0543-a-recording-streams-into-its-folder-from-the-moment-it-starts.md) at "`recordings/<name>.wav`": a recording's audio is written to `audio/<name>.wav`, and its row stays `recordings/<name>.md`. [ADR-0544](0544-a-blob-is-a-file-in-its-folder-and-git-decides-how-it-travels.md) at "Epicenter's hosted blob storage is the LFS server for hosted folders" and the deletions "With the LFS wave": the hosted blob routes, `@epicenter/blobs`, and `s3-blob-store.ts` are deleted now, and the LFS store is chosen when LFS is built. LFS stays the later path for audio.
- **Amended by:** [ADR-0592](0592-a-folders-gitignore-decides-what-stays-on-one-machine.md) at the `local` key, the engine's rule table, `publishLocalPatterns`, and the consequences about `local` merging: audio stays on the machine while the folder's `.gitignore` ignores it, whoever edits that line decides for every device, a recording committed by mistake syncs and is repaired by rewriting history outside Epicenter, and Epicenter never refuses to commit a file because of what it holds.
- **Unbuilt:** LFS (ADR-0544).

## Context

Whispering committed each recording, `recordings/<id>.wav`, as real bytes in
the folder's Git history, beside its row `recordings/<id>.md`. Every clone
carried every recording, Cloudflare Artifacts refuses a file over 32 MB, and
LFS (ADR-0544) is unbuilt. A pushed recording cannot be taken back without a
force push, so leaving audio out of history is a protection that has to hold,
not a convention a person can repair later (ADR-0503).

Beside Git, `apps/api` mounted owner-addressed blob routes
<!-- doc-path-check: ignore-next-line (deleted by ADR-0577 or ADR-0578) -->
(`mountPersonalAuthorityBlobs`, `packages/server/src/routes/authority-blobs.ts`)
<!-- doc-path-check: ignore-next-line (deleted by ADR-0577 or ADR-0578) -->
over an S3 store (`packages/server/src/s3-blob-store.ts`, `BLOBS_S3_*`), with
their URL grammar in `@epicenter/blobs`. Nothing in the product called them;
ADR-0438, which proposed them, is withdrawn.

## Decision

**A recording's audio lives in `audio/`, apart from its row.**

```txt
so.epicenter.whispering/
  recordings/<id>.md       the row, with audioPath: audio/<id>.<extension>
  audio/<id>.<extension>   the audio; left out of every commit Epicenter makes
  .gitignore               names audio/
```

`recordingAudioStem` (`apps/whispering/src/lib/definition.ts`) answers
`audio/<id>`; the desktop recorder and the browser capture write there, and
`recoverRecordings` runs with `under: 'audio'`.

**A folder definition names the files that stay on the machine that wrote
them, and the engine leaves them out of every commit it makes from a
declaration that reads cleanly.** `defineFolder` takes `local`, a list of
`.gitignore` patterns (`DataSchema['local']`, checked by `prepareSchema`):
each is one line that ignores something, so an empty pattern, a comment, a
negation, or surrounding whitespace is refused. `prepareSchema` sorts the list
and keeps each pattern once, so the declaration's bytes do not depend on the
order it was written in. Whispering declares `local: ['audio/']`.

**The folder's own `epicenter.json` carries `local`, so every host reads the
same patterns.** `formatDeclaration` writes `"local": ["audio/"]` beside
`kv` and `tables`, and `parseDeclaration` reads it back. The desktop's Sync and
Save version run in the `epicenter` CLI (`runHistory`), which reads the
definition from that file, so the CLI excludes exactly what the app does. A
declaration without `local` keeps nothing local, and a folder with no
`epicenter.json` has no definition. An `epicenter.json` that is there but
cannot be read or prepared refuses a save version and a sync, with
the problem named, because a commit made without its `local` could carry
those files; status and the log still read. A browser data folder with such a
file does not open (`InvalidDeclaration`).

The rule is the engine's, on both backends, whatever `.gitignore` says
(`localMatcher` and `sourceFiles` in `packages/folder/src/git/scope.ts`):

| Path `local` matches | What the engine does |
| --- | --- |
| untracked | never history source: status does not offer it, and no commit carries it |
| committed before the rule | the next whole-folder commit leaves it out of the tree, and the index is reset to that tree, as `git rm --cached` would; the file stays on disk |
| named by a `!` exception in `.gitignore` | left out all the same: the declaration wins |
| staged by hand with plain `git add -f` | left out of the next commit Epicenter makes, and the index is reset to that commit's tree |

**The handle also writes the patterns into the root `.gitignore`**, which
mirrors them for plain `git`. `publishLocalPatterns`
(`packages/folder/src/publish-definition.ts`) runs after `publishDefinition`,
before a handle's first write: a missing `.gitignore` is created holding the
patterns, a present one gains each missing pattern as a line at its end, and a
person's own lines are never rewritten. A failed write is logged and never
refuses the write it precedes; the engine's rule holds without it.
`.gitignore` protects only untracked files: plain `git add -A` outside
Epicenter honors it, and it does nothing for a file already committed.

**A row whose `audioPath` the folder listing lacks says its audio isn't on
this device.** `recordingAudio` (`apps/whispering/src/lib/recording-audio.ts`)
answers `none`, `here`, or `absent`. The listing cannot say why a file is
missing (made on another device, a failed capture, a file deleted here), so
the state names only the fact. Before a listing is read, while this window is
capturing or writing the recording, and after it finished until the folder is
listed again, it answers `here`. For `absent`:

```txt
recording list      an "Audio not on this device" badge on the row
recording detail    AudioAbsent.svelte, "This recording's audio isn't on this device.", in place of the player; Transcribe and Run again disabled
home page           the same, for the newest recording
Transcribe several  the row is skipped: "Its audio isn't on this device."
```

Whispering has no audio export, so there is nothing else to disable.

**Epicenter hosts no blob store.** The blob routes, `@epicenter/blobs`,
`s3-blob-store.ts`, and the `BLOBS_S3_*` bindings are deleted.

## Consequences

- A recording made on one device cannot be played or retranscribed on another
  until LFS exists. Copying the audio file into `audio/` by hand makes it
  playable there.
- A clone of a Whispering folder stays small; Artifacts' file cap never
  applies to audio.
- Audio committed by an earlier build stays in that history; only new commits
  leave it out.
- A person who deletes the `audio/` line from `.gitignore` gets it back the
  next time the app opens the folder and writes.
- If a Sync takes an `epicenter.json` written by an older app version, one
  without `local`, other devices' patterns leave the file. Each device still
  excludes its own definition's patterns, since an open folder reads `local`
  for each commit joined with its definition's, and lists them again on its
  next write. `.gitignore` merges by line and keeps its `audio/` line
  meanwhile, so an untracked recording is still ignored there.
- If two devices publish differing `local` lists, both stay: merging
  `epicenter.json` unions `local`
  ([ADR-0576](0576-a-folder-has-one-write-a-merge-by-unit-where-the-writer-acting-wins.md)),
  an open folder reads the file's `local` again for each commit and Sync, and
  a handle's publication keeps every pattern the file lists.
- No server holds a person's audio unless they send it to a transcription
  service.
- Objects already in the hosted `epicenter-blobs` bucket stay until the bucket
  is emptied; no route reaches them.

## Considered alternatives

- **Keep committing audio until LFS.** Every clone carries every recording,
  and a long recording breaks the push to Artifacts.
- **Ignore audio by extension under `recordings/`.** The rows live there, so
  the patterns had to name each extension, an upper-case extension slipped
  past them, and a person's exception could not be ordered against appended
  lines.
- **Rely on `.gitignore` alone.** A failed write, a person's `!` exception, or
  audio committed before the line existed would each push audio, and a push
  cannot be undone without a force push.
- **Keep the hosted blob routes as audio storage.** A folder would stop
  describing itself, and the routes had no caller (ADR-0544's own refusal).
