<h1 align="center">Whispering</h1>
<p align="center">Record, transcribe, transform, and keep it all as files.</p>

Whispering is an app for voice notes. It records audio, transcribes it with
an OpenAI-compatible endpoint you choose (or Epicenter's hosted API), turns a
transcript into another text with instructions you write, and keeps every
recording, transcript, instruction, and result as an ordinary file.

Those files follow Whispering's contract, `src/lib/contract.ts`, published
unchanged as `static/contract.json` (`bun run contract` rewrites it after a
change), the file `epicenter check <dir> --contract <url>/contract.json` checks a folder
against. Any program that writes the layout is a valid writer.

| Path | What it is |
| --- | --- |
| `recordings/<id>.md` | A recording: `title`, `recordedAt`, `durationMs` in front matter, your notes in the body. |
| `recordings/<id>.<ext>` | Its audio: `m4a` (AAC) or `webm` (Opus) from a browser, `webm` (Opus) from a desktop. |
| `transcriptions/<id>.md` | A transcript: the `recordingId` it was made from, `createdAt`, `model`, `endpoint`; the transcript is the body. |
| `transformations/<id>.md` | A transformation: a `title` and an optional `model` (`null` uses the text model chosen in Settings); its instructions are the body. |
| `transformation_runs/<id>.md` | A transformation applied to a transcript: what it came from, when, the model and endpoint, and the exact `prompt` and `input` sent; the answer is the body. |
| `text_runs/<id>.md` | The same, applied to pasted text; it names no recording. |
| `shortcuts.md` | The desktop app's global shortcut, `toggleRecording` (absent: `CommandOrControl+Shift+;`). The web app has none and leaves it. |

An id is when the file was made plus a random suffix (`timeId()`). A file's
id is its identity: renaming a recording changes its `title`, never its path,
so a transcript's `recordingId` never breaks. The one setting in its files
is the desktop shortcut; its connections and the chosen microphone belong to
one device and stay on it.

Whispering on the web runs in a browser tab over the signed-in person's
repository and keeps nothing in the browser. Its desktop app keeps the
files in a folder on the computer (see [The desktop app](#the-desktop-app)).
Both are the same pages, from one build, over the same contract; Whispering
itself moves no files between them (decision 77).

## Where the files are

Whispering on the web is online
([ADR-0786](../../docs/adr/0786-every-web-app-is-online-and-browser-storage-leaves-the-platform.md)):
its files are the folder attached to Whispering on the server (a repository
at `/folders/<id>`), through the account (`openFolder(whispering, home({ site, account }))` in
`src/lib/app.ts`), at the same paths a folder holds. Signed out it asks for
a sign-in (`src/lib/components/SignIn.svelte`); signed in, every recording,
edit, transcript and result is a commit there, and nothing is kept in the
browser. It needs the network; there is no browser copy to fall back on
([ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)).

- A recording lands whole at Stop: its audio, kept by its SHA-256, then its
  note with its length (see [Recording](#recording)). Nothing is sent while
  it records, and recording never waits on the network.
- Transcripts, transformations, and their results are kept beside it when
  they are made.
- Changes another tab makes show without a reload.
- A note at one of these paths that does not read is listed under "Needs
  repair" with why and its text. Saving fixed text there writes it; text
  that still does not fit is written as typed and stays listed to fix.

The header's status line says where the recordings are, "Your repository",
and whether it answers: Online, Offline when it does not, or Sign in again
when the sign-in needs renewing.

### Signing in

On the web the sign-in holds the recordings, so Whispering asks for it
before it opens, and signing out asks for it again. The same sign-in adds
Epicenter's models, listed beside every other model for transcription and
text, which send through Epicenter's hosted API. In the desktop app signing
in is optional, from Settings, and only adds Epicenter's models; it never
moves a recording, and signing out keeps every one.

The app signs in as `so.epicenter.whispering` (`connectAccount()` in
`src/lib/app.ts`) and asks for what each capability given the account says
it needs: `home` the repository, `hosted(account)` the AI gateway
([ADR-0792](../../docs/adr/0792-an-account-asks-for-what-the-capabilities-that-take-it-need.md)).
It has no automatic renewal, so a timer never navigates away mid-recording.
The server is `VITE_EPICENTER_SERVER` at build time, else Epicenter's.

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

The header has the status line, a recorder control on every page but Home,
and Settings (the transcription and text models, their connections, and
the sign-in).

### Recording

Press the microphone on Home to start and again to stop. The take is kept
in the page's memory while it records (AAC in `.m4a`, else Opus in
`.webm`), and nothing is sent; Stop writes the audio to the repository at
once, then a note beside it titled with the time and holding its length,
and the recording appears in the list
([ADR-0779](../../docs/adr/0779-a-store-is-four-verbs-and-a-browser-recording-lands-whole.md)).
While a take runs, leaving the page asks first.

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
every text save as you type. A save never fails: while the files cannot be
reached, a line at the top of the page says so, and every change waits, in
order, until they can.

Deleting a recording deletes its note, its audio, its transcripts, and the
results made from them. It is refused while a request for
it runs, and while a transcript or result does not read (it might be this
recording's). A result on pasted text is never deleted with a recording.

### Transcription

**Transcribe** sends the recording's audio to the transcription model and
keeps the transcript as a new note when the answer arrives. Nothing is
transcribed until you press it. While the request is out, the recording says
so. If no answer comes, it says why with **Run again** (the same request, to
the same endpoint and model, and only while that endpoint is still where it
was) and
**Dismiss**. When the answer arrives its transcript is saved, and the
recording says so until it is; while the files cannot be reached, the save
waits until they can, with no second request.

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
  kept in this computer's settings (`microphone.json`: this site's
  `localStorage`, or AppData on the desktop), never in Whispering's files.
- **Transcription model.** The transcription part of Settings, the same
  choice.
- **Post-processing.** None, or one of your transformations. Choosing sends
  nothing: **Run post-processing** on the latest transcript does, exactly as
  Transform would. A choice that was deleted or cannot run says why.

### Models and connections

Settings chooses two models, **Transcription** and **Text**, from every
endpoint Whispering can reach (ADR-0757): Epicenter's once you sign in, each
connection you saved (a provider's base URL and an optional key), Ollama and
LM Studio when they run on this computer, and on the desktop transcription
in the app itself. The same picker adds, edits and removes a connection.
Choices and connections stay on this computer, never in Whispering's
files: `models.md` and `connections.md` in this computer's settings (this
site's `localStorage`, or AppData on the desktop), with each key in this
site's `connection-keys.json`, or on the desktop in the app's
`credentials.json`.

- Nothing is sent until you press Transcribe or Run. Choosing a model sends
  nothing; adding a connection may ask its endpoint which models it serves.
- A request goes only to the endpoint and model chosen when it was prepared,
  and is refused, with nothing sent, if that connection was removed or now
  sends elsewhere. A key is kept only for the endpoint it was saved for,
  never carried by a redirect, and removed from any error that echoes it.
- The web app's tab sends requests itself, so a connection's endpoint must
  allow the page's origin (CORS). Most hosted providers refuse that;
  Epicenter's models work. A key saved here can be read by code running on
  the site, and Settings says so.
- Signed out, Epicenter's models send nothing and say to sign in.
- If no answer arrives, the request may have been answered with the reply
  lost; the app says the outcome is unknown and never sends it again on its
  own.

## Run it

From the repository root:

```sh
bun dev:whispering                         # Vite dev server on http://localhost:1420
bun run --cwd apps/whispering build        # static files in apps/whispering/build/
bun run --cwd apps/whispering test         # unit tests (Svelte's browser runtime)
bun run --cwd apps/whispering test:e2e     # Playwright, Chromium and WebKit
```

The build is static: any host that answers unknown paths with `index.html`
(for `/auth/callback`) serves it, at an origin the API registers.

`test:e2e` starts `e2e/stack.ts`: a disposable Postgres, the local API with
temporary Git and LFS stores, a person per browser with a desktop sandbox for
the `epicenter` CLI, and the app built against that API on
`http://localhost:1420` (which must be free). It walks one person through
five steps per engine (`e2e/whispering.spec.ts`): signed out, Whispering
asks for a sign-in, and signed in it records into the repository (audio and
note, never the browser's files), edits a title and a transcript,
transcribes over a stubbed custom endpoint, and deletes a recording, all
there after a reload; a take sends nothing until Stop, leaving
mid-recording loses it, and a stopped take lands as its audio and note
together; Epicenter's transcription model sends the account's API token (to
a stub of the API's transcription route) and keeps the transcript in the
repository; `epicenter clone` holds the recordings with their audio and
`epicenter check` passes; and signing out asks for a sign-in again, with
nothing left in the browser. `bun apps/whispering/e2e/stack.ts --demo` runs
the same stack to try by hand. It needs `initdb`, `pg_ctl`, `git`, and
`git-lfs` on `PATH`.

## The desktop app

```sh
bun dev:whispering:desktop     # from the repository root; needs a Rust toolchain
bun build:whispering:desktop   # a local, unsigned macOS app bundle
```

Its Tauri shell derives `~/Epicenter/whispering` and names it the Data root, or
`~/Epicenter Dev/whispering` in development. The page opens this folder,
making it when missing for now. What this computer alone keeps, the
shortcut's override, the connected endpoints, the model choices and the
microphone, is this computer's settings (`settings` from `@epicenter/local`:
files in AppData, written only by the shell), which the page connects to
beside the folder. A failed open shows the shared recovery screen with
Retry. The
status details and Settings show the shell's folder path. **Set up in
Epicenter** enrolls the folder for local history; connecting a repository
there enables transfer. Whispering does not sync it itself yet
([ADR-0785](../../docs/adr/0785-a-desktop-app-signs-in-to-sync-its-own-folder.md)).

The page is the web's own build (`build/`, the dev server in development).
One build serves both
([ADR-0781](../../docs/adr/0781-apps-branch-on-what-a-capability-offers-and-one-build-serves-every-surface.md)):
each capability package decides where the page runs and loads its desktop
code only there, and `src/lib/app.ts` makes every capability once, for the
page's life, with no branch of its own:

| Capability | In a browser | In a Tauri window |
| --- | --- | --- |
| `folder` (`home` from `@epicenter/folder`) | the person's repository | the data folder |
| `account` (`connectAccount()` from `@epicenter/account`) | browser OAuth | `createTauriAuth` over `epicenter-account` |
| `recorder` (from `@epicenter/recorder`) | the WebView's microphone, the take in memory | the shell's microphone |
| `ai`: `customEndpoints()`, `localServers()` (from `@epicenter/ai`) | requests from the tab | requests through the shell's fetch, each key kept by the shell |
| `speech` (`localSpeech()` from `@epicenter/transcription`) | `null` | transcription in the app |
| `shortcut` (`openShortcut` in `src/lib/shortcut.ts`) | `null` | the global shortcut |

The root renders the pages once the folder and the settings are open
(`<WhenOpen>` from `@epicenter/svelte`), or the recovery screen when one
cannot open. The views branch on what the capabilities offer: the header
shows `FolderChrome` (the folder's status and whether Epicenter syncs it) where
`folder.reveal` is there and `RepositoryChrome` (the repository's status
and Sign in again) otherwise, and Settings shows `FolderSettings`,
`SpeechSettings` and `ShortcutSettings` (in `src/lib/components/`) only
where there is a folder on this computer, transcription in the app, and a
shortcut. `connectionsNote` (`src/lib/connections-note.ts`) says where a
connection's key is kept and where its requests leave from.

- **Recording** goes through the shell's microphone
  (`tauri-plugin-epicenter-recorder`), which encodes a recording to Opus
  in WebM in the data folder from the first sample and places it at
  `recordings/<id>.webm` when Stop answers, in the same few milliseconds
  for a recording of any length. The call is the same as in a browser,
  `recorder.start({ files, path })` from `@epicenter/recorder`, which loads
  the shell's recorder in a Tauri window (decision 84). The note, with its
  length, is written once Stop has answered (`folder-recordings.ts`). A
  recording a quit or a crash cut off is finished, placed and given its
  note on the next launch, in the background beside the pages; it is at no
  data path until then, so nothing lists it first. The shell records into
  the data folder it opened for the page; the page names only the
  recording's path.
- **Requests** to a connection, and to Ollama and LM Studio, leave from
  Rust through the shell's one fetch (`connection_fetch` in
  `epicenter-account`), which adds a connection's key and sends only to the
  endpoint it was saved for, so no endpoint needs CORS; Epicenter's go
  through the account's relay (`account_fetch`, whose token the page never
  holds); transcription on this computer runs in the app
  (`localSpeech()` from `@epicenter/transcription`, models downloaded in
  Settings), which takes the recording's audio as an upload.
- **Connections** are AppData's `connections.md`, which records the
  endpoint each key was entered for and never the key
  (`customEndpoints()` from `@epicenter/ai`). **Keys** are in the app's
  `credentials.json` in AppData, which the shell keeps and no page reads
  (`connection_key_set`,
  [ADR-0740](../../docs/adr/0740-every-credential-an-app-holds-lives-in-its-own-place.md)).
  A debug build started with `EPICENTER_SECRETS_FILE=<path>` keeps its
  credentials in that file instead.
- **Sign-in** is optional, from Settings, and adds Epicenter's models. It
  is `so.epicenter.whispering.native` through the shared
  [`epicenter-account`](../../packages/tauri-epicenter-account/README.md)
  crate, in the system browser.
- **The global shortcut** starts and stops a recording from any app:
  `toggleRecording` in `shortcuts.md`, `CommandOrControl+Shift+;` by
  default. It resolves with a shallow spread, `{ ...defaults, ...data,
  ...here }`: the data folder's note travels with the files, and this
  computer's `shortcuts.md` (`settings.file('shortcuts.md')`, Settings' **Only
  on this computer**) overrides it here.
  Settings writes the data folder's note by default, and removes this
  computer's override when it does. The shell never reads the note: the
  page asks it to hold the resolved key (`set_shortcut`) at startup and
  whenever the key changes, and a key that does not parse or that another
  app holds is refused before anything is written, the reason shown in
  Settings. The Settings field records the keys pressed in it
  (`acceleratorOf`, by each key's place on the keyboard): a modifier other
  than Shift and a key, or a function key; ⌘ on a Mac and Ctrl elsewhere
  are both `CommandOrControl`, so a synced shortcut means the same on
  either. Escape lets go of what was pressed; Tab moves on.

`cargo test -p whispering` checks the identity, the native client id, that
the capability grants exactly the plugins' permissions and the commands the
build script declares, and how an accelerator parses.

## What is not supported

- Whispering syncing the desktop app's folder itself, which ADR-0785
  decides and is not built, or moving recordings between that folder and
  the repository.
- In the web app, keeping a take through a crash or a closed tab, recording
  in the background, working with no network, and a global shortcut: these
  are the desktop app's.
- A Files view, a Source tab for notes that read, renaming files, and files
  outside the contract. A note that does not read is repaired as text where
  it is listed.
- Reading files an earlier build kept (its IndexedDB folder, a Yjs store,
  or the recordings an earlier web build kept in a browser). There is no
  migration.
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
