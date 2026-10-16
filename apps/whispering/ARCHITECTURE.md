# Whispering architecture

Whispering is a page. On the desktop it is an app installed in Epicenter
(ADR-0493, ADR-0552), and Epicenter's shell and host do what a page cannot;
in a browser tab it keeps its folder in browser storage. Exactly one thing
opens the data folder: the page's own folder engine.

```text
src/                        the page      the UI; opens the folder it is granted
epicenter.app.json          the manifest  id so.epicenter.whispering and the title
```

```text
┌───────────── Epicenter's shell (Rust) ─────────────┐
│ grants so.epicenter.whispering to Whispering's     │
│ window; tauri-plugin-epicenter-folder holds the    │
│ lock and makes checked reads, changes, `git` runs  │
│ tauri-plugin-epicenter-recorder: audio into folder │
│ local transcription with the one active model      │
└──────────────────────▲─────────────────┬───────────┘
                       │ invoke          │ reads, changes, git, audio
             ┌─────────┴── page ───┐     ▼
             │ the folder engine   │   the data folder and its .git
             └─────────┬───────────┘
                       │ invoke ai_send
┌──────────────────────▼─────────────────────────────┐
│ the `epicenter` CLI, run by the shell: endpoints   │
│ and keys in this computer's keychain; checks the   │
│ endpoint, adds the key, sends, streams the answer  │
└────────────────────────────────────────────────────┘
```

The page opens the folder with `@epicenter/folder/tauri` and names only the
folder's ID. The shared Rust plugin (`tauri-plugin-epicenter-folder`), in
Epicenter's process, grants Whispering's window the directory and holds the
folder's lock. The page's own folder engine then makes every read
(`read_folder_file` and the rest) and every change (`write_folder_file` and
the rest) through the folder plugin; its history runs in the `epicenter` CLI
through Epicenter's history commands (ADR-0559). It reads
only inside the granted directory and never through a link; it checks each
change against the shared path rule and keeps it out of Git's private state.
This app has no folder code of its own on the desktop: no copy of the plugin's
bindings and no second transport.

Every other native service is Epicenter's, granted to Whispering's windows by
its app id (`installed-whispering-*` in `apps/epicenter/src-tauri/capabilities`):
the recorder, local transcription with Epicenter's active model, and the AI
commands. The two connections are rows of Epicenter's own folder
`so.epicenter`, whose endpoints and keys stay in this computer's keychain; a
request goes through the `epicenter` CLI, which adds the key. Nothing native opens the folder for the page, takes its lock for it, or
saves a file the folder tracks.

The two fail apart. If the `epicenter` command fails while Whispering is
open, the folder is still open and still saves; what stops is a request that
was out.

## The data model

`src/lib/definition.ts` declares the folder with the shared vocabulary
(`@epicenter/definition`): five tables and `kv`. `@epicenter/folder` turns that
into Markdown rows at `<table>/<stem>.md` and `kv.json`. A table owns exactly
one Markdown file per row; any other file is an ordinary file reached through
`folder.files`. The package's [README](../../packages/folder/README.md) is the
contract for entries, captures, conditional saves, source-preserving patches,
one-file-per-save publication and its outcomes, and history.

What Whispering adds on top:

- A recording's identity is its stem. Results refer to it by `recordingId`, so
  the app never renames a recording's row; the title is a field.
- A recording names its audio in `audioPath`, a folder-relative path such as
  `recordings/<id>.wav`. That field is the only link between the two files.
  Nothing is inferred from a file that shares the row's stem. A row with no
  `audioPath`, including one written before the field existed, is listed as
  needing repair and has no audio the app will play or send; the app does not
  fill the field in. Deleting a recording deletes its row and keeps the audio,
  which is deleted from Files like any other file.
- A transcription is a separate row, so a recording can have several and each is
  a readable file.
- A transformation (a recipe) is a row in `transformations/`: title in
  frontmatter, the instructions as its body. `model` and `endpoint` are
  nullable: `null` or empty means "the text connection's". A string `model`
  overrides the connection's model. A string `endpoint` (written by an earlier
  build) is kept and read as a constraint the text connection must meet
  exactly; it never chooses where a request goes. Its results refer to it by
  stem, so the app never renames it either.
