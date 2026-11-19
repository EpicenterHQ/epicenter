<h1 align="center">Whispering</h1>
<p align="center">Record, transcribe, and keep it all as files.</p>

Whispering is an app for voice notes. It records audio, transcribes it with
an OpenAI-compatible endpoint you choose, and keeps every recording and
transcript as an ordinary file on your own device. It needs no account and
no server.

Each note is Markdown with its fields in front matter, one `key: <JSON>`
line each. `src/lib/format/layout.ts` declares the paths and each note's
fields. Any program that writes this layout is a valid writer.

| Path | What it is |
| --- | --- |
| `recordings/<id>.md` | A recording: `title`, `recordedAt`, `durationMs` in front matter, your notes in the body. |
| `recordings/<id>.<ext>` | Its audio: `m4a` (AAC) or `webm` (Opus) from a browser, `webm` (Opus) from the desktop app. Audio with no note lists as an untitled recording. |
| `transcriptions/<id>.md` | A transcript: the `recordingId` it was made from, `createdAt`, `model`, `endpoint`; the transcript is the body. |
| `settings.md` | Your settings: the transcription model, your connections (never their keys), and the desktop app's global shortcut (absent: `CommandOrControl+Shift+;`). |

An id is when the file was made plus a random suffix (`timeId()`). A file's
id is its identity: renaming a recording changes its `title`, never its path,
so a transcript's `recordingId` never breaks.

## Where the files are

