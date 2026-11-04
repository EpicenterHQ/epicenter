<h1 align="center">Whispering</h1>
<p align="center">Record, transcribe, transform, and keep it all as files.</p>

Whispering is an app for voice notes. It records audio, transcribes it with
an OpenAI-compatible endpoint you choose (or Epicenter's hosted API), turns a
transcript into another text with instructions you write, and keeps every
recording, transcript, instruction, and result as an ordinary file.

Those files follow Whispering's contract, `src/lib/contract.ts`, published
unchanged as `static/contract.json` (`bun run contract` rewrites it after a
change), the file `epicenter check <url>/contract.json <dir>` checks a folder
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

Whispering's web build runs in a browser tab and keeps its files in that
browser. Its desktop app keeps them in a folder on the computer (see
[The desktop app](#the-desktop-app)). Both are the same pages over the same
contract; nothing moves files between them (decision 77).

## Where the files are

Whispering's web build keeps its files in one place, for good: this
browser's private files (OPFS, `openDevice` from
`@epicenter/folder/browser`), at the same paths a folder holds. It opens
without an account and works offline. Nothing syncs, uploads, or moves to a
repository, and there is no other view
([ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)).

- A recording is kept as it records: its audio written a piece at a time,
  its note with its length at Stop (see [Recording](#recording)).
  Recording never waits on the network.
- Transcripts, transformations, and their results are kept beside it when
  they are made.
- Changes another tab makes show without a reload.
- A note at one of these paths that does not read is listed under "Needs
  repair" with why and its text. Saving fixed text there replaces the note,
  written in house style; text that still does not fit is refused and stays
  to fix.

The header's status line says where the recordings are: "On this browser".
In Safari (any WebKit browser, by `navigator.vendor`) whose storage for the
site is not persistent (`navigator.storage.persisted()`), Settings adds one
line under the sign-in: "Safari may clear these recordings if you don’t
visit for a while. The desktop app keeps them as files in your Epicenter
folder." WebKit deletes a site's script-written storage after days without a
visit; Chromium, Firefox, and the desktop app never show it
(`src/lib/eviction-note.ts`).

### Signing in is optional

Signing in with Epicenter, from Settings, grants capabilities only:
Epicenter's models, listed beside every other model for transcription and
text, which send through Epicenter's hosted API. It never opens a repository, never moves a
recording, and signing out keeps every one. The app signs in as
`so.epicenter.whispering` for the server's API audience alone, with
`openid profile email ai` and no `folders:*` scope
(`src/lib/platform/auth.ts`), with no automatic renewal, so a timer never
navigates away mid-recording. The server is `VITE_EPICENTER_SERVER` at build
time, else Epicenter's.

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
the optional sign-in).

### Recording

Press the microphone on Home to start and again to stop. The audio is
written into this browser's files as it records, about a second at a time
(AAC in `.m4a`, else Opus in `.webm`); Stop keeps a note beside it titled
with the time and holding its length, and the recording appears in the
list. A refresh, a crash, or a closed tab keeps what was recorded up to the
cut: the next start cuts a half-written file back to its last whole second
and gives it a note ("Recovered recording") with the length of what was
written. A browser that keeps no files for the site (a private window)
cannot record; the app says why before any microphone opens.

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
every text save as you type; a save that fails stays in its editor with
**Save again**, **Discard**, and **Copy**.

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
**Dismiss**. If the answer arrives but cannot be kept, it stays in the window
with **Save again** (no second request), **Copy**, and **Discard**, and the
header counts it until then; a reload loses it.

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
  kept in this site's `localStorage`, never in Whispering's files.
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
Choices and connections stay on this device, never in Whispering's files:
in this site's `localStorage`, or on the desktop AppData's `connections.md`
with each key in the credential store.

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
(for `/auth/callback`) serves it, at an origin the API registers. The web
build has a service worker (`src/service-worker.js`, the shared `cacheSite`
from `@epicenter/vite-config/offline`) that caches the page and its static
files, so a page loaded once reopens offline, and a web manifest
(`static/site.webmanifest`) that makes it installable (decision 85). It
passes data and other origins' requests through untouched. The desktop
build (`build:native`) has neither worker nor registration:
`svelte.config.js` points Kit at no service worker there.

`test:e2e` starts `e2e/stack.ts`: a disposable Postgres, the local API with
temporary Git and LFS stores, a person per browser with a desktop sandbox for
the `epicenter` CLI, and the app built against that API on
`http://localhost:1420` (which must be free). With no account, it records
(audio and note land in OPFS and nothing else does), edits a title and a
transcript, transcribes over a stubbed custom endpoint, and deletes a
recording, then reloads; it watches a recording's audio file appear and
grow in OPFS while it records, with no note yet, reloads mid-recording, and
sees the next start give it a note with the length of what was written;
offline, it records
and edits; it shows the
Safari line in Settings in WebKit and not in Chromium, and the
Epicenter's transcription model refused until sign-in, then, signed in, sending the
account's API token (to a stub of the API's transcription route) and
keeping the transcript here, with this browser's files otherwise unchanged
and no `whispering` repository in `epicenter repos`; signing out keeps
every recording; and the page, loaded once, reopens offline from its
service worker (in Chromium with `context.setOffline`; WebKit under
Playwright blocks an offline navigation before any service worker sees it,
so there the step checks that the worker controls the page and has cached
it). The earlier steps run with service workers blocked, so the routes they
stub see every request. `bun apps/whispering/e2e/stack.ts --demo` runs the same
stack to try by hand. It needs `initdb`, `pg_ctl`, `git`, and `git-lfs` on
`PATH`.

## The desktop app

```sh
bun dev:whispering:desktop     # from the repository root; needs a Rust toolchain
bun build:whispering:desktop   # a local, unsigned macOS app bundle
```

Its Tauri shell derives `~/Epicenter/whispering` and names it the Data root, or
`~/Epicenter Dev/whispering` in development. The page opens this folder,
making it when missing for now. Whispering opens its AppData root for shortcut
overrides; the connected endpoints there are `@epicenter/ai`'s
(`customEndpoints()`). A failed open shows the shared recovery screen with Retry. The
status details and Settings show the shell's folder path. **Set up in
Epicenter** enrolls the folder for local history; connecting a repository
there enables transfer. Whispering never syncs it itself.

The pages are the web app's, built as the desktop variant
(`bun run build:native`, into `build-desktop/`), with what differs behind
build-time seams:

| Seam | Web leaf | Desktop leaf |
| --- | --- | --- |
| `#platform/root` | `root.ts`: this browser's storage, "On this browser", the end of a web sign-in | `root.tauri.ts`: the two roots or the recovery screen, the folder's status and sync, the global shortcut, Settings for the folder, local models and the shortcut |
| `#platform/services` | `browser.ts`: the WebView microphone, endpoints over the tab's `fetch`, `localStorage` | `services.tauri.ts`: the shell's microphone, endpoints over the shell's fetch, connections in AppData with keys in the credential store, local speech |
| `#platform/auth` | `auth.ts`: browser OAuth | `auth.tauri.ts`: `createTauriAuth` over `epicenter-account` |
| `#platform/variant` | `'local'` | `'desktop'`, where only a sentence differs |

`src/lib/platform/platform.test.ts` bundles both builds and names a seam
whose desktop leaf went missing.

- **Recording** goes through the shell's microphone
  (`tauri-plugin-epicenter-recorder`), which encodes a recording to Opus
  in WebM in the data folder from the first sample and places it at
  `recordings/<id>.webm` when Stop answers, in the same few milliseconds
  for a recording of any length. The call is the web build's,
  `recorder.start({ device, path })` from `@epicenter/recorder`, imported
  from `/tauri` here and `/browser` there (decision 84). The note, with its
  length, is written once Stop has answered (`folder-recordings.ts`); a
  recording a quit or a crash cut off is finished and placed on the next
  launch, before any page shows, and given its note there. The recorder names the data folder to the shell by
  its root's name (`rootOf` from `@epicenter/folder/tauri`); the shell
  refuses a root the page did not open.
- **Requests** to a connection, and to Ollama and LM Studio, leave from
  Rust through the shell's one fetch (`connection_fetch` in
  `epicenter-account`), which adds a connection's key and sends only to the
  endpoint it was saved for, so no endpoint needs CORS; Epicenter's go
  through the account's relay (`account_fetch`, whose token the page never
  holds); transcription on this computer runs in the app
  (`localSpeech()` from `@epicenter/transcription`, models downloaded in
  Settings), which takes the recording's audio as an upload.
- **Connections** are AppData's `connections.md`, with no key in it, and
  **keys** are credential-store entries, one per connection
  (`customEndpoints()` from `@epicenter/ai`, whose desktop build keeps them
  through `createKeychainConnections` from `@epicenter/ai/tauri`). A debug build
  started with `EPICENTER_SECRETS_FILE=<path>` keeps the keys in that file
  instead.
- **Sign-in** is `so.epicenter.whispering.native` through the shared
  [`epicenter-account`](../../packages/tauri-epicenter-account/README.md)
  crate, in the system browser.
- **The global shortcut** starts and stops a recording from any app:
  `toggleRecording` in `shortcuts.md`, `CommandOrControl+Shift+;` by
  default. It resolves with a shallow spread, `{ ...defaults, ...data,
  ...appData }`: the data folder's note travels with the files, and the
  AppData root's (Settings' **Only on this computer**) overrides it here.
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

- Syncing, uploading, or moving recordings to a repository or another
  device, and a view of a repository.
- A Files view, a Source tab for notes that read, renaming files, and files
  outside the contract. A note that does not read is repaired as text where
  it is listed.
- Reading files an earlier build kept (its IndexedDB folder, or a Yjs store).
  There is no migration.
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
