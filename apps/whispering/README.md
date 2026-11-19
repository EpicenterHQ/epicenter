# Whispering

Press a shortcut, speak, and get the text on your clipboard. Whispering
records on your device, sends the audio to a transcription server you
choose, and keeps every recording and transcript as files you can open.

It runs in two places from the same page: a desktop app (Tauri) and a
browser tab.

```bash
bun dev:whispering           # the page in a browser, on port 1420
bun dev:whispering:desktop   # the desktop app
```

Run both from the repository root.

## What it stores

The desktop app keeps its files in the app's local data directory. A browser
keeps the same files in its Origin Private File System, which belongs to the
page's origin and is not visible in Finder. Whispering asks the browser to
keep them when space runs low (`navigator.storage.persist()`); a browser
that says no may clear them.

```txt
settings.json           the transcription server and the chosen microphone
recordings/<id>.md      the note: durationMs in front matter, the transcript as the body
recordings/<id>.webm    the audio (.m4a when the recorder made MP4)
```

A recording's id starts with the time it began, so a list of files sorts by
time and a recording whose note never got written still has a time.

The transcription server's API key is not in these files. The desktop app
keeps it in the macOS Keychain; a browser keeps it in `localStorage`.

## Code layout

Each layer imports only from the layers below it.

```txt
src/
  routes/                    screens: read through queries, write through mutations
  lib/
    dictation.svelte.ts      live state, and record → save → transcribe → copy
    queries.ts               the cache: TanStack Query over data/
    data/
      recordings.ts          the rules for recordings/ (no cache)
      settings.ts            the rules for settings.json (no cache)
    platform/
      index.ts               chooses desktop or browser, once
      files/                 files.ts (contract), tauri.ts, opfs.ts
      recorder/              recorder.ts (contract), native.ts, browser.ts
      transcription/         transcription.ts (contract), native.ts, browser.ts
    feed.ts                  pure rules: a recording's time, day, and search match
    transcription-server.ts  the server's address and model, and presets
src-tauri/src/
  files.rs                   reads many files in one call
  keys.rs                    the Keychain
  transcribe.rs              sends audio to the server with the key
  main.rs                    commands, plugins, and the global shortcut
```

The layers answer different questions:

| Layer | Answers |
| --- | --- |
| `platform/` | How do I read a file, record, or send audio here? |
| `data/` | What is a recording, and which files make one? |
| `queries.ts` | What does the screen show now, and when does it refresh? |
| `dictation.svelte.ts` | What is happening right now, and what happens next? |

## Decisions

### Storage

- **A recording is a note and its audio, joined by id, with its time in the
  id.** The audio is made with the recording and deleted with it, so
  `data/recordings.ts` owns both files. Refused: a `recordedAt` field in the
  note, which a crash before the note is written would lose.
- **The desktop app reads every note in one Rust call (`files_read`).** A
  list of hundreds of recordings takes one trip across the bridge. Refused:
  one plugin-fs read per note.
- **`settings.json` changes through `settings.update(change)`, which reads
  the file, merges, and writes.** The file is the only copy, and the query
  cache reads it. Refused: a Svelte copy of the settings kept
  beside the query cache.
- **The desktop API key lives in the Keychain and only Rust reads it.** The
  page sends a request and never holds the key. Refused: `localStorage` on
  the desktop, which is a plain file on disk and puts the key in the page.

### Platform

- **Desktop and browser are chosen in one file, `platform/index.ts`.** Each
  capability that differs has a contract type and two implementations, and
  nothing else imports Tauri. Refused: an `isTauri()` check inside each
  module, which spreads the question of where the page runs across the code.
- **The browser recorder turns voice processing off and writes on Stop.**
  Echo cancellation and noise suppression change the audio the server hears.
  Refused: writing chunks while recording, which would leave a half-written
  file for every take a closed tab interrupts.

### Cache

- **`queries.ts` is the only cache, and every write refreshes every query.**
  The files are local, so a full refresh is cheap and never misses a screen.
  Refused: a list of queries to refresh on each mutation, which goes stale as
  screens are added.
- **The data modules have no tests; using the app checks them.** Each is a
  short mapping from a call to a file. Refused: in-memory file systems and
  factories to test them, about 185 lines that only tested themselves.
