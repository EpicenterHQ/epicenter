# Whispering

Press a shortcut, speak, and get the text on your clipboard. Whispering
records on your device, sends the audio to a transcription server you
choose, can have a chat model clean up the text, and keeps every recording
and transcript as files you can open.

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
settings.json           the transcription server, the microphone, and the cleanup model
dictionary.txt          words to spell as written, and `heard -> written` fixes
cleanup.md              your own cleanup prompt; without it, the built-in one
recordings/<id>.md      the note: the text you got as the body; front matter holds
                        durationMs, and `original` when cleanup changed the text
recordings/<id>.webm    the audio (.m4a when the recorder made MP4)
```

A recording's id starts with the time it began, so a list of files sorts by
time and a recording whose note never got written still has a time.

No server's API key is in these files. The desktop app
keeps it in the macOS Keychain; a browser keeps it in `localStorage`.

## Code layout

Each layer imports only from the layers below it.

```txt
src/
  routes/                    screens: read through queries, write through mutations
    +layout.svelte           the sidebar frame; hands the screens the real dictation
    +page.svelte             Home: what dictation needs, the recorder, the last takes
    recordings/              the list and the reading pane, chosen by `?id=`
    settings/<section>/      one page per sidebar entry
    preview/                 development only: the screens fed a made-up dictation
  lib/
    dictation-view.ts        what a screen may know about dictation (`DictationView`)
    dictation.svelte.ts      live state, and record → save → transcribe → clean up → copy
    queries.ts               the cache: TanStack Query over data/, keys, and microphones
    data/
      recordings.ts          the rules for recordings/ (no cache)
      settings.ts            the rules for settings.json (no cache)
      text-files.ts          dictionary.txt and cleanup.md, read and written whole (no cache)
    platform/
      index.ts               chooses desktop or browser, once
      files/                 files.ts (contract), tauri.ts, opfs.ts
      recorder/              recorder.ts (contract), native.ts, browser.ts
      servers/               servers.ts (contract), native.ts, browser.ts
    cleanup.ts               pure rules: the dictionary, when cleanup runs, what it is told
    feed.ts                  pure rules: a recording's time, day, and search match
    transcription-server.ts  the server's address and model, and presets
src-tauri/src/
  files.rs                   reads many files in one call
  keys.rs                    the Keychain
  servers.rs                 transcription and cleanup requests, with the key
  main.rs                    commands, plugins, and the global shortcut
```

The layers answer different questions:

| Layer | Answers |
| --- | --- |
| `platform/` | How do I read a file, record, or ask a server here? |
| `data/` | What is a recording, and which files make one? |
| `queries.ts` | What does the screen show now, and when does it refresh? |
| `dictation-view.ts` | What may a screen know about a take? |
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

### Cleanup

The order is fixed: the dictionary's words go to the transcription server as
hints, its replacements fix what comes back, that text is saved, then the
cleanup model gets a few seconds to clean it up, and the replacements apply
again so the model cannot undo them.

- **Cleanup fixes the text and never reshapes it.** One prompt, run the
  same way on every transcript, whatever app it is going into. Refused: reading
  the app in front to skip terminals and code editors or to steer style
  per app, because much dictation into a terminal or editor is prose to an
  agent, and a list of app ids needs keeping forever. Also refused: chains
  of steps and several prompts to choose from, which were Whispering's
  transformations and recipes, removed because they fused fixing a
  transcript with turning it into something else.
- **The person's prompt is `cleanup.md`; without it, the built-in prompt.**
  Nothing points at a file, so nothing can point at a missing one, and the
  built-in prompt improves with each release. The rules every prompt needs
  (spell these words, treat the text as dictation, answer only the text)
  are added by the app, so an edited prompt cannot drop them. Refused: a
  `prompts/` folder with one marked active, which needs a picker and a state
  for an active prompt that was deleted.
- **A saved cleanup model can be off.** `cleanup.off` is written only while
  the person has turned it off, so a slow day does not mean retyping the
  model. Refused: cleanup on whenever a model is saved, and a second
  shortcut for a raw transcript; "Use original" after the fact covers that.
- **The person gets the text without cleanup rather than a wrong rewrite.**
  Cleanup is skipped for fewer than four words, after its timeout, and when
  its answer is empty, padded, chatty, or repeats a line the app added to its
  instructions. The text is saved before cleanup
  starts. Refused: waiting on a slow model, which stands between the person
  and their clipboard.
- **The note's body is the text the person got; `original` is the server's
  own words.** Search finds what was pasted, and a hand edit keeps the
  original; a new transcript removes an `original` that no longer applies.
  Refused: a second file beside the note.
- **The dictionary is `dictionary.txt`, one entry per line.** The extension
  says what the parser reads. As `.md`, a bullet or a heading would invite
  `- Epicenter` and `# Names`, which become hints spelled with the marker,
  and a Markdown view runs the lines together. Prose for a model is
  `cleanup.md`. Refused: `dictionary.md` with list and heading syntax
  stripped, a second syntax to keep.
- **The dictionary and the prompt are plain text files with one editor.**
  `data/text-files.ts` reads, writes, and removes a file by path, and
  `TextFileEditor.svelte` edits either; a missing file falls back to an empty
  dictionary or the built-in prompt. Refused: a module and form per file.

### Screens

- **Screens read dictation through `DictationView` from context, never the
  module.** The take, the level, Hands-free, what became of the last take,
  and what dictation still needs are read methods; Record, Stop and
  Transcribe are its only actions. The preview page hands the same screens a
  made-up view, so the pill, hold to talk and Hands-free can be designed and
  checked before they are built. Refused: screens importing
  `dictation.svelte.ts`, which ties every state they show to a microphone
  and to features that exist.
- **One sidebar, one level deep.** Home and Recordings, then each settings
  section by name, so no setting sits behind a second menu; a narrow window
  folds it to icons. Refused: v7's sidebar with a second sidebar inside
  Settings, and a header with only a settings button, which had nowhere to
  show what needs fixing.
- **Recordings is a list and a reading pane, and the address names the open
  one.** Search shows the words around each match; "Needs attention" gathers
  takes with no text. Refused: v7's table, whose columns (title, subtitle,
  transformation output) no longer exist, and a feed of inline editors,
  which leaves no room to read or to move with the keys.

### Cache

- **`queries.ts` is the only cache, and every write refreshes every query.**
  The files are local, so a full refresh is cheap and never misses a screen.
  Refused: a list of queries to refresh on each mutation, which goes stale as
  screens are added.
- **The data modules have no tests; using the app checks them.** Each is a
  short mapping from a call to a file. Refused: in-memory file systems and
  factories to test them, about 185 lines that only tested themselves.