- A result on a transcript is a row in `transformation_runs/`. A table name is
  one bare identifier, which is why the folder is not `transformation-runs`.
  The row names its recording, transcription, and transformation, and carries
  the prompt and transcript text that were sent, so it can be read on its own
  after any of the three changes or is deleted. Nothing mirrors it elsewhere.
- A result on pasted text is a row in `text_runs/`, written only when the
  person saves it. It carries the same snapshot (transformation and title,
  time, model, endpoint, prompt, input) and names no recording or
  transcript, so recording deletion never counts or waits on it.
- `kv.json` holds the transcription endpoint and model an earlier build saved.
  It is read, to fill in the transcription form, and never written.
- Connections are not data in Whispering's folder. There are two,
  transcription and text, each a canonical base URL, a default model, and an
  optional key. In Epicenter each is a row of the `connections` table in
  Epicenter's own folder `so.epicenter`, `connections/whispering-transcription.md`
  or `connections/whispering-text.md`, holding the kind `openai-compatible`,
  the title "Whispering transcription" or "Whispering text", and the model.
  The base URL and key are not in the row: they are in this computer's
  keychain under the row's id (`src/lib/workspace/desktop-connections.ts`).
  In a browser tab they are
  `whispering.connections` in `localStorage`, where an earlier build's single
  key stays, unused, until the person moves it into a connection.
  `src/lib/connections.ts` holds the rules both storages apply.
- The chosen microphone is not folder data either: it names hardware on one
  device. It is `whispering.microphone` in the origin's `localStorage`, never
  `kv.json` (`src/lib/workspace/microphone-preference.ts`). Epicenter serves
  every app from one fixed loopback origin, so it lasts between launches.

Every file command, including settings saves, file creation, rename, and
deletion, is a TanStack mutation. Closing the session waits until the
mutation cache is idle. A request to an endpoint is not waited for: its result
row is in the folder before it goes out (ADR-0542), and an answer that has not
arrived when the app quits is lost.

## The storage boundary

`src/lib/workspace/types.ts` is the one seam. The build picks its
implementation (ADR-0391): `#platform/workspace` in `package.json` resolves to
`desktop.ts` in the build Epicenter serves (`EPICENTER_HOST=1`, the
`epicenter-host` condition) and to `browser.ts` otherwise, and
`openWorkspace()` opens it when the app layout mounts:

| | Desktop, in Epicenter (`desktop.ts`) | Browser (`browser.ts`) |
| --- | --- | --- |
| Folder | The real directory Epicenter's shell grants, opened by the page's engine (`openFolder` from `@epicenter/folder/tauri`) | One OPFS directory, files and `.git` together (`openFolder` from `@epicenter/folder/browser`); a folder an earlier build kept in IndexedDB is not read |
| Recording | Epicenter's recorder plugin writes into the folder as it captures | `MediaRecorder`, written on stop |
| Transcription and transformation | The page reads the audio and sends the request through the `epicenter` CLI (`ai_send`), which adds the key | The page sends the request, so the endpoint must allow its origin (CORS) |
| Connections and keys | Rows of `so.epicenter`'s `connections` table; endpoints and keys in this computer's keychain; the page is told no key | `whispering.connections` in `localStorage` |
| Local transcription | Epicenter's active local model (`local-transcription.ts`) | None |
| Chosen microphone | `localStorage` | `localStorage` |
| Terminal, reveal, failure injection | None | None |

The desktop workspace opens the folder the window is handed as
`?folder=<scope>`, or Whispering's own when it is handed none, with
`openHandedFolder` from `@epicenter/folder/tauri`. Whispering's own folder
asks the shell for the scope `so.epicenter.whispering` (`grant_directory`),
the folder Epicenter hands an installed app opened from its Apps list, and
opens the directory it is granted with `whisperingDefinition`. Any other
handed folder opens with `whisperingDefinition` as the lens, which never
writes its `epicenter.json` and refuses one that lacks Whispering's tables with
"Whispering cannot open the folder '<name>': …". Recordings are written under
the scope opened (`Workspace.folderId`). The shell's refusal (an unknown scope, a window the
scope does not list, a folder another process holds, a missing permission) is
`DesktopFolder`, with the shell's own reason, as is a granted folder the
engine cannot open.

