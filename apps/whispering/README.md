<h1 align="center">Whispering</h1>
<p align="center">Record, transcribe, transform, and keep it all as files.</p>

Whispering is an app for voice notes. It records audio, transcribes it with
an OpenAI-compatible endpoint you choose, turns a transcript into another
text with instructions you write, and keeps every recording, transcript,
instruction, and result as an ordinary file on your own device. It needs no
account and no server.

Each note is Markdown with its fields in front matter, one `key: <JSON>`
line each. `src/lib/format/folder.ts` declares the paths and each note's
fields. Any program that writes this layout is a valid writer.

| Path | What it is |
| --- | --- |
| `recordings/<id>.md` | A recording: `title`, `recordedAt`, `durationMs` in front matter, your notes in the body. |
| `recordings/<id>.<ext>` | Its audio: `m4a` (AAC) or `webm` (Opus) from a browser, `webm` (Opus) from the desktop app. Audio with no note lists as an untitled recording. |
| `transcriptions/<id>.md` | A transcript: the `recordingId` it was made from, `createdAt`, `model`, `endpoint`; the transcript is the body. |
| `transformations/<id>.md` | A transformation: a `title` and an optional `model` (`null` uses the text model chosen in Settings); its instructions are the body. |
| `transformation_runs/<id>.md` | A transformation applied to a transcript: what it came from, when, the model and endpoint, and the exact `prompt` and `input` sent; the answer is the body. |
| `text_runs/<id>.md` | The same, applied to pasted text; it names no recording. |
| `settings.md` | Your settings: the model for each job, your connections (never their keys), and the desktop app's global shortcut (absent: `CommandOrControl+Shift+;`). |

An id is when the file was made plus a random suffix (`timeId()`). A file's
id is its identity: renaming a recording changes its `title`, never its path,
so a transcript's `recordingId` never breaks.

## Where the files are

Whispering keeps its files on the device it runs on
([ADR-0894](../../docs/adr/0894-whispering-8-keeps-its-recordings-and-their-audio-in-its-own-data-directory-and-needs-no-epicenter.md)):

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
| Transformations | `/transformations` | The instructions you apply to transcripts or pasted text, and their results. |

The header has a recorder control on every page but Home, and Settings
(the transcription and text models, their connections, the folder, and on
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
tab: one cut off that way is lost. The desktop app keeps it
([ADR-0780](../../docs/adr/0780-a-surface-uses-what-its-platform-gives-and-parity-is-not-a-goal.md)).

### Recordings

The table starts at full width; activating a recording opens its details
beside it (in place of it on a narrow window). Search matches the title,
notes, id, and every transcript, with an excerpt of the match. Sort by any
column; tick rows to transcribe the ones with no transcript, copy their
newest transcripts, or delete them. A search keeps hidden ticks; actions use
only the ticked rows shown.

A recording's details hold its player, its transcripts (each edited where it
is read, with Copy, Transform, and Delete), its notes, and File details:
where it is kept, which files it has, and when it was made. The title and
every text save as you type. A save that fails keeps what you typed and says
why, with Try again and Discard changes; one refused because the note
changed elsewhere offers Keep mine and Show the newer text. Leaving the page
with unsaved typing asks first.

Deleting a recording deletes its note, its audio, its transcripts, and the
results made from them. It is refused while a request for
it runs or its answer waits to be saved again, and while a transcript or
result does not read (it might be this recording's). A result on pasted text is never deleted with a recording.

### Transcription

**Transcribe** sends the recording's audio to the transcription model and
keeps the transcript as a new note when the answer arrives. Nothing is
transcribed until you press it. While the request is out, the recording says
so. If no answer comes, it says why with **Run again** (the same request, to
the same endpoint and model, and only while that endpoint is still where it
was) and
**Dismiss**. When the answer arrives its transcript is saved. If it cannot
be saved, the answer stays on screen with **Save again**, which writes it
without a second request, and **Discard answer**.

### Transformations

A transformation is a title and instructions you reuse: clean up dictation,
summarize, draft an email. **New** offers three starters and an empty one;
nothing is created until you choose. Where a run is sent is the text model's
endpoint, never the file; a model typed in a transformation is sent to that
endpoint instead of the text model.

Run one from a transcript's **Transform** menu, or from **Try it** on its
page, on a chosen transcript or on pasted text (no recording needed; the
pasted text stays while you move around and is written only into a result).
Running sends one request, a chat completion at the text model's endpoint, with
the instructions as shown (typing included) as the system message and the
text as the user message. The answer becomes a new result note; the
transcript is never changed. A result records the exact instructions and text
sent, so it still reads correctly after its transformation changes or goes;
deleting a transformation keeps its results. When a transformation cannot
run, Try it says why and offers the fix it can.

### Under the recorder

Three controls sit beside the microphone on Home:

- **Microphone input.** System default, or one microphone by the id the
  browser lists it under. Listing never asks for access; **Enable
  microphones** does. A chosen microphone that is not connected refuses the
  recording; no other is used in its place. **Test microphone** shows its
  level and records nothing. The choice applies to the next recording and is
  kept in this computer's `localStorage`, never in Whispering's files.
- **Transcription model.** The transcription part of Settings, the same
  choice.
- **Post-processing.** None, or one of your transformations. Choosing sends
  nothing: **Run post-processing** on the latest transcript does, exactly as
  Transform would. A choice that was deleted or cannot run says why.

### Models and connections

Settings chooses two models, **Transcription** and **Text**, from every
endpoint Whispering can reach (ADR-0757): each connection you saved (a
provider's base URL and an optional key), Ollama and LM Studio when they run
on this computer, and on the desktop transcription in the app itself. The
same picker adds, edits and removes a connection. The choices and the
connections are in `settings.md`; each key stays on this computer (the
Keychain on the desktop, `localStorage` in a browser), and Settings says
where.

- Nothing is sent until you press Transcribe or Run. Choosing a model sends
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
One build serves both
([ADR-0781](../../docs/adr/0781-apps-branch-on-what-a-capability-offers-and-one-build-serves-every-surface.md)),
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
  is kept in `localStorage`. A write is staged in `local/.tmp/` in the
  app's local data directory and renamed into the folder, so the folder
  only ever holds finished files.
- **Recording** goes through the shell's microphone
  (`tauri-plugin-epicenter-recorder`), which encodes Opus in WebM from the
  first sample into the take `local/recording/<id>.webm`, outside the
  folder, and places it at `recordings/<id>.webm` when Stop answers. A recording a quit or a
  crash cut off is finished and placed on the next launch, in the
  background beside the pages, and lists as an untitled recording.
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
- Automatic transcription or transformation. Each is a button you press, so
  nothing is sent to a paid endpoint on its own.
- Transcription on this computer in the web app, and importing audio files.
- Transformations beyond one prompt and one request, and a connection or
  key per transformation.
- Windows and Linux are untested.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for how the pieces fit.
