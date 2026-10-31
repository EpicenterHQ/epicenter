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
| `recordings/<id>.md` | A recording: `title`, `recordedAt`, `durationMs`, `capture` (`microphone` or `fixture`) in front matter, your notes in the body. |
| `recordings/<id>.<ext>` | Its audio: `m4a` (AAC) or `webm` (Opus) from a browser, `wav` from a desktop. |
| `transcriptions/<id>.md` | A transcript: the `recordingId` it was made from, `createdAt`, `model`, `endpoint`; the transcript is the body. |
| `transformations/<id>.md` | A transformation: a `title` and an optional `model` (`null` uses the text connection's); its instructions are the body. |
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

- A recording is kept when you press Stop, as two writes: its audio, then
  its note, so a note never names audio that is not there. Recording never
  waits on the network.
- Transcripts, transformations, and their results are kept beside it when
  they are made.
- Changes another tab makes show without a reload.
- A note at one of these paths that does not read is listed under "Needs
  repair" with why and its text. Saving fixed text there replaces the note,
  written in house style; text that still does not fit is refused and stays
  to fix.

The header's status line says where the recordings are: "On this browser".

### Signing in is optional

Signing in with Epicenter, from Settings, grants capabilities only: the
**Use Epicenter account** connection for transcription and text, which sends
through Epicenter's hosted API. It never opens a repository, never moves a
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
and Settings (the two connections and the optional sign-in).

### Recording

Press the microphone on Home to start and again to stop. A note titled
with the time is kept in this browser when it starts, and the audio is
written beside it as it records, about a second at a time (AAC in `.m4a`,
else Opus in `.webm`); Stop writes the length into the note. A refresh, a
crash, or a closed tab keeps what was recorded up to the cut: the next start
cuts a half-written file back to its last whole second and completes the
note from the audio. A browser that keeps no files for the site (a private
window) cannot record; the app says why before any microphone opens.

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

**Transcribe** sends the recording's audio over the transcription connection
and keeps the transcript as a new note when the answer arrives. Nothing is
transcribed until you press it. While the request is out, the recording says
so. If no answer comes, it says why with **Run again** (the same request,
only while the connection is still the endpoint it was made for) and
**Dismiss**. If the answer arrives but cannot be kept, it stays in the window
with **Save again** (no second request), **Copy**, and **Discard**, and the
header counts it until then; a reload loses it.

### Transformations

A transformation is a title and instructions you reuse: clean up dictation,
summarize, draft an email. **New** offers three starters and an empty one;
nothing is created until you choose. Where a run is sent is the text
connection, never the file; a model typed in a transformation is used instead
of the connection's.

Run one from a transcript's **Transform** menu, or from **Try it** on its
page, on a chosen transcript or on pasted text (no recording needed; the
pasted text stays while you move around and is written only into a result).
Running sends one request, `POST <text connection>/chat/completions`, with
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
  draft. The model is a name you type; Whispering keeps no list of models.
- **Post-processing.** None, or one of your transformations. Choosing sends
  nothing: **Run post-processing** on the latest transcript does, exactly as
  Transform would. A choice that was deleted or cannot run says why.

### Connections

Settings has two connections, **Transcription** and **Text**: each a base URL
(a local endpoint or a provider), the model used when a request names none,
and an optional key, kept in this site's `localStorage` (the keychain on
the desktop), never in Whispering's files. Or choose **Use Epicenter
account**: once you sign in,
the account supplies the address and authorization (`account.fetch`);
signed out, it sends nothing and says to sign in.

- Nothing is sent until a connection is saved; a keyless local endpoint is
  set up the same way.
- A request goes only to its connection's base URL, with that connection's
  key, and is refused, with nothing sent, if the connection changed after it
  was prepared. A key is kept only for the endpoint it was saved for, never
  carried by a redirect, and removed from any error that echoes it.
- The web app's tab sends requests itself, so a custom endpoint must allow
  the page's origin (CORS). Most hosted providers refuse that; a local endpoint or the
  Epicenter account works. A key saved here can be read by code running on
  the site, and the form says so.
- If an answer stops partway, the request may have been answered with the
  reply lost; the app says the outcome is unknown and never sends it again on
  its own.

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
grow in OPFS while it records, reloads mid-recording, and sees the next
start complete the note's length from what was written; offline, it records
and edits; it shows the
Epicenter account route refused until sign-in, then, signed in, sending the
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

### Fixture audio

