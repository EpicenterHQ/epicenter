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

Every other native service is Epicenter's, granted to every installed app's
windows (`installed-app.json` in `apps/epicenter/src-tauri/capabilities`):
the recorder, local transcription with Epicenter's local models, and the AI
commands. Connections are rows of Epicenter's own folder `so.epicenter`,
whose endpoints and keys stay in this computer's keychain; a request goes
through the `epicenter` CLI, which adds the key. Nothing native opens the folder for the page, takes its lock for it, or
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
  `audio/<id>.wav`. That field is the only link between the two files.
  Nothing is inferred from a file that shares the row's stem. A row with no
  `audioPath`, including one written before the field existed, is listed as
  needing repair and has no audio the app will play or send; the app does not
  fill the field in. Deleting a recording deletes its row and keeps the audio,
  which is deleted from Files like any other file.
- A transcription is a separate row, so a recording can have several and each is
  a readable file.
- A transformation (a recipe) is a row in `transformations/`: title in
  frontmatter, the instructions as its body. `model` is nullable: `null` or
  empty means "the text connection's", and a string overrides it. An
  `endpoint` an earlier build wrote stays in the file and is never read. Its
  results refer to it by stem, so the app never renames it either.
- A result on a transcript is a row in `transformation_runs/`. A table name is
  one bare identifier, which is why the folder is not `transformation-runs`.
  The row names its recording, transcription, and transformation, and carries
  the prompt and transcript text that were sent, so it can be read on its own
  after any of the three changes or is deleted. Nothing mirrors it elsewhere.
- A result on pasted text is a row in `text_runs/`, written only when the
  person saves it. It carries the same snapshot (transformation and title,
  time, connection, model, endpoint, prompt, input) and names no recording or
  transcript, so recording deletion never counts or waits on it.
- Every result row records the connection its request went over, the
  endpoint it reached, and the exact model (ADR-0582). A row made before
  connections were rows names none, and is not sent again.
- `kv.json` names which connection each operation uses:
  `transcriptionConnection` and `textConnection`, ids of rows of
  `so.epicenter` (ADR-0564). Values an earlier build wrote there are kept and
  never read.
- Connections are not data in Whispering's folder. Each is a row of the
  `connections` table of this device's `so.epicenter`, holding its kind
  (`openai-compatible`, `epicenter`, or `local`), title, and model, edited in
  Settings with the editor Epicenter's own Settings uses (`ConnectionList` from
  `@epicenter/ai/ui`). The endpoint and key are never in the row: in Epicenter
  they are in this computer's keychain under the row's id; in a browser tab
  they are in `localStorage`, beside the origin's own `so.epicenter` in OPFS
  (ADR-0581). Nothing an earlier build kept in a browser's storage is read.
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
| Connections and keys | Rows of `so.epicenter`'s `connections` table; endpoints and keys in this computer's keychain; the page is told no key | Rows of the origin's own `so.epicenter` in OPFS; endpoints and keys in `localStorage` |
| Local transcription | A `local` connection: Epicenter's local models (`local-transcription.ts`) | None |
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

Page code names types and helpers from `@epicenter/folder`.
`installedAppViteConfig` (from `@epicenter/vite-config`, which `vite.config.ts`
builds on) aliases that exact specifier to `@epicenter/folder/tauri` in the
host build and to `@epicenter/folder/browser` otherwise, so a browser build carries no
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
`epicenter-app://localhost/apps/so.epicenter.whispering/`. Links go through `resolve` from
`$app/paths`.