Everything above the seam (`library.svelte.ts`, its query cache, the components)
is the same code for both. Opening returns a `Result`, and a refusal is shown
on the "Could not open the recordings folder" screen as it is. The two
storages are never substitutes: nothing that is missing or refuses inside a
desktop app is replaced by browser storage, and the browser opener itself
refuses there (`InsideTauri`).

Page code names types and helpers from `@epicenter/folder`. `vite.config.ts`
aliases that exact specifier to `@epicenter/folder/tauri` in the host build
and to `@epicenter/folder/browser` otherwise, so a browser build carries no
desktop adapter or Epicenter's generated bindings, and the host build no
browser storage or isomorphic-git. `src/lib/platform-selection.test.ts`
bundles both builds and reads what each pulls in.
`src/lib/page-boundary.test.ts` fails if anything else under `src/` opens a
folder, imports a workspace other than through `#platform/workspace`, imports
a Node or Bun module, imports a Tauri module other than the `Channel` the
desktop connections stream on, imports the bindings outside the desktop
workspace, or imports the Yjs store.

## Installed in Epicenter

`epicenter.app.json` names the app `so.epicenter.whispering`, which
`WHISPERING_FOLDER_ID` imports, and its title. Epicenter runs
`bun run build:installed`, which writes `dist/` (ADR-0560).
`build:installed` sets `EPICENTER_HOST=1`: adapter-static writes `dist/` with
relative asset paths, and every page is prerendered (`src/routes/+layout.ts`),
so the build runs wherever Epicenter serves it, at
`/apps/so.epicenter.whispering/`. Links go through `resolve` from
`$app/paths`.