A page opened with `?fixture=tone` records a generated 440 Hz tone through
the browser's own recorder instead of the microphone, for browsers under test
that have none (WebKit under Playwright). Only a development build, or one
built with `VITE_WHISPERING_FIXTURES=1` (the end-to-end suite's), offers it.
Recordings made this way are saved with `capture: fixture` and labelled as
such. A fixture recording proves the save, playback, and transcription path,
nothing about the microphone.

## The desktop app

```sh
bun run --cwd apps/whispering dev:desktop     # needs a Rust toolchain
bun run --cwd apps/whispering build:desktop   # a local, unsigned macOS app bundle
```

Its Tauri shell (`src-tauri/`, on the shared
[`epicenter-standalone`](../../packages/tauri-epicenter-standalone/README.md)
crate) starts the window on Whispering's AppData root, whose `settings.md`
(machine-local, never synced) names a data folder only when the person chose
one. There is no first-run question: the page opens `~/Epicenter/Whispering`
(`~/Epicenter/Whispering Dev` under `tauri.dev.conf.json`), made when
missing, or the chosen folder (`openAppData(whisperingSettings)`, then
`openDataFolder`). Tauri decides which folders the window may open: the
shell allows the default at startup, the native picker allows a folder the
person picks, and persisted-scope keeps it. A folder that is missing, not allowed, or refused
shows the recovery screen (`@epicenter/svelte/recovery`), never another
folder silently. **Choose data folder…**, in the status details and in
Settings, opens another folder with its files where they are and remembers
it. Epicenter syncs the folder once the person presses **Sync with
Epicenter**; Whispering never syncs it.

The pages are the web app's, built as the desktop variant
(`bun run build:native`, into `build-desktop/`), with what differs behind
build-time seams:

| Seam | Web leaf | Desktop leaf |
| --- | --- | --- |
| `#platform/root` | `root.ts`: this browser's storage, "On this browser", the end of a web sign-in | `root.tauri.ts`: the two roots or the recovery screen, the folder's status and sync, the global shortcut, Settings for the folder, local models and the shortcut |
| `#platform/services` | `browser.ts`: the WebView microphone, `fetch`, `localStorage` | `services.tauri.ts`: the shell's microphone, `send_request`, the keychain, local models |
| `#platform/auth` | `auth.ts`: browser OAuth | `auth.tauri.ts`: `createTauriAuth` over `epicenter-account` |
| `#platform/variant` | `'local'` | `'desktop'`, where only a sentence differs |

`src/lib/platform/platform.test.ts` bundles both builds and names a seam
whose desktop leaf went missing.

- **Recording** goes through the shell's microphone
  (`tauri-plugin-epicenter-recorder`), which writes `recordings/<id>.wav`
  into the data folder from the first sample. The call is the web build's,
  `startRecording({ device, path })` from `@epicenter/recorder`, imported
  from `/tauri` here and `/browser` there (decision 84). The note is made at
  Start and gets its length at Stop (`folder-recordings.ts`); a recording a
  quit or a crash cut off is repaired on the next launch and its length
  written from the audio. The recorder names the data folder to the shell by
  the root the shell answered when the page opened it (`rootOf` from
  `@epicenter/folder/tauri`); the shell refuses any root the window did not
  open.
- **Transcription** goes to a custom endpoint, sent from Rust
  (`send_request`, `src-tauri/src/http.rs`, so no endpoint needs CORS), to
  Epicenter's hosted API through the account's relay (`account_fetch`, whose
  token the page never holds), or to a local model with **Use this
  computer** (`tauri-plugin-epicenter-transcription`, models administered in
  Settings), which reads the recording's file in place.
- **Connections and keys** are one keychain entry, `connections`
  (`keychain` from `@epicenter/auth/tauri`). A debug build started with
  `EPICENTER_SECRETS_FILE=<path>` keeps them in that file instead.
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
  Settings.

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
- A recording surviving a refresh or a closed tab before Stop, in the web
  app.
- System-wide dictation beyond the desktop's one start-and-stop shortcut:
  push-to-talk, voice-activated recording, and delivering text to the
  cursor. Copy buttons are the only way text leaves the app.
- Automatic transcription or transformation. Each is a button you press, so
  nothing is sent to a paid endpoint on its own.
- Transcription on this computer in the web app, and importing audio files.
- Transformations beyond one prompt and one request, a provider or model
  catalog, and a connection or key per transformation.
- Windows and Linux are untested.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for how the pieces fit.
