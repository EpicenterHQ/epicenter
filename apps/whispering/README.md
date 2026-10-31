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

An id is when the file was made plus a random suffix (`timeId()`). A file's
id is its identity: renaming a recording changes its `title`, never its path,
so a transcript's `recordingId` never breaks. Whispering keeps no settings in
its files: its connections and the chosen microphone belong to one device and
stay in the browser.

Whispering runs in a browser tab. Its own desktop app is a later step (see
[The desktop app](#the-desktop-app)).

## Where the files are

Whispering opens without an account. Signed out, its files live in this
browser's private files (OPFS, `openDevice` from `@epicenter/folder/browser`),
at the same paths a folder holds. Signing in with Epicenter opens the person's
own repository, `<handle>/whispering`, beside them, and every list shows both
as one:

- A recording is kept in the browser when you press Stop, its audio and note
  together as one capture, whether or not you are signed in, so recording
  never waits on the network. Signed in and online, it uploads on its own;
  the browser then lets go of the note and keeps the audio as a read-only
  cache (decision 66), which the browser may drop. Until it has uploaded,
  signed in, it is marked "Not uploaded yet".
- A transcript, a transformation, or a result made while signed in and online
  goes straight to the repository; made signed out or offline, it waits in the
  browser and uploads like a recording.
- Recordings made signed out upload to whoever signs in next on that browser
  (decision 67).
- Playing or transcribing a recording reads its audio from the nearest copy:
  the browser's own, then the browser's cache, then the repository (a
  download). A recording made here keeps playing and transcribing after it
  uploads, offline included.
- Edits and deletes go to the copy shown: the browser's while it holds one,
  else the repository's, which is online only.
- Changes made elsewhere (another tab, or a desktop's `epicenter sync`) show
  without a reload.
- A note at one of these paths that does not read is listed under "Needs
  repair" with why and its text. Saving fixed text there replaces the note,
  written in house style; text that still does not fit is refused and stays
  to fix.

The header's status line says where things are: "In this browser" signed out,
"N not uploaded yet" while uploads wait, "In your repository" once they have
landed, or "Repository unreachable". Signing out drops the cached audio and
leaves the browser with only what it never uploaded.

One sign-in covers both hosted inference and the repository (decision 65): the
app signs in as `so.epicenter.whispering` for the server's API and Git
audiences (`src/lib/platform/auth.ts`), with no automatic renewal, so a timer
never navigates away mid-recording. The server is `VITE_EPICENTER_SERVER` at
build time, else Epicenter's. The hosted API does not serve web writes yet, so
signing in to a repository works against a local or self-hosted API.

## Using it

Three pages, switched by the sidebar on a wide window and a bar at the bottom
on a narrow one. Each has its own address, so back, forward, and refresh
work. Changing pages keeps everything in progress: a recording keeps
recording, a request keeps running, and what you typed is already saved.

| Page | Address | What it is for |
| --- | --- | --- |
| Home | `/` | The recorder, and the newest recording with its transcript. |
| Recordings | `/recordings` | Search, sort, and select recordings; play, transcribe, and edit beside the table. |
| Transformations | `/transformations` | The instructions you apply to transcripts or pasted text, and their results. |

The header has the status line, a recorder control on every page but Home, and
Settings (the account and the two connections).

### Recording

Press the microphone on Home to start and again to stop. Nothing is kept
until Stop: then the audio and a note titled with the time are kept as one
capture and the recording opens. A refresh or a closed tab during a recording
loses it. A browser that keeps no files for the site (a private window), or
one that refuses a write, keeps the finished recording in the page with
**Save again**, **Download it**, and **Discard** until the page closes; the
app says so under the header.

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
results made from them, wherever each is. It is refused while a request for
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

Settings has two connections, **Transcription** and **Text**: each a base URL,
the model used when a request names none, and an optional key, kept in this
site's `localStorage`, never in Whispering's files. Or choose **Use Epicenter
account**: the signed-in account supplies the address and authorization
(`account.fetch`).

- Nothing is sent until a connection is saved; a keyless local endpoint is
  set up the same way.
- A request goes only to its connection's base URL, with that connection's
  key, and is refused, with nothing sent, if the connection changed after it
  was prepared. A key is kept only for the endpoint it was saved for, never
  carried by a redirect, and removed from any error that echoes it.
- The tab sends requests itself, so a custom endpoint must allow the page's
  origin (CORS). Most hosted providers refuse that; a local endpoint or the
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
(for `/auth/callback`) serves it, at an origin the API registers.

`test:e2e` starts `e2e/stack.ts`: a disposable Postgres, the local API with
temporary Git and LFS stores, a person per browser with a desktop sandbox for
the `epicenter` CLI, and the app built against that API on
`http://localhost:1420` (which must be free). It records, edits, transcribes
(over a stubbed endpoint) and deletes signed out; signs in and checks the
upload and the audio cache; clones with `epicenter clone` and `git lfs pull`
and runs `epicenter check`; edits on the desktop; and repairs a broken note on
the web. `bun apps/whispering/e2e/stack.ts --demo` runs the same stack to try
by hand. It needs `initdb`, `pg_ctl`, `git`, and `git-lfs` on `PATH`.

### Fixture audio

A page opened with `?fixture=tone` records a generated 440 Hz tone through
the browser's own recorder instead of the microphone, for browsers under test
that have none (WebKit under Playwright). Only a development build, or one
built with `VITE_WHISPERING_FIXTURES=1` (the end-to-end suite's), offers it.
Recordings made this way are saved with `capture: fixture` and labelled as
such. A fixture recording proves the save, playback, and transcription path,
nothing about the microphone.

## The desktop app

Not yet. Whispering's own Tauri app is the next step: it will open its
folder with `openDevice` from `@epicenter/folder/tauri`, record WAV into it
from the first sample through `tauri-plugin-epicenter-recorder`
(`@epicenter/recorder/tauri`), and leave syncing to Epicenter, which syncs a
folder added to it (`epicenter sync`). Epicenter no longer hosts apps
([ADR-0701](../../docs/adr/0701-apps-run-as-separate-programs.md)).

## What is not supported

- A Files view, a Source tab for notes that read, renaming files, and files
  outside the contract. A note that does not read is repaired as text where
  it is listed.
- Reading files an earlier build kept (its IndexedDB folder, or a Yjs store).
  There is no migration.
- A recording surviving a refresh or a closed tab before Stop.
- System-wide dictation: global shortcuts, push-to-talk, voice-activated
  recording, and delivering text to the cursor. Copy buttons are the only way
  text leaves the app.
- Automatic transcription or transformation. Each is a button you press, so
  nothing is sent to a paid endpoint on its own.
- Transcription on this computer, and importing audio files.
- Transformations beyond one prompt and one request, a provider or model
  catalog, and a connection or key per transformation.
- Windows and Linux are untested.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for how the pieces fit.