Epicenter opens the app's window with the label `app:so_epicenter_whispering`
(or, on another folder, that label plus the folder's scope in hex). One
capability, `installed-app.json`, selects every installed app's labels and
grants the folder plugin, the recorder, local transcription and its
readiness, opening Settings, and the AI commands. Epicenter's README states
the rule.

## Connections

`src/lib/connection-routes.ts` decides where a request goes, when it goes.
The operation's id in `kv.json` names a row of `so.epicenter`; the route is
that row read now: its kind, the exact model (a recipe's own, the row's, or,
for a `local` row naming none, the active local model), and the endpoint (the
keychain entry's for an `openai-compatible` row, the signed-in deployment's
`/v1` for an `epicenter` row, empty for a `local` row). A missing choice,
a gone row, a row with no model, a kind this workspace cannot send, or a
`local` row for text, refuses with nothing sent. The result row is written
with that connection, endpoint, and model before the request goes out.

The workspace supplies the rest (`WorkspaceConnections` in
`src/lib/workspace/types.ts`): which kinds can be added, the keys
(`keychainKeys` over the CLI's `ai_key_*` commands in Epicenter, `browserKeys`
over `localStorage` in a tab), opening `so.epicenter`, the Epicenter endpoint,
and `send`. In Epicenter, `send` runs `ai_send`, which runs `epicenter send`:
the CLI checks that the keychain entry still holds the endpoint the request
was prepared for, refuses with nothing sent rather than retarget it, adds the
key, sends with redirects refused and no cookie, and streams the response
back over a Tauri `Channel`, read into a `Response` by `sendThroughShell`. A
refusal the CLI names before sending passes through as it is; anything else
that ends without a response, such as a lost reply, is worded as an unknown
outcome, never as "not sent", and nothing is sent again on its own. In a tab,
`send` is `sendFromBrowser`, the same `sendRequest`, over the page's `fetch`.

A transcription reads its audio through the folder engine, from the path the
recording's row names, and sends those bytes with the file's own name and the
type its extension calls for. Audio that cannot be read sends nothing.

## Local transcription

A `local` connection transcribes on this computer
(`src/lib/workspace/local-transcription.ts`), with the model its row names or,
when it names none, Epicenter's active model (ADR-0180), whose exact id the
transcript records. It reads the audio through the folder engine and hands the
bytes to `transcribe_audio_bytes`; it never chooses or downloads a model. No
active model refuses, naming Epicenter's Settings. A `local` connection is
offered only in Epicenter, and only for transcription.

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
`audio/<id>` (`recordingAudioStem`), and writes the row with the start
time and the `audioPath` the device answered. `stopRecording` stops the
device and writes the length (`durationMs`) onto the row it reads again, so a
title typed meanwhile is kept. `cancelRecording` stops the device, which
deletes the audio, and deletes the row. Closing the library stops a running
recording, never cancels it. Nothing in a row says whether a recording is
running: the library's live capture says that, and a running recording is
refused transcription.

There are two capture devices, and a workspace has exactly one, chosen when it
opens; neither falls back to the other.

- The microphone device (`src/lib/microphone.ts`) records with the recorder
  each workspace supplies, over that workspace's inputs: the desktop
  workspace imports `@epicenter/recorder/tauri` and the browser workspace
  `@epicenter/recorder/browser`; shared code names only the bare contract.
  The desktop workspace repairs recordings a quit cut off when it opens, and
  shows a failure as its capture notice. Inside the
  desktop app (`src/lib/workspace/desktop-microphone.ts`) Rust owns the
  microphone (ADR-0571): the shell's `tauri-plugin-epicenter-recorder` lists
  the inputs, reads a level, and writes `<path>.wav` into the granted folder
  as it captures, finalizing it on stop and on a page reload or a closed
  window; the page opens no microphone. In a browser tab
  (`src/lib/webview-microphone.ts`) `MediaRecorder` holds the audio and the
  page writes `<path>.webm` (or the browser's container) on stop.
- The fixture device (`src/lib/capture.ts`) writes fixed bytes on stop, under
  the fixture's own extension, and marks the row `fixture`.

When the library starts it calls `recoverRecordings` over `audio/`: on
the desktop the shell rewrites the header of any WAV a quit or a crash cut
off, so it plays to its end; a browser has none. The row of such a recording
has no length.

### The microphone

The microphone device also has `inputs`: listing, asking for access, and a
level reading. The fixture device has none, so in fixture mode nothing lists,
asks for, or opens a microphone.

- In Epicenter, listing is the recorder plugin's `inputs`: every input with
  cpal's device ID (`coreaudio:<device UID>`) and its name, which needs no
  microphone permission. A test is the plugin's meter and a recording its
  `start`, each asking for the chosen input by that ID; the shell refuses an
  ID that is not connected (`InputUnavailable`) and opens nothing in its
  place. The plugin asks macOS for microphone access before either resolves a
  device, raising the prompt once and otherwise reading the stored decision;
  a denial is `PermissionDenied` and nothing opens. There is no `allow`, and
  listing never clears a denial: only a microphone that opens does. A denied
  control offers to open System Settings at the microphone pane
  (`openSettings`, through the opener). A meter that stops on its own ends the
  test with its reason. No `getUserMedia`, `enumerateDevices`,
  `MediaRecorder`, or `AudioContext` runs; `platform-selection.test.ts` proves
  the build reaches none of them.
- In a browser, a chosen microphone is asked for as `{ deviceId: { exact } }`.
  A WebView that cannot open exactly that one answers with a refusal
  (`InputUnavailable`), and a stream that reports another device is released
  and refused. Listing is `enumerateDevices` and nothing else. It never asks
  for access, so before access is allowed it names no input. `allow` is the
  separate action: it opens the default microphone and releases it at once.
- On both, the system default is asked for only when nothing is chosen.
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
had accepted, and stops listening for `devicechange` (a browser announces
connected inputs; the shell does not, so there the person lists again).

Nothing here runs at launch. The session reads the saved choice through
`workspace.preferences` and opens nothing; the first listing is when the
person opens the control.

The choice's identity is its device ID and nothing else. A name does not
identify a microphone: another one of the same model has the same name. So a
saved ID that is not listed is never matched to a listed input by name. The
choice stays as it is, the control shows it as not listed, and it changes only
when the person chooses again. A listing can be limited by permission, so
absence from it proves nothing about the microphone: a recording still asks
for exactly that ID, and refuses only if it cannot be opened. In Epicenter the
ID is the device's CoreAudio UID, which macOS keeps across launches and
reconnections. A WebView may give the same microphone another ID in a new
origin.

## Transformations

`src/lib/requests.ts` builds the two requests and reads their answers: a
multipart `audio/transcriptions` request, and a `chat/completions` request
with the prompt as the system message and the input as the user message,
read from `choices[0].message.content`. A request names only a path below its
connection's endpoint; the key, the redirect refusal, and the endpoint check
are `sendRequest`'s.

`src/lib/recipe.ts` decides whether a recipe runs and with what, from the
recipe as read (a listed row, or its text as typed in Source) and the text connection
as last listed: the file must read without issues and have instructions; a
text connection must be chosen and able to carry text here; the model is the
recipe's if it names one, else the connection's. The library
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
result row will hold, including the instructions, input, connection, model,
and endpoint. A transcription fixes its row the same way: the recording, the
time, the connection, the model, and the endpoint.
Every run then follows one lifecycle (ADR-0542, `src/lib/runs.svelte.ts`):

1. Its result row is created with those fields and an empty body, in its
   recording's write queue (or its own, for pasted text), before the request
   goes out. A row that cannot be created refuses, and nothing is sent.
2. The request goes out. While it is out the row shows as running.
3. The answer is written into the row with `table.write`, as the change
   from the row with the empty body the run wrote to the row with the
   answer (ADR-0576), merged by line into the file as it is now. Text
   someone put in the body meanwhile, by hand or by another fill, stays
   before the answer, and the same answer is written once. A row that is
   gone was discarded and is not written: a write over a row deleted since
   writes nothing (ADR-0576). A write that
   fails is tried again after a wait that doubles from half a second to thirty
   seconds, for as long as the window is open.

Nothing that says what is happening is written. What a row shows is derived
from its body and this window's live state:

| The row | What it shows |
| --- | --- |
| Has a body | The answer. An empty answer is written as one newline, so only a row nothing was written to has an empty body. |
| No body, request out | Running. |
| No body, request failed (refused, unreachable, answered wrongly, the transport threw, or the connection's endpoint moved) | Why, with Run again and Delete. |
| No body, answer received and its write failing | The text, with Copy, and why the write failed. The header counts these. |
| No body, nothing in this window | Unfinished: the window that sent it closed first. Run again and Delete. |

Run again (`library.runAgain`) reads the row now and sends the request its
fields record, into the same row, over the connection the row names and only
to the endpoint it recorded, whatever each operation's connection is now; for
a transcript, the audio is the one its recording names now. It never reads the transcript a result came from: the row records the
text that was sent. Delete is the ordinary deletion of the row's file, and is
the only discard. Two asks for one transcript and recipe at once, two runs on
pasted text with one recipe at once, or two Run agains of one row at once,
send one request.

A transformation only ever creates rows in `transformation_runs/` and
`text_runs/`. No code path writes a transcription row from a transformation.
A listing of `text_runs/` that fails keeps the last list and reports why; a
file there that does not read is listed apart.

Deleting a recording (`src/lib/deletion.ts`) deletes its row, its
transcripts, and the results made from them, whatever each holds when the
deletion runs (a delete beats edits that never saw it, ADR-0576), and keeps
its audio: an ordinary file the table
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
lifecycle work; it writes the edits first, then deletes the rows. A row that reads is deleted as above. A file that
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
  `set` mutation: it sets the field on the file as it is now and keeps
  every field another writer changed (ADR-0576). A view holds a field typed
  in its own state and sends it a second after the last keystroke, when the
  person leaves it, and when the view goes away; Run sends it first.
- **A body edit** (a recording's notes, a transcript, a transformation's
  instructions) holds the row it started from, outside the cache: a body
  editor per row file (`createBodyEditor` from `@epicenter/folder/svelte`),
  held by the library so it outlives the view it was typed in, and saved a
  second after the last change or when the view leaves it. A read never
  touches what is typed; the detail shows it. Its save is the table's
  `write` mutation, the change from the row it started from, one at a time
  per file; text typed while one runs is sent next, from what the last one
  sent. A save over a row deleted since writes nothing (ADR-0576). A file changed since is merged by line in the engine: where both
  changed the same lines the typing wins, with no notice (ADR-0575).
- **Writes to one file** run one at a time, in the order made, whichever
  control made them.
- **Text** edited as a whole file has no merge: its write is `files.replace`
  guarded by the version the edit started from, one at a time. A file changed
  elsewhere refuses it; the typed text is dropped and the shell shows a toast
  that can copy it, and the file is read again.
- **A failed save** keeps the draft, or the field typed in its view; it is
  saved again with the next change, and a draft before anything that reads
  files (a run, a rename, a deletion, Save version, closing). A recording or
  transcript deleted elsewhere stays deleted: its save writes nothing, the
  listing reads it gone, and what was typed is handed to a notice that
  offers to copy it until the person dismisses it.
- **A value the schema refuses** is never written: the folder refuses it as
  `InvalidValues`. Text typed into a field or a body is sent as typed; the
  folder writes a lone surrogate as U+FFFD, and a body reads and writes with
  LF line endings (ADR-0572).
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
| `src/lib/workspace/` | The storage seam, its two implementations, Epicenter's connections, local transcription, and microphone, and the microphone preference. |
| `src/lib/session.svelte.ts` | The one session a mounted layout owns, and its context. It holds what the shell shows, the post-processing choice, the pasted text, and the settings draft. |
| `src/lib/connection-routes.ts` | Where a request goes: the route for an operation's chosen connection, the route a result row recorded, and the two requests over a route. |
| `src/lib/recipe.ts` | The one decision about whether a recipe runs and with what. |
| `src/lib/post-processing.ts` | The post-processing choice type and how a transformation is named. The session reads the current choice (`session.postProcessing`). It runs nothing. |
| `src/lib/library.svelte.ts` | Product state over the query cache: the listings, the change channel, field updates, bodies and text held as drafts and their saves, selections, the live recording, settings, and every action as a mutation. |
| `src/lib/runs.svelte.ts` | Transcription and recipe runs: the result row written when each starts, its answer written into it, and what each row shows. |
| `src/lib/deletion.ts` | What a deletion removes, captured from fresh reads, and the removal. |
| `src/lib/capture.ts`, `microphone.ts`, `webview-microphone.ts`, `audio-format.ts`, `requests.ts` | The capture contract and fixture device, the real microphone over `@epicenter/recorder` and the browser's inputs, extension-to-MIME mapping and WAV length, the transcription and chat requests and how their answers read. |
| `src/lib/microphone-input.svelte.ts` | The chosen microphone and the test of it, for one session. |
| `src/lib/audio-source.ts` | What a player holds, reloaded by content version on each folder refresh. |
| `src/lib/status.ts`, `files.ts`, `terminal.svelte.ts` | Status lines, the file tree, and a terminal session no workspace offers today. |
| `src/routes/` | The layout that owns the session, and the three pages. |
| `src/routes/components/` | The shell, navigation, header, recorder, recording and transformation lists and details, file browser and view, terminal. |
| `src/lib/assets/` | The microphone mark from the earlier Whispering. |
| `epicenter.app.json` | The installed app's manifest: its id and title. |
| `src/lib/tauri/bindings.gen.ts` | Epicenter's typed commands, generated by its Rust tests. Only the desktop workspace imports it. |
