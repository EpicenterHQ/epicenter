# Whispering

Press a shortcut, speak, and get the text on your clipboard. Whispering
records on your device, transcribes there too with a model it downloads
once, or with a transcription server you choose, can have a chat model
clean up the text, and keeps every recording and transcript as files you
can open.

It runs in two places from the same page: a desktop app (Tauri) and a
browser tab. Only the desktop app transcribes on the device; a browser tab
needs a server.

```bash
bun dev:whispering           # the page in a browser, on port 1420
bun dev:whispering:desktop   # the desktop app
```

Run both from the repository root.

The desktop app's program also transcribes a file from a terminal, with no
window, using a model already downloaded:

```bash
whispering --transcribe-file talk.wav --model parakeet --json
```

## What it stores

The desktop app keeps its files in the app's local data directory. A browser
keeps the same files in its Origin Private File System, which belongs to the
page's origin and is not visible in Finder. Whispering asks the browser to
keep them when space runs low (`navigator.storage.persist()`); a browser
that says no may clear them.

```txt
settings.json           one key per setting: what transcribes, the microphone, shortcuts, cleanup
dictionary.txt          words to spell as written, and `heard -> written` fixes
cleanup.md              your own cleanup prompt; without it, the built-in one
recordings/<id>.md      the note: the text you got as the body; front matter holds
                        durationMs, and `original` when cleanup changed the text
recordings/<id>.webm    the audio (.m4a when the recorder made MP4)
```

A recording's id starts with the time it began, so a list of files sorts by
time and a recording whose note never got written still has a time.

A model's file is not here either: it is in the Hugging Face cache
(`~/.cache/huggingface/hub`), which other apps on the computer share.

No server's API key is in these files. The desktop app
keeps it in the macOS Keychain; a browser keeps it in `localStorage`.

## Code layout

Each layer imports only from the layers below it.

