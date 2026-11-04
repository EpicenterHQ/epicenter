# Recorder demo

A small recorder over the file contract that keeps its recordings in this
browser's private files (OPFS, `openFolder` with no account), for good, with
one store for the page's whole life
([ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)).
It needs no account and offers no sign-in, works offline, and never uploads.

A recording is written into those files as it records
(`recorder.start({ folder, path })` from `@epicenter/recorder/browser`,
decision 84): each piece of audio, about a second, is appended to its file as
it arrives, and its note follows at Stop. When the page opens, a recording a
closed tab cut off is cut back to its last whole piece (`recorder.recover`)
and given its note, its length read from the audio. Recordings play, are
renamed, and are deleted in place. A private window keeps no files, so Record
says why it cannot start before any microphone opens.

The contract is `src/contract.ts`: a note per recording at
`recordings/{id}.md` (`title`, `recordedAt`, `durationMs`) and its audio at
`recordings/{id}.{ext}`. It is published as `public/contract.json`, the URL
`epicenter check` takes; `bun run contract` rewrites it after a change.

## Build, preview and develop

```sh
bun run --cwd apps/recorder-demo build     # static files in dist/
bun run --cwd apps/recorder-demo preview   # serves dist/ on http://localhost:5214
bun run --cwd apps/recorder-demo dev       # Vite dev server on http://localhost:5214
```

The build is static, and any host can serve it.

## Code

- `src/main.ts`: mounts the page.
- `src/lib/folder.ts`: the page's folder, this browser's files, opened once
  for the page (`reactive(openFolder(recorder))`).
- `src/App.svelte`: the page's root, over that folder. It says why when the
  files cannot open, and repairs what a closed tab cut off when it opens.
- `src/Recorder.svelte`, `src/Library.svelte`, `src/RecordingRow.svelte`:
  recording, the list and one row, each over the folder (read through
  `reactive`) and that folder alone. The list shows the folder, and a row
  edits it and reads its audio's bytes (`read`). While one of its writes is
  out, leaving the page asks first.
- `src/lib/recordings.ts`: the folder's notes and audio, joined by id, and
  `finishCutOffRecordings`, which gives audio a closed tab left alone its
  note.

## Tests

```sh
bun run --cwd apps/recorder-demo test         # unit tests: contract, rows
bun run --cwd apps/recorder-demo typecheck
bun x playwright test -c apps/recorder-demo/playwright.config.ts                    # both engines
bun x playwright test -c apps/recorder-demo/playwright.config.ts --project=webkit   # one
```

The Playwright suite (`e2e/demo.spec.ts`) builds the demo and serves it with
`vite preview` on port 5214, which must be free, and walks one person through
it per engine. With no sign-in offered and no request beyond the page's
origin: a recording's audio appears in OPFS and grows while it records, its
note lands at Stop, and it plays, is renamed, another is deleted, and all of
it survives a reload; offline (`goOffline`), recording and renaming still
work; the files fit the published contract (`epicenter check`). In WebKit a
last step opens an ephemeral context, which refuses OPFS as Safari's private
windows do: Record says it cannot start. Both engines record from a generated
tone the suite installs as the page's microphone (`fakeMicrophone`); both use
persistent profiles, the only kind in which WebKit opens OPFS. WebKit keeps
OPFS outside the profile directory, so the first step empties the origin's
files before it records.