Whispering keeps its files on the device it runs on (see
[The folder](#the-folder) under Decisions):

- **The desktop app** keeps them in `data/` in its local data directory
  (on macOS, `~/Library/Application Support/so.epicenter.whispering/data`).
  Settings shows the folder, with Show in Finder, Copy path, and Change….
  Pick an empty folder, such as one a file syncer keeps, and the
  recordings move into it; pick a Whispering folder (one holding
  `settings.md` or `recordings/`) and it opens, the old one left where it
  was; any other folder is refused. Two folders are never merged.
  Uninstalling the app or clearing its data removes the default folder
  with it. When the folder is in a Git repository, Settings says whether
  its audio would go into Git whole (no Git LFS rule for `.webm`) and that
  audio deleted here stays in the repository's history.
- **Audio is kept** until you delete it. Settings shows how much there is
  and deletes audio older than a time you pick; a recording keeps its note
  and transcripts.
- **The web app** keeps them in the browser's Origin Private File System, in
  the same layout. It asks the browser to keep them, shows how much it
  stores, and offers Export as zip, because a browser may clear a site's
  storage. It runs where a page can write files whole (`createWritable()`):
  Chrome, Firefox, and Safari 26 or later.

Whispering runs in one place at a time: a second desktop window focuses the
first, and a second browser tab says Whispering is open in another tab and
waits until that one closes. It reads its folder again when its window
regains focus, so a change another program made shows then. It never
replaces a note that changed since it showed it: it shows the newer text
instead.

A note at one of these paths that does not read is listed under "Needs
repair" with why and its text. Saving fixed text there writes it; text that
still does not fit is written as typed and stays listed to fix.

What belongs to one computer stays out of the folder: a connection's key is
in the Keychain on the desktop and in the site's `localStorage` in a
browser, and the folder's location and the chosen microphone are in
`localStorage`.

## Using it

Whispering has three pages, switched by the sidebar on a wide window and a
bar at the bottom on a narrow one. Each has its own address, so back,
forward, and refresh work. Changing pages keeps everything in progress: a
recording keeps recording, a request keeps running, and what you typed is
already saved.

| Page | Path | What it is for |
| --- | --- | --- |
| Home | `/` | The recorder, and the newest recording with its transcript. |
| Recordings | `/recordings` | Search, sort, and select recordings; play, transcribe, and edit beside the table. |

The header has a recorder control on every page but Home, and Settings
(the transcription model, its connections, the folder, and on
the desktop the shortcut and transcription in the app).

### Recording

Press the microphone on Home to start and again to stop. The take is kept
in the page's memory while it records (AAC in `.m4a`, else Opus in
`.webm`), and nothing is sent; Stop writes the audio to the folder at
once, then a note beside it titled with the time and holding its length,
and the recording appears in the list. If the audio cannot be written, the
recording fails and says why; if only the note cannot, the audio lists as
an untitled recording. While a take runs, leaving the page asks first.

The web app does not promise to keep a take through a crash or a closed
tab: one cut off that way is lost. The desktop app keeps it (see
[Web and desktop](#web-and-desktop)).

### Recordings

The table starts at full width; activating a recording opens its details
beside it (in place of it on a narrow window). Search matches the title,
notes, id, and every transcript, with an excerpt of the match. Sort by any
column; tick rows to transcribe the ones with no transcript, copy their
newest transcripts, or delete them. A search keeps hidden ticks; actions use
only the ticked rows shown.

A recording's details hold its player, its transcripts (each edited where it
is read, with Copy and Delete), its notes, and File details:
where it is kept, which files it has, and when it was made. The title and
every text save as you type. A save that fails keeps what you typed and says
why, with Try again and Discard changes; one refused because the note
changed elsewhere offers Keep mine and Show the newer text. Leaving the page
with unsaved typing asks first.

Deleting a recording deletes its note, its audio, and its transcripts. It
is refused while it is being transcribed, and while a transcript does not
read (it might be this recording's).

### Transcription

**Transcribe** sends the recording's audio to the transcription model and
keeps the transcript as a new note when the answer arrives. Nothing is
transcribed until you press it. While the request is out, the recording says
so. If no answer comes, or the transcript cannot be saved, it says why
where you pressed it, with **Try again** (sends the recording's audio
again, to the model chosen then) and **Dismiss**. Nothing is kept for a
failed transcription.

### Under the recorder

Two controls sit beside the microphone on Home:

- **Microphone input.** System default, or one microphone by the id the
  browser lists it under. Listing never asks for access; **Enable
  microphones** does. A chosen microphone that is not connected refuses the
  recording; no other is used in its place. **Test microphone** shows its
  level and records nothing. The choice applies to the next recording and is
  kept in this computer's `localStorage`, never in Whispering's files.
- **Transcription model.** The transcription part of Settings, the same
  choice.

### Models and connections

Settings chooses the **Transcription** model from every endpoint
Whispering can reach (see [Models and keys](#models-and-keys)): each connection you saved (a
provider's base URL and an optional key), Ollama and LM Studio when they run
on this computer, and on the desktop transcription in the app itself. The
same picker adds, edits and removes a connection. The choices and the
connections are in `settings.md`; each key stays on this computer (the
Keychain on the desktop, `localStorage` in a browser), and Settings says
where.

- Nothing is sent until you press Transcribe. Choosing a model sends
  nothing; adding a connection may ask its endpoint which models it serves.
- A request goes only to the endpoint and model chosen when it was prepared,
  and is refused, with nothing sent, if that connection was removed or now
  sends elsewhere. A key is sent only to the base URL it was entered for,
  never carried by a redirect, and removed from any error that echoes it.
- The web app's tab sends requests itself, so a connection's endpoint must
  allow the page's origin (CORS); many hosted providers refuse that. The
  desktop app sends through Tauri's HTTP plugin, which no endpoint's CORS
  refuses. Code running on Whispering's page can read a key it holds, so
  the page loads no remote script.
- If no answer arrives, the request may have been answered with the reply
  lost; the app says the outcome is unknown and never sends it again on its
  own.

## Run it

From the repository root:

```sh
bun dev:whispering                         # Vite dev server on http://localhost:1420
bun run --cwd apps/whispering build        # static files in apps/whispering/build/
bun run --cwd apps/whispering test         # unit tests (Svelte's browser runtime)
```

The build is static: any host that answers unknown paths with `index.html`
serves it.

## The desktop app

```sh
bun dev:whispering:desktop     # from the repository root; needs a Rust toolchain
bun build:whispering:desktop   # a local, unsigned macOS app bundle
```

The page is the web's own build (`build/`, the dev server in development).
One build serves both (see [Web and desktop](#web-and-desktop)),
and `src/lib/app.ts` makes every capability once, for the page's life:

| Capability | In a browser | In a Tauri window |
| --- | --- | --- |
| `folder` (`openFolder` over `Files`) | `opfsFiles('data')` | `tauriFiles` over the picked folder, else `data/` in the app's local data directory |
| `recorder` (from `@epicenter/recorder`) | the WebView's microphone, the take in memory | the shell's microphone |
| `ai`: `customEndpoints()`, `localServers()` (from `@epicenter/ai`) | requests with the page's `fetch` | requests through `@tauri-apps/plugin-http` |
| a connection's key (`secrets` in `src/lib/this-computer.ts`) | `localStorage` | the Keychain, through `secret_get` and `secret_set` |
| `speech` (`localSpeech()` from `@epicenter/transcription`) | `null` | transcription in the app |
| `shortcut` (`openShortcut` in `src/lib/shortcut.ts`) | `null` | the global shortcut |

- **The folder** is read and written through five of Whispering's own
  commands in its shell (`files_read`, `files_read_many`, `files_write`,
  `files_list`, `files_remove`). Each checks the folder against the app's
  grant: the default folder, which the shell allows at start, or the
  folder picked in Settings, which the system's folder dialog grants and
  `tauri-plugin-persisted-scope` restores at each start. The path itself
  is kept in `localStorage`. A write goes to a hidden temporary file
  beside its target, and is renamed over it.
- **Recording** goes through the shell's microphone
  (`tauri-plugin-epicenter-recorder`), which encodes Opus in WebM at
  `recordings/<id>.webm` from its first second, and finishes it there at
  Stop. A recording a crash cut off stays as it is and lists as an
  untitled recording.
- **Transcription on this computer** runs in the app
  (`localSpeech()` from `@epicenter/transcription`, models downloaded in
  Settings), which takes the recording's audio as an upload.
- **The global shortcut** starts and stops a recording from any app:
  `shortcut` in `settings.md`, `CommandOrControl+Shift+;` by default. The
  page asks the shell to hold it (`set_shortcut`) once the folder is read
  and whenever it changes; a key that does not parse or that another app
  holds is refused before anything is written, the reason shown in
  Settings. The Settings field records the keys pressed in it
  (`acceleratorOf`, by each key's place on the keyboard): a modifier other
  than Shift and a key, or a function key; ⌘ on a Mac and Ctrl elsewhere
  are both `CommandOrControl`. Escape lets go of what was pressed; Tab
  moves on.
- **One window**: the single-instance plugin focuses the open window
  instead of starting a second.

`cargo test -p whispering` checks the identity, the file system plugin's
configuration, that the capability grants exactly the plugins' permissions
and the commands the build script declares, and how an accelerator parses.

## What is not supported

- Syncing between devices. A recording reaches another device by export, or
  by keeping the desktop folder in a file syncer.
- Importing a zip the web app exported, and importing from Whispering 7.
- In the web app, keeping a take through a crash or a closed tab, recording
  in the background, and a global shortcut: these are the desktop app's.
- Two tabs or windows at once.
- Epicenter's hosted models. They come back as a connection in a later
  change.
- Deleting old audio in bulk, and showing the audio's size.
- A Files view, a Source tab for notes that read, renaming files, and files
  outside this layout. A note that does not read is repaired as text where
  it is listed.
- System-wide dictation beyond the desktop's one start-and-stop shortcut:
  push-to-talk, voice-activated recording, and delivering text to the
  cursor. Copy buttons are the only way text leaves the app.
- Automatic transcription. It is a button you press, so nothing is sent to
  a paid endpoint on its own.
- Transformations: instructions run on a transcript or on pasted text, and
  post-processing. They wait for a later release; the last version of their
  pages is at the tag `whispering-transformations`.
- Transcription on this computer in the web app, and importing audio files.
- Windows and Linux are untested.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for how the pieces fit.

## Decisions

These are the rules an agent or a contributor would most likely undo by
mistake. Each says why, and names a tempting alternative that lost. Change
a rule here in the same pull request as the code. `AGENTS.md` holds how the
code is arranged.

### The folder

- **Whispering keeps everything in one folder on the device it runs on, and
  needs no account, server, Git, or Epicenter.** It commits only to its
  file format, and a browser tab or a phone has no Git to clone into.
  Refused: a Git clone of an Epicenter's data; IndexedDB in the browser.
- **Whispering is the folder's one writer.** The desktop app is
  single-instance, and a second browser tab waits for the first one's Web
  Lock and never takes it. With one writer there is nothing to merge.
  Refused: several tabs with per-file locks.
- **Whispering reads the folder again when its window regains focus, and
  never writes over a note that changed since it was shown.** A file syncer
  or Git may change the folder while the app runs.
  Refused: a file watcher.

### Recording

- **Nothing repairs a take a crash cut off.** On the desktop a take is
  written at its final path from its first second, and an unfinished WebM
  of whole blocks already plays, so it stays as it is and lists as an
  untitled recording.
  Refused: recovering cut-off takes at launch; a `.part` file renamed at
  Stop.
- **A recording's length is its note's `durationMs`, written at Stop.** A
  take with no note is rare, and parsing length from audio was a large
  amount of WebM code for it.
  Refused: reading the length from the audio bytes.

### Transcription

- **A transcription goes only to the endpoint and model chosen when it was
  prepared.** A removed, moved, or unset choice refuses it with nothing
  sent. Changing a setting must never send audio somewhere the person did
  not choose for it.
  Refused: falling back to another endpoint or model.
- **A request to transcription on this computer names its model every
  time, and the plugin refuses one that is not downloaded.** The transcript
  records exactly which model made it, and a copy of the app's choice kept
  in Rust went stale.
  Refused: one active model that the picker sets.
- **The plugin's Rust side owns the model files and the clock that unloads
  an idle model.** A backgrounded page throttles its timers exactly when an
  idle model should unload.
  Refused: the page reading the models folder; a page-owned unload timer.

### Models and keys

- **Every source of models is an endpoint in one `openAi([...])`: saved
  connections, Ollama and LM Studio when they run, and on the desktop
  transcription in the app.** One OpenAI-compatible request reaches every
  source, so adding a source is one entry.
  Refused: routing per provider in the app.
- **A connection's key is sent only to the base URL it was entered for,
  and a request follows no redirect.** `settings.md` is portable and other
  programs may edit it, so a file must never be able to send a key to a new
  host.
  Refused: one key bound to whatever URL is configured.
- **A key stays on this computer: a Keychain item on the desktop and
  `localStorage` in a browser, never in the folder, a log, or an error.**
  The folder may sit in Git or a file syncer, and the desktop's
  `localStorage` is a plain file any program can read.
  Refused: keys in the folder; encrypting browser keys with WebCrypto,
  since the page that reads them can decrypt them.
- **The page sends every request itself and loads no remote script.** Code
  on the page can read a key the page holds, and a browser has no shell to
  relay through.
  Refused: the desktop shell sending every request that carries a key.
- **Whispering is free and has no sign-in.** A local model needs no
  service, and payment buys an operated service, not the software.
  Refused: a sign-in every person passes.

### Web and desktop

- **Whispering branches on what a capability offers, never on the
  platform, and one build serves the browser and the Tauri window.** A fix
  tried on one is the fix shipped to the other. A capability a place lacks
  is `null` there.
  Refused: a second desktop build; `#platform/*` files per surface.
- **The web app and the desktop app each use what their platform gives,
  and parity is not a goal.** Keeping a take through a crash, the global
  shortcut, and transcription on this computer are the desktop's. Stating
  the web's limits keeps the browser build small.
  Refused: browser machinery that imitates a desktop guarantee.
- **The desktop's global shortcut is one chord held by
  `tauri-plugin-global-shortcut`.** One backend works on every platform
  with no Accessibility grant.
  Refused: a raw keyboard listener (`rdev`, a macOS `CGEventTap`); Fn or a
  modifier alone as a binding.