```txt
src/
  app.css                    the shared Epicenter styles, then Whispering's own colors
  routes/                    screens: read through queries, write through mutations
    +layout.svelte           what every window shares: the stylesheet
    Pill.svelte              the floating pill, shared by its window and the preview
    pill/                    the pill's own window; shows what the main window sends
    (app)/                   the main window (a route group: no part of any address)
      +layout.svelte         the sidebar frame; hands the screens the real dictation
      +page.svelte           Home: the recorder or the first run, what dictation needs, the latest take
      recordings/            the list and the reading pane, chosen by `?id=`
      PageHeader.svelte      a page's name and the line under it
      settings/<section>/    one page per settings section, built of SettingsSection and SettingsRow
      preview/               development only: the screens fed a made-up dictation
  lib/
    dictation-view.ts        what a screen may know about dictation (`DictationView`)
    dictation.svelte.ts      live state, hands-free, and record → save → transcribe → clean up → copy
    queries.ts               the cache: TanStack Query over data/, keys, models, and microphones
    model-downloads.svelte.ts  how far each model download is, for any screen
    data/
      recordings.ts          the rules for recordings/ (no cache)
      settings.ts            the rules for settings.json (no cache)
      text-files.ts          dictionary.txt and cleanup.md, read and written whole (no cache)
    platform/
      index.ts               chooses desktop or browser, once
      files/                 files.ts (contract), tauri.ts, opfs.ts
      recorder/              recorder.ts (contract), native.ts, browser.ts
      servers/               servers.ts (contract), native.ts, browser.ts
      shortcuts/             shortcuts.ts (contract), native.ts, browser.ts: keys that work from any app
      local/                 local.ts (contract), native.ts, browser.ts: models on this computer
      pill/                  pill.ts (contract), native.ts, browser.ts: the two windows talking
    cleanup.ts               pure rules: the dictionary, when cleanup runs, what it is told
    shortcut.ts              pure rules: a shortcut's keys from a key press, and as a person reads them
    shortcut-holds.svelte.ts which shortcuts are held now, and why one is not
    loudness.ts              a microphone's level as how loud it sounds, for every meter
    feed.ts                  pure rules: a recording's time, day, search match, and how much was dictated
    transcription-server.ts  the server's address and model, and presets
src-tauri/src/
  cli.rs                     `--transcribe-file`: a transcript from a terminal, with no window
  files.rs                   reads many files in one call, sizes a directory, opens the folder
  keys.rs                    the Keychain
  servers.rs                 transcription and cleanup requests, with the key
  local.rs                   transcribes a recording with a model on this computer
  pill.rs                    the pill's window: a panel over every app that never takes focus
  shortcuts.rs               holds the global shortcuts the page names
  main.rs                    commands and plugins
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
- **`settings.json` is one flat object, and every key has a default.** A
  key reads `group.name`, as in `transcription.server.baseUrl`; a typebox
  schema in `data/settings.ts` holds each key's type and default, and the
  `Settings` type comes from it. A missing file or a mistyped value reads
  as the default, so no screen handles a missing key, and one bad value
  costs one setting. Both transcription providers stay in the file while
  `transcription.provider` names the one in use; code asks `transcriber()`
  and gets exactly one of the two. Refused: nested groups with optional
  fields, where changing one value meant rewriting its group and "not set
  up" was a missing key; and a union in the file, which would forget the
  server's address on a switch to the on-device model, though cleanup
  still needs it.
- **Recordings are kept forever unless a number of days is chosen.**
  `recordings.keepDays` is null or a count of days; an older recording is
  deleted, note and audio, after the next take and when the app opens. A
  recording's age is read from its id. Choosing fewer days asks first and
  says how many recordings go. Refused: a limit by count ("the last 100")
  beside the limit by days, a second mode for the same wish.
- **The desktop API key lives in the Keychain and only Rust reads it.** The
  page sends a request and never holds the key. Refused: `localStorage` on
  the desktop, which is a plain file on disk and puts the key in the page.

### Platform

- **Desktop and browser are chosen in one file, `platform/index.ts`.** Each
  capability that differs has a contract type and two implementations, and
  nothing else imports Tauri. Refused: an `isTauri()` check inside each
  module, which spreads the question of where the page runs across the code.
- **The desktop app transcribes on this computer unless a server is
  chosen.** A fresh install needs one model download and no account, key or
  network after it. The engine is transcribe.cpp, in the transcription
  plugin, which also lists, downloads and removes models; `local.rs` reads
  the recording and runs the model, as `servers.rs` reads it and sends it.
  Parakeet, the default, takes no dictionary words as hints; the
  dictionary's replacements still apply to its text. Refused: a server as
  the only way, which left a new install doing nothing until an address
  and a key were typed in.
- **Hands-free listens in the recorder plugin, with the microphone left
  open.** The plugin keeps the last half second it heard, so a take starts
  before the first syllable, and ends it after 1.2 seconds without a
  voice; the detector is `earshot`, about 95 KiB of Rust with no model
  file. The page names each take as its phrase starts, so the id still
  holds the time it began. A take with no words in it (a cough, a door) is
  deleted without a message. Refused: watching the level in the page and
  starting a recording when it rises, which opens the microphone after
  the speech began; and Silero through ONNX Runtime, about 8 MB more for
  the same job.
- **Hands-free is on for one run of the app.** Nothing in `settings.json`
  turns it on, so the app never opens a microphone at launch. While it
  listens, the Record button and the shortcut turn it off. Refused: a
  saved switch, which leaves a microphone open after a restart that the
  person did not ask for.
- **A shortcut is a chord the system holds, and hold to talk is a chord
  held down.** `settings.json` names three (`shortcut.toggle`,
  `shortcut.hold`, `shortcut.handsFree`); Rust holds them and sends each
  press and release, and the page decides what they do. A hold let go
  within 300 ms is thrown away as a slip. A chord another app holds leaves
  that one shortcut off and says so on its settings row. Refused: the Fn
  key or a modifier alone, which the system's shortcut API cannot hold;
  they need a raw keyboard listener and macOS's Accessibility grant, which
  Whispering had and deleted (`docs/history.md`, 2026-06-18).
- **`--transcribe-file` runs the app's own model code and reads nothing
  of the app's.** It names a downloaded model and a file, prints the
  model's words, and exits before any window or plugin starts. Refused,
  until someone needs them: reading `settings.json` for a default model,
  applying `dictionary.txt`, whose rules are TypeScript, and sending the
  file to a server, which needs the Keychain.
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
- **A saved cleanup model can be off.** `cleanup.enabled` is apart from
  `cleanup.model`, so a slow day does not mean retyping the model. Refused: cleanup on whenever a model is saved, and a second
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
- **The sidebar holds three places; Settings lists its own sections.** Home,
  Recordings and Settings, with a mark on Settings while dictation needs
  something set there; each section is its own page, so a fix links straight
  to it. A narrow window folds the sidebar to icons and the sections to tabs.
  Refused: every section in the sidebar, which made it read as a control
  panel, and one long settings page, which no fix can link into.
- **Whispering keeps its own colors, the navy it had through version 7.**
  `src/app.css` sets them over the shared theme: a deep blue page, cards a
  step lighter, borders a faint line. Only colors differ; the components,
  the radius and the fonts are the shared ones. Refused: the shared
  graphite, on which this app's flat pages read as grey and unfinished.
- **Every page opens with its name and one line about it, and a setting
  is a row in a card.** `SettingsSection` is a heading over one card;
  `SettingsRow` puts what a setting is on the left and its control on the
  right, with a switch for on or off. Refused: forms of stacked fields
  straight on the page, which gave each settings page its own shape.
- **Home is three numbers, the recorder in a card, and the latest takes.**
  The numbers (days, words, words a minute) are counted from the
  recordings each time, and show once there is a word.
- **The microphone picture is the record button, and the voice is the
  only motion.** It sits centred in the card under a soft light; recording,
  the light turns red and brightens with the voice, and bars ripple out
  from both sides of the microphone, each one a moment behind the one
  before (`VoiceWave`). Refused: a ring or a badge around the picture,
  which read as decoration on a finished object; an icon on a tile, which
  any app could have; and the picture alone on an empty page.
- **Home says what is wrong once, in words.** A missing setup is one line
  under the recorder, and the sidebar only marks Settings. Refused: a card,
  a status count and a summary line saying the same thing three times.
- **The first run is Home while the chosen model is not downloaded.** One
  button downloads it, with its progress, and the recorder returns when
  the file is there. Home works this out from the settings and the models
  on the computer, so removing the model brings the panel back. Refused: a
  wizard of steps, and a "set up" flag in `settings.json`, which can
  disagree with what is on disk.
- **The pill is its own window, and the main window tells it what to show.**
  Dictation runs once, in the main window, which sends the pill its state
  about twenty times a second; the pill sends back Stop, Cancel and clicks.
  On a Mac the window is a non-activating panel, so pressing Stop never
  pulls Whispering over the app being dictated into. Refused: a plain
  always-on-top window, which activates the app on every click, and a
  second copy of dictation in the pill's window, which would record twice.
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