Epicenter opens the app's window with the label `app:so_epicenter_whispering`
(or, on another folder, that label plus the folder's scope in hex). Its
capabilities select those labels: `installed-app-windows-*` grants the folder
plugin, and `installed-whispering-*` the recorder, local transcription and
its readiness, and opening Settings. Epicenter's README states the rule.

## Connections through Epicenter

Opening Whispering's window permits it into Epicenter's own folder,
`so.epicenter`. `src/lib/workspace/desktop-connections.ts` opens it with
`openDataFolder` through `connectionsLens` from
`@epicenter/ai/connection-table`, and reads and changes the two rows of its
`connections` table, which sync with that folder. The endpoint and key are
in this computer's keychain under the row's id, and only the `epicenter` CLI
reads or writes them (`epicenter auth key set|remove|state`), through the
Rust commands `ai_key_set`, `ai_key_remove`, and `ai_key_state`. The page
learns the endpoint and whether a key is saved, never the key. A save writes
the keychain entry first, then makes or updates the row; `keep` leaves the
entry as it is, `replace` saves the new key, and `remove` saves none.
`applyConnectionChange` refuses keeping a key for another base URL before
anything is saved, as in a browser tab. A row synced from another computer is
not set up on this one until a person saves its endpoint, and key if it has
one, here.

`transcribe` and `transform` take what to send, the model, and the base URL
the page prepared the request for (`expectedBaseUrl`). The workspace reads
the operation's row and keychain entry once, at entry; if either is missing,
or the base URL is not exactly `expectedBaseUrl`, it answers
`ConnectionUnavailable` or `ConnectionChanged` and sends nothing. Otherwise
the request goes to the Rust command `ai_send`, which runs `epicenter send`.
The CLI checks that the keychain entry still holds the endpoint the request
was prepared for, and refuses the request, with nothing sent, rather than
retarget it. Then it adds the key, sends with redirects refused and no
cookie, and streams the response back as NDJSON lines over a Tauri `Channel`.
The page reads those lines into a `Response` with `createResponseReader`
from `@epicenter/ai/send`. The request never leaves from the page, so the
endpoint needs no CORS headers.

A transcription reads its audio through the folder engine, from the path the
recording's row names, and sends those bytes with the file's own name and the
type its extension calls for. The folder plugin reads only beneath the root
and never through a link. Audio that cannot be read is `AudioUnreadable`, and
nothing is sent.

A request whose reply never arrived from the `epicenter` command says only
that no reply arrived: the command may have sent it and had the answer lost
on the way back. The page reports that as `HostUnavailable`, worded as an unknown
outcome and never as "not sent", and does not make the call again; trying
again is the person's choice and is one more request.

## Local transcription

`src/lib/workspace/local-transcription.ts` transcribes a recording with
Epicenter's one active local model (ADR-0180). It asks
`list_inference_models` which installed model is active, reads the audio
through the folder engine, and hands the bytes to `transcribe_audio_bytes`
with that model's id; it never chooses or downloads a model. No active model
is `ConnectionUnavailable`, naming Settings, and `openSettings` calls
`open_home` with the transcription section. Nothing in the UI uses it yet:
Settings has no way to choose transcription on this computer.

## The session and the pages

```text
routes/+layout.svelte      opens one session on mount, closes it on destroy
└── AppShell               sets the session in context; header, navigation,
    │                      Files, close prompt
    ├── /                  +page.svelte            recorder and latest recording
    ├── /recordings        recordings/+page.svelte list, details, raw files
    └── /transformations   transformations/+page.svelte
```

`src/lib/session.svelte.ts` is the owner. A session is the workspace, the
product state over it (`library.svelte.ts`), and what the shell is showing. The layout holds one opening (`mountSession`) and nothing
else does: pages call `getSession()` and never open a workspace. There is no
module-level store, so a session exists only while a layout holds it, and
releasing the layout releases the folder. `src/lib/page-boundary.test.ts` reads
the sources and fails if anything but the layout holds an opening.

A session exists only once it has started: the folder was read, and the
device's connections were read (or their read failed and says so). An opening
that fails closes what it opened first, and leaves no session; the window
shows why.

Because the pages are routes under that one layout, a page change is a
re-render inside the same session. The live recording,
selections, running requests, and the query cache are fields of the library, and the pasted text a transformation is tried on is
a field of the session's view, not of any page, so none of them is touched by
navigation. What a
page keeps in its own component (which tab is showing) is the only thing a page
change resets.

Leaving is guarded in one place, the shell. `beforeNavigate` holds a navigation
only when it unloads the document while a change is still being written; a navigation between
routes is never held. In a browser tab that raises the browser's own leave
warning. The desktop app does not raise it, and quitting there is immediate;
see "Closing".

Every page is prerendered in Epicenter's build, and Epicenter serves the app's
document for any other path below it; a browser build serves a fallback page.
So `/recordings` and `/transformations` open directly and survive a refresh.

## Recording

A recording is in the folder from the moment it starts (ADR-0543). The
library names it and writes its row first: `startRecording` makes the ID from
the start time, asks the capture device to record into
`recordings/<id>` (`recordingAudioStem`), and writes the row with the start
time and the `audioPath` the device answered. `stopRecording` stops the
device and writes the length (`durationMs`) onto the row it reads again, so a
title typed meanwhile is kept. `cancelRecording` stops the device, which
deletes the audio, and deletes the row. Closing the library stops a running
recording, never cancels it. Nothing in a row says whether a recording is
running: the library's live capture says that, and a running recording is
refused transcription.

There are two capture devices, and a workspace has exactly one, chosen when it
opens; neither falls back to the other.

- The microphone device (`src/lib/microphone.ts`) records with
  `@epicenter/recorder`. Inside the desktop app the shell's
  `tauri-plugin-epicenter-recorder` writes `<path>.wav` into the granted
  folder as it captures and finalizes it on stop, and on a page reload or a
  closed window. In a browser tab `MediaRecorder` holds the audio and the
  page writes `<path>.webm` (or the browser's container) on stop.
- The fixture device (`src/lib/capture.ts`) writes fixed bytes on stop, under
  the fixture's own extension, and marks the row `fixture`.

When the library starts it calls `recoverRecordings` over `recordings/`: on
the desktop the shell rewrites the header of any WAV a quit or a crash cut
off, so it plays to its end; a browser has none. The row of such a recording
has no length.

### The microphone

The microphone device also has `inputs`: listing, asking for access, and a
level reading. The fixture device has none, so in fixture mode nothing lists,
asks for, or opens a microphone.

- For a test and in a browser, a chosen microphone is asked for as
  `{ deviceId: { exact } }`. A WebView that cannot open exactly that one
  answers with a refusal (`InputUnavailable`), and a stream that reports
  another device is released and refused. The desktop recorder asks the shell
  for the chosen input by the name it was listed under, and the shell refuses
  a name it cannot find the same way. The system default is asked for only
  when nothing is chosen.
- Listing is `enumerateDevices` and nothing else. It never asks for access, so
  before access is allowed it names no input. `allow` is the separate action:
  it opens the default microphone and releases it at once.
- Every request takes an `AbortSignal`. A stream that arrives after its
  request was withdrawn is released there, so a late answer leaves nothing
  open.

`src/lib/microphone-input.svelte.ts` is the session's state over that, a field
of the library (`library.input`): the choice, the listing, and the one request
that may open a microphone outside a recording. Enabling and a test share that
one owner: at most one is under way, and `release` aborts it and stops its
meter. The popover's close, leaving Home, a new choice, `startRecording`, and
closing the library all call it, so nothing they leave behind holds a stream.
The recorder and that request never hold a microphone together.
`startRecording` releases before it asks for its own microphone and passes the
choice it read at that moment; the choice, a test, and `allow` are refused
while a recording is starting, running, or finishing. A recording cancelled or
closed while its microphone is opening aborts that request. Closing the
library releases the microphone first, before it waits for file commands it
had accepted, and stops listening for `devicechange`.

Nothing here runs at launch. The session reads the saved choice through
`workspace.preferences` and opens nothing; the first listing is when the
person opens the control.

The choice's identity is its device ID and nothing else. A name does not
identify a microphone: another one of the same model has the same name. So a
saved ID that is not listed is never matched to a listed input by name. The
choice stays as it is, the control shows it as not listed, and it changes only
when the person chooses again. A listing can be limited by permission, so
absence from it proves nothing about the microphone: a recording still asks
for exactly that ID, and refuses only if the WebView cannot open it. A WebView may give
the same microphone another ID in a new origin; Epicenter serves the page from
one fixed origin, so whether a choice survives a restart there depends on the
WebView, which has not been checked on hardware.

## Transformations

`src/lib/transformation.ts` is the request: `POST <base>/chat/completions` with
the model, the prompt as the system message, and the input as the user
message, reading `choices[0].message.content`. It is plain `fetch` with
`redirect: 'error'` and `credentials: 'omit'`, shared by both workspaces like
the transcription request (in Epicenter, its `fetch` goes through
the `epicenter` CLI), and it refuses a base URL
that is not plain HTTP(S) before sending. `transformOverConnection` is the one
entry both use: it reads the text connection once, refuses a request prepared
for another base URL, and sends with that connection's key. An error never
carries the key: an endpoint that echoes it has it removed.

`src/lib/recipe.ts` decides whether a recipe runs and with what, from the
recipe as read (a listed row, or its text as typed in Source) and the text connection
as last read: the file must read without issues and have instructions; a text
connection must be set up; an endpoint the recipe names must be exactly the
connection's base URL (canonical spelling, no same-origin relaxation); the
model is the recipe's if it names one, else the connection's. The library
exposes it as `library.resolve`, and the Run check, the post-processing
choice, a transcript's Transform menu, the recipe's page, and both run entry
points call it, so they cannot disagree.

`library.transform` applies a saved recipe to a saved transcript, both named
by path. Nothing is taken from a list entry, which may predate an edit or a
deletion made outside. It saves open edits to either file (and refuses if
they cannot be saved), then reads the recipe and resolves it, then the
transcription row and the recording that row names. A missing, malformed, or
empty transcript, or a missing recording, refuses and nothing is sent.
`library.transformText` applies a saved recipe to pasted text; the text is
taken when it is called, and needs no recording.

Both fix a run before anything is sent: the result's stem, and every field the
result row will hold, including the instructions, input, model, and the text
connection's base URL. A transcription fixes its row the same way: the
recording, the time, the model, and the transcription connection's base URL.
Every run then follows one lifecycle (ADR-0542, `src/lib/runs.svelte.ts`):

1. Its result row is created with those fields and an empty body, in its
   recording's write queue (or its own, for pasted text), before the request
   goes out. A row that cannot be created refuses, and nothing is sent.
2. The request goes out. While it is out the row shows as running.
3. The answer is written into the row: the row is read again, and only an
   empty body is filled, with `files.replace` guarded by the exact bytes read
   empty. Not `table.save`, whose merge would let the answer win over a body
   someone filled meanwhile: a file changed since is refused, read again, and
   filled only while its body is still empty. A row that is gone was
   discarded and a row that has a body was filled already; neither is
   written. A write that
   fails is tried again after a wait that doubles from half a second to thirty
   seconds, for as long as the window is open.

Nothing that says what is happening is written. What a row shows is derived
from its body and this window's live state:

| The row | What it shows |
| --- | --- |
| Has a body | The answer. An empty answer is written as one newline, so only a row nothing was written to has an empty body. |
| No body, request out | Running. |
| No body, request failed (refused, unreachable, answered wrongly, the transport threw, or the connection moved) | Why, with Run again and Delete. |
| No body, answer received and its write failing | The text, with Copy, and why the write failed. The header counts these. |
| No body, nothing in this window | Unfinished: the window that sent it closed first. Run again and Delete. |

Run again (`library.runAgain`) reads the row now and sends the request its
fields record, into the same row, only while the connection is still the base
URL the row names; for a transcript, the audio is the one its recording names
now. It never reads the transcript a result came from: the row records the
text that was sent. Delete is the ordinary deletion of the row's file, and is
the only discard. Two asks for one transcript and recipe at once, two runs on
pasted text with one recipe at once, or two Run agains of one row at once,
send one request.

A transformation only ever creates rows in `transformation_runs/` and
`text_runs/`. No code path writes a transcription row from a transformation.
A listing of `text_runs/` that fails keeps the last list and reports why; a
file there that does not read is listed apart.

Deleting a recording (`src/lib/deletion.ts`) deletes its row, its
transcripts, and the results made from them, each guarded by the bytes read
when the person was asked, and keeps its audio: an ordinary file the table
does not own, which Files can delete. What goes is read from
the folder then, never taken from a listing; a result file that does not read
refuses the deletion, since it might be this recording's. It must not race
the work that writes those rows. `deletionFor` and `remove`
both refuse while a transcription or transformation of that recording is
running or one of its rows is being written, and `remove` also refuses when
a result was written after the person was asked. While `remove` runs, no request
starts for that recording. A failed run holds nothing; it is dropped with the
recording. Results on pasted text name no recording, so they are neither
deleted with one nor in the way of deleting one, readable or not.

What a deletion of a recording or transformation path removes is decided by
its file as read after the edits being written have landed, not by the last
listing. The dialog says when the files have changes that are in no saved
version. Removing is a mutation in the file's queue, after its recording's
lifecycle work; it writes the edits first and deletes what was confirmed, or
what this window last wrote when that changed after the person was asked. A row that reads is deleted as above. A file that
is there and does not read as a row (bytes that are not text, say) is removed
alone, conditional on the exact bytes read, and the person is told its
results are kept: nothing in the file says which results are its own, so
none is deleted with it. For a recording, the same guards hold by its name:
the capture and the confirmation both refuse while work for that recording
is running, and nothing new starts for it while it is removed.

## Editing through the query cache

Files are read through the TanStack Query cache (ADR-0528, ADR-0548), with
the folder's own query options (`folderOptions` from
`@epicenter/folder/query`). The library observes each table's listing, the
folder listing, `kv.json`, and Git status for as long as it is open, and a
view that shows a file's exact text reads it with its own query, keyed
beside the folder's read of that file. A row that does not read is an
`Err(InvalidRow)` entry in the same listing, shown as text with its issues
(`parseRow`) until it reads. A row the person opens in Source is shown as
text too; its fields open again once the text reads.

- **Reads** happen when the page opens, after the app's own actions and
  terminal commands, and when the folder reports a change. The library wires
  `folder.onFilesChanged` to the cache in one line, invalidating exactly the
  queries a report names (`pathFilter`); TanStack's focus refetch is off and
  nothing goes stale on its own. The page's own saves are not reported to it:
  a save puts its row in the cache, and Git status is read again after it.
- **A field edit** (a title, a model, removing an endpoint) is the table's
  `update` mutation: it sets the field on the file as it is now and keeps
  every field another writer changed (ADR-0554). A view holds a field typed
  in its own state and sends it a second after the last keystroke, when the
  person leaves it, and when the view goes away; Run sends it first.
- **A body edit** (a recording's notes, a transcript, a transformation's
  instructions) holds its own starting version, outside the cache: a body
  draft per row file (`createBodyDraftState` from
  `@epicenter/folder/svelte`), held by the library so it outlives the view
  it was typed in, and saved a second after the last change or when the view
  leaves it. A read never touches it; the detail shows the draft. Its save is
  the table's `save` mutation, over the version it started from, one at a
  time per file; text typed while one runs is sent next, from the version it
  wrote. A file changed since is merged by line in the engine: where both
  changed the same lines the typing wins and the save names what it
  replaced, which the shell shows as a toast.
- **Writes to one file** run one at a time, in the order made, whichever
  control made them.
- **Text** edited as a whole file has no merge: its write is `files.replace`
  guarded by the version the edit started from, one at a time. A file changed
  elsewhere refuses it; the typed text is dropped and the shell shows a toast
  that can copy it, and the file is read again.
- **A failed save** keeps the draft, or the field typed in its view; it is
  saved again with the next change, and a draft before anything that reads
  files (a run, a rename, a deletion, Save version, closing). A recording or
  transcript deleted elsewhere stays deleted: its save fails with
  `NotFound`, the draft is dropped and offered to copy, and the listing reads
  it gone.
- **A value the schema refuses** is never written: the folder refuses it as
  `InvalidValues`. Text typed into a field is kept well formed: a lone
  surrogate becomes U+FFFD, as a file holds it.
- **A recording's lifecycle** writes in its file's queue: its row at start,
  its length at stop, saving a transcript, and saving a transformation result
  are mutations scoped by the recording's path, so they run in order.
  Waiting on an endpoint is not a mutation, so a request that does not answer
  never keeps the app from asking to close. A scoped mutation waiting its
  turn would pause while TanStack thinks the page is unfocused, so the layout
  tells TanStack the page is always focused.

`$state` holds only input that is not in a file: an edit not yet saved, a
typed connection form, the pasted text, a captured recording, and an answer
whose file is not written. Renaming a file is a mutation in its queue, after
the edits are written; the selection follows it.
Recording and transformation files keep their names. Once the session is
closing, edits change nothing; closing waits until the mutation cache is idle
and never asks to discard. Nothing commits on its own: a
version is recorded only by **Save version** (`folder.git.commit()`,
ADR-0529) or by `git commit` in the folder.

## Closing

Closing the window and quitting are immediate, with Tauri's ordinary
behavior: the shell asks nothing, waits for nothing, and shows no dialog
([ADR-0542](../../docs/adr/0542-quitting-is-immediate-because-unfinished-work-already-lives-in-its-folder.md)).
Nothing that matters lives only in the page:

- A recording is in the folder from its start
  ([ADR-0543](../../docs/adr/0543-a-recording-streams-into-its-folder-from-the-moment-it-starts.md)).
  On the desktop the recorder plugin appends its audio as it captures and
  finalizes the file when the window reloads or closes; a WAV cut off by a
  crash has its header rewritten (`recoverRecordings`) when the folder next
  opens.
- A transcription or recipe run writes its result row before the request goes
  out. An answer that has not arrived when the app quits is lost, and the row
  stays unfinished, to run again.
- Every edit is written as it is typed. One cut off mid-save is lost like a
  dropped keystroke.

On exit Epicenter's folder plugin releases the folder's lock. A save is two commands, its bytes
staged under `.git/epicenter/scratch` and then renamed over the path, so one
cut off between them leaves the path as it was and a staged copy, which a
later opening sweeps. Shutdown makes no commit, so saves can remain
uncommitted.

A window whose folder could not be opened closes the same way: nothing is
open in it.

In a browser tab the browser owns leaving: `beforeNavigate` in `AppShell`
holds an unload while a change is still being written, which raises the
browser's own leave warning. A recording in a browser tab is held in the page
until it stops, so reloading or closing the tab loses it.

## History

Whispering offers no sync, so nothing is pushed. A save never commits
(ADR-0529): a version is recorded only when the person presses **Save
version**, a mutation that waits for the writes in flight and then calls
`folder.git.commit()`, or runs `git commit` in the folder. A failed commit
stays visible and is not retried on its own. `src/lib/status.ts` turns the
folder's Git snapshot into separate lines for saved files, changes since the
last version (neutral detail, not a warning), and the last commit attempt,
and never lets a commit outcome change what it says about a save. A commit's
author is `user.name` and `user.email` from Git's configuration, the
repository's or the person's global settings, and
`Whispering <whispering@localhost>` only where neither is set.

## Noticing outside changes

The folder's change channel (`folder.onFilesChanged`) is the one detector of
changes the page did not make (ADR-0548). On the desktop the shell's file
watcher on the granted directory reports changed paths, or everything after
it starts, after the computer wakes, and when it dropped events; in a browser
tab the folder's relay reports other tabs' writes, and everything when a tab
resumes. Each report invalidates exactly the queries it names. Returning to
the window reads nothing.

## Debug builds

A development browser build opened with `?fixture=tone` records a generated
tone instead of the microphone (`src/lib/capture.ts`); a production build and
Epicenter never do.

Failure injection is a seam only tests fill (`workspace.injection`). The
library runs a recording's row write at start, and its stop (which writes
fixture audio), through `aroundRecordingWrite`, and a test puts a real
obstacle in that write's way so the folder itself fails it
(`src/lib/workspace.test-support.ts`). No workspace offers it to a person.

## Where things are

| Path | Role |
| --- | --- |
| `src/lib/definition.ts` | The inert folder declaration. |
| `src/lib/workspace/` | The storage seam, its two implementations, Epicenter's connections and local transcription, and the microphone preference. |
| `src/lib/session.svelte.ts` | The one session a mounted layout owns, and its context. It holds what the shell shows, the post-processing choice, the pasted text, and the settings draft. |
| `src/lib/settings-draft.svelte.ts` | The one draft of the two connections, shown by the header's Settings and (transcription only) by the control on Home. |
| `src/lib/connections.ts` | The connection rules both storages apply: canonical base URLs, key keep/replace/remove, moving an earlier build's key. Pure; stores nothing. |
| `src/lib/recipe.ts` | The one decision about whether a recipe runs and with what. |
| `src/lib/post-processing.ts` | What the post-processing choice is now, read against the listed transformations and the recipe resolver. It runs nothing. |
| `src/lib/library.svelte.ts` | Product state over the query cache: the listings, the change channel, field updates, bodies and text held as drafts and their saves, selections, the live recording, settings, and every action as a mutation. |
| `src/lib/runs.svelte.ts` | Transcription and recipe runs: the result row written when each starts, its answer written into it, and what each row shows. |
| `src/lib/deletion.ts` | What a deletion removes, captured from fresh reads, and the removal. |
| `src/lib/capture.ts`, `microphone.ts`, `audio-format.ts`, `transcription.ts`, `transformation.ts` | The capture contract and fixture device, the real microphone over `@epicenter/recorder`, container detection, the transcription and transformation requests. |
| `src/lib/microphone-input.svelte.ts` | The chosen microphone and the test of it, for one session. |
| `src/lib/audio-source.ts` | What a player holds, reloaded by content version on each folder refresh. |
| `src/lib/status.ts`, `files.ts`, `terminal.svelte.ts` | Status lines, the file tree, and a terminal session no workspace offers today. |
| `src/routes/` | The layout that owns the session, and the three pages. |
| `src/routes/components/` | The shell, navigation, header, recorder, recording and transformation lists and details, file browser and view, terminal. |
| `src/lib/assets/` | The microphone mark from the earlier Whispering. |
| `epicenter.app.json` | The installed app's manifest: its id and title. |
| `src/lib/tauri/bindings.gen.ts` | Epicenter's typed commands, generated by its Rust tests. Only the desktop workspace imports it. |
