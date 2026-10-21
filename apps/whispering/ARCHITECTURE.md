# Whispering architecture

Whispering is a page. On the desktop it is an app bundled with Epicenter
(ADR-0493, ADR-0552), and Epicenter's shell and host do what a page cannot;
in a browser tab it keeps its folder in browser storage. Exactly one thing
opens the data folder: the page's own folder engine.

```text
src/                        the page      the UI; opens the folder bound to its window
```

```text
┌───────────── Epicenter's shell (Rust) ─────────────┐
│ binds one folder to each Whispering window before  │
│ it exists; tauri-plugin-epicenter-folder makes     │
│ checked reads and changes under its save lock      │
│ tauri-plugin-epicenter-recorder: audio into folder │
│ local transcription with the one active model      │
└──────────────────────▲─────────────────┬───────────┘
                       │ invoke          │ reads, changes, audio
             ┌─────────┴── page ───┐     ▼
             │ the folder engine   │   the data folder
             └─────────┬───────────┘
                       │ invoke ai_send
┌──────────────────────▼─────────────────────────────┐
│ the `epicenter` CLI, run by the shell: endpoints   │
│ and keys in this computer's keychain; checks the   │
│ endpoint, adds the key, sends, streams the answer  │
└────────────────────────────────────────────────────┘
```

The page opens the folder with `@epicenter/folder/tauri` and names no folder:
Epicenter binds one directory to each Whispering window before the window
exists, and the shared Rust plugin (`tauri-plugin-epicenter-folder`), in
Epicenter's process, answers every command in the calling window's
directory. The page's own folder engine, the native
`Folder`, then makes every read (`read_folder_file` and the rest) and every
change (`put_folder_file`) through the folder plugin, one command per storage
method. It reads only inside the window's directory and never through a link;
the plugin checks each change against the shared path rule, keeps it out of
Git's private state, and lands it only while the path still holds the bytes
the save read. This app has no folder code of its own on the desktop: no copy
of the plugin's bindings and no second transport.

Every other native service is Epicenter's, granted to Whispering's windows
(`whispering.json` in `apps/epicenter/src-tauri/capabilities`):
the recorder, local transcription with Epicenter's active model, and the AI
commands. The two connections are rows of Epicenter's own folder
`so.epicenter`, which Epicenter reads and saves for the page by operation;
their endpoints and keys stay in this computer's keychain, and a request goes
through the `epicenter` CLI, which adds the key. The page runs the Folder
engine over its recording directory. The native folder plugin performs its
rooted file operations; the connection commands separately read and save the
two rows in Epicenter's own directory through the CLI.

The two fail apart. If the `epicenter` command fails while Whispering is
open, the folder is still open and still saves; what stops is a request that
was out.

## The data model

`src/lib/definition.ts` names five tables and the schema each row's
frontmatter reads through (`whisperingTables`), built from the shared field
vocabulary (`@epicenter/definition`). The local `Folder` from
`@epicenter/folder` reads them as Markdown rows at `<table>/<id>.md`. A
schema only interprets (ADR-0632): a row that does not fit comes back with its
exact source and its issues, and a save never validates, so a field another
program added survives every edit. A table owns exactly one Markdown file per
row; any other file is an ordinary file reached through `folder.files`. Each
save names the content it started from, and the folder merges it with
whatever was saved meanwhile. The package's
[README](../../packages/folder/README.md) is the contract.

`definition.ts` builds the table schemas with `@epicenter/definition` and
TypeBox. Schemas interpret the files; they do not own their persistence.

What Whispering adds on top:

- A recording's identity is its stem. Results refer to it by `recordingId`, so
  the app never renames a recording's row; the title is a field.
- A new recording resolves its audio from the unique supported same-stem file
  beside its Markdown row in `recordings/`. No matching file is absent; several
  matching files are ambiguous and cannot play or transcribe. New rows store
  no path. Existing explicit `audioPath` links stay readable without moving
  files. Deleting a recording keeps the audio as an ordinary file.
- A transcription is a separate row, so a recording can have several and each is
  a readable file.
- A transformation (a recipe) is a row in `transformations/`: title in
  frontmatter, the instructions as its body. `model` is nullable: `null` or
  empty means "the text connection's", and a string overrides the
  connection's model. Its results refer to it by stem, so the app never
  renames it either.
- A result on a transcript is a row in `transformation_runs/`. A table name is
  one bare identifier, which is why the folder is not `transformation-runs`.
  The row names its recording, transcription, and transformation, and carries
  the prompt and transcript text that were sent, so it can be read on its own
  after any of the three changes or is deleted. Nothing mirrors it elsewhere.
- A result on pasted text is a row in `text_runs/`, written when the person
  starts the run. It carries the same snapshot (transformation and title,
  time, model, endpoint, prompt, input) and names no recording or
  transcript, so recording deletion never counts or waits on it.
- Connections are not data in Whispering's folder. There are two,
  transcription and text, each a canonical base URL, a default model, and an
  optional key. In Epicenter each is a row of the `connections` table in
  Epicenter's own folder `so.epicenter`, `connections/whispering-transcription.md`
  or `connections/whispering-text.md`, holding the kind `openai-compatible`,
  the title "Whispering transcription" or "Whispering text", and the model.
  The base URL and key are not in the row: they are in this computer's
  keychain under the row's id (`src/lib/platform/desktop/connections.ts`).
  In a browser tab they are `whispering.connections` in `localStorage`.
  `src/lib/connections.ts` holds the rules both storages apply.
- The chosen microphone is not folder data either: it names hardware on one
  device. It is `whispering.microphone` in the origin's `localStorage`
  (`src/lib/microphone-preference.ts`). Epicenter serves
  every app from one fixed loopback origin, so it lasts between launches.

Every file action, including settings saves, file creation, rename, and
deletion, is tracked work, and product teardown waits for it. A request to
an endpoint is not waited for: its result row is in the folder before it goes
out (ADR-0542), and an answer that has not arrived when the app quits is lost.

## Folder and platform capabilities

The layout supplies FolderApp an inline opener:

```svelte
<FolderApp open={() => openFolder({ tables: whisperingTables })}>
	{#snippet children(context)}
		<WhisperingApp {context}>{@render props.children?.()}</WhisperingApp>
	{/snippet}
</FolderApp>
```

WhisperingApp installs the exact context and constructs its product state with
`createWhispering(context)`. That constructor assembles the app's capture,
inference, connections, and preferences through `#platform/services`. The
layout and route pages do not construct or receive a separate workspace.

The build selects `src/lib/platform/desktop/services.ts` in the Epicenter host
and `browser.ts` otherwise (ADR-0391). `platform/types.ts` describes
those app capabilities. They neither open nor close storage:

| | Desktop, in Epicenter (`desktop.ts`) | Browser (`browser.ts`) |
| --- | --- | --- |
| Folder | The directory Epicenter bound to this window, opened with Whispering's tables (`openFolder({ tables })` from `@epicenter/folder/tauri`) | This site's local folder in IndexedDB (`openFolder({ tables })` from `@epicenter/folder/browser`); earlier OPFS folders are not read or changed |
| Recording | Epicenter's recorder plugin writes into the folder as it captures | `MediaRecorder`, written on stop |
| Transcription and transformation | The page reads the audio and sends the request through the `epicenter` CLI (`ai_send`), which adds the key | The page sends the request, so the endpoint must allow its origin (CORS) |
| Connections and keys | Rows of `so.epicenter`'s `connections` table, read and saved by Epicenter by operation; endpoints and keys in this computer's keychain; the page is told no key | `whispering.connections` in `localStorage` |
| Local transcription | Epicenter's active local model (`local-transcription.ts`) | None |
| Chosen microphone | `localStorage` | `localStorage` |

The desktop folder opener opens the folder Epicenter bound to this window with
Whispering's tables; it names no folder. Moving between Whispering's routes
or reloading keeps that folder, since the binding is the window's. It writes
nothing on opening: no declaration, no ignore file, no repository. The
recorder writes into the same folder, which no call names. The shell's
refusal (a window with no folder, a folder that is gone, a missing
permission) remains the folder opener's own error, as does a folder
the engine cannot open.

Everything above the seam (`library.svelte.ts`, its query cache, the components)
is the same code for both. Opening returns a `Result`, and a refusal is shown
on the "Could not open storage" screen as it is. The two
storages are never substitutes: nothing that is missing or refuses inside a
desktop app is replaced by browser storage, and the browser opener itself
refuses there (`InsideTauri`).

Page code names types and helpers from `@epicenter/folder`.
`hostAppViteConfig` (from `@epicenter/vite-config`, which `vite.config.ts`
builds on) aliases that exact specifier to `@epicenter/folder/tauri` in the
host build and to `@epicenter/folder/browser` otherwise, so a browser build carries no
desktop adapter or Epicenter's generated bindings, and the host build no
browser storage or isomorphic-git. `src/lib/platform-selection.test.ts`
bundles both builds and reads what each pulls in.
`src/lib/page-boundary.test.ts` fails if anything else under `src/` opens a
folder, imports a platform adapter other than through `#platform/services`, imports
a Node or Bun module, imports a Tauri module other than the `Channel` the
desktop connections stream on, imports the bindings outside the desktop
adapter, or imports the Yjs store, sync, or an account module.

## Bundled in Epicenter

Epicenter's `BundledApp::Whispering` names the page and its default `Whispering`
folder. Epicenter runs `bun run build:host`, which writes `dist/` (ADR-0560).
`build:host` sets `EPICENTER_HOST=1`: adapter-static writes `dist/` with
relative asset paths, and every page is prerendered (`src/routes/+layout.ts`),
so the build runs wherever Epicenter serves it, at
`epicenter-app://localhost/whispering/`. Links go through `resolve` from
`$app/paths`.

Epicenter opens the app's window with a `whispering:<digest of the folder's
directory>` label, one window per folder. The `whispering.json` capability selects those labels and
grants the folder plugin, the recorder, local transcription and its
readiness, opening Settings, the AI commands, and the two connection-row
commands. Epicenter's README states
the rule.

## Connections through Epicenter

Whispering's window opens no folder but its own and reaches no other. `src/lib/platform/desktop/connections.ts` reads and changes the two
rows of `so.epicenter`'s `connections` table, which sync with that folder,
through two Epicenter commands that name an operation, `transcription` or
`text`, never a row or a path: `whispering_connection_read` and
`whispering_connection_set`. Each runs `epicenter whispering-connection
read|set` (`packages/cli/src/connection-rows.ts`), which opens `so.epicenter`
under the Epicenter folder with `connectionsTables` from
`@epicenter/ai/connection-table`, reads or saves the one row, and closes it.
Reading writes nothing there. A row that does not read is reported, never
taken for none. A save sends the row's exact source as the page read it as
its base and assigns only `kind`, `title` for a new row, and `model`, so it
keeps the row's title, every field another program added, and an edit
Settings saved meanwhile. A save whose reply never arrived is reported as not
confirmed, never as saved. The endpoint and key are
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
the page prepared the request for (`expectedBaseUrl`). The platform adapter reads
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

Before preparing a transcription, the run saves accepted edits and reads the
recording again. It uses the current audio path even when the list has not
refreshed; missing, malformed, or unsaved recording input sends nothing. Running
a result again also saves its accepted input before deciding whether it is
unfinished. Provider requests are checked again for close and deletion after
preparation and initial result saving.

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

`src/lib/platform/desktop/transcription.ts` transcribes a recording with
Epicenter's one active local model (ADR-0180). It asks
`list_inference_models` which installed model is active, reads the audio
through the folder engine, and hands the bytes to `transcribe_audio_bytes`
with that model's id; it never chooses or downloads a model. No active model
is `ConnectionUnavailable`, naming Settings, and `openSettings` calls
`open_home` with the transcription section, which opens Epicenter's Settings
at the model. Nothing in Whispering's UI uses it yet: its settings have no way
to choose transcription on this computer.

## The product root and the pages

```text
routes/+layout.svelte      mounts one shared FolderApp
└── FolderApp              opens, guards, and closes the folder context
    └── WhisperingApp      creates product state; header, navigation, Files
        ├── /             recorder and latest recording
        ├── /recordings   list, details, raw files
        └── /transformations
```

`FolderApp` owns opening, the folder context, and closing. `WhisperingApp`
receives only that context, constructs product state
with `createWhispering(context)`, and provides `getWhispering()`
and `getFolder()` to descendants. Pages build no library and open no folder.
There is no module-level mutable state.

Product construction is synchronous and reads nothing. Its `start()` first
calls `maintainExclusions` (`src/lib/exclusions.ts`), before any product read.
It reads the root `.gitignore`, evaluates its ordered rules with `ignore`, and
appends missing case-insensitive audio-extension patterns under `/recordings/` only if needed. The exact bytes read are the base of an
ordinary `files.write`, preserving unrelated source. A write is followed by a
read to check the merged rules. A refusal becomes `exclusionNotice`, shown by
the shell while Files and other work remain available. Reload checks a repair.
No Git or provider request is made.

Then `library.start()` calls `services.recoverRecordings()` before reading
the folder and device settings. A thrown startup error stops the library and
shows its original message under "Whispering could not start". The folder
remains owned by FolderApp until unmount.

On destruction, WhisperingApp calls `stop()` synchronously. It registers
teardown through `context.run`, so FolderApp's close waits for it, including
the recorder's final row write, before releasing the folder. Product teardown
stops workflows and listeners; it never closes the folder or its context.

Settings keep one replace-only draft of explicit input, separate from saved
connection values. Untouched fields follow saved values and defaults; a
completed Save releases only what it submitted. Endpoint, model, key choice,
and key typed during that save remain for the next explicit Save.

Route changes render inside the same product root. The recording, selections,
running requests, pasted text, settings draft, and query cache survive them.
Only page-local presentation state resets. Reload mounts a fresh root and
repeats startup.

Leaving is guarded in one place, the shell. `beforeNavigate` holds a navigation
only when it unloads the document while a change is still being written; a navigation between
routes is never held. In a browser tab that raises the browser's own leave
warning. The desktop window prompts when accepted Folder work is still pending;
see "Closing".

Every page is prerendered in Epicenter's build, and Epicenter serves the app's
document for any other path below it; a browser build serves a fallback page.
So `/recordings` and `/transformations` open directly and survive a refresh.

## Recording

A recording is in the folder from the moment it starts (ADR-0543). The
library names it and writes its row first: `startRecording` makes the ID from
the start time, asks the capture device to record into
`recordings/<id>` (`recordingAudioStem`), and writes the row with the start
time and capture source. The device adds its format extension; the row stores no path. `stopRecording` stops the
device and writes the length (`durationMs`) onto the row it reads again, so a
title typed meanwhile is kept. `cancelRecording` holds the microphone until
its cancellation answers and deletes the row only after cancellation succeeds.
The operation stays tracked through row deletion during product teardown. A
refused or unknown cancellation keeps the row and handle for an explicit Stop
or Cancel; a delayed initial row-save failure cannot claim a cancelled capture
is still running. Stop reports separately when audio was saved but its row
could not be created. Closing the library stops a running
recording, never cancels it. Nothing in a row says whether a recording is
running: the library's live capture says that, and a running recording is
refused transcription.

The capture forwards the recorder's first unexpected ending, including one
received before subscription. The active capture alone handles it, through
`finishRecording`, while a tracked operation keeps teardown behind audio and
row finalization. Repeated or stale endings cannot stop another capture. Stop
or Cancel retires the recorder's listeners; interruption adds no persisted
status or second save queue. The browser listens for final encoder output
from startup, so an encoder that already stopped can still save its bytes.

There are two capture devices, and each mounted product has exactly one, chosen at construction; neither falls back to the other.

- The microphone device (`src/lib/microphone.ts`) records with the recorder
  each platform adapter supplies, over that adapter's inputs: the desktop
  adapter imports `@epicenter/recorder/tauri` and the browser adapter
  `@epicenter/recorder/browser`; shared code names only the bare contract.
  The library calls the desktop adapter's `recoverRecordings()` before reads, and
  shows a failure as its capture notice. Inside the
  desktop app (`src/lib/platform/desktop/microphone.ts`) Rust owns the
  microphone (ADR-0571): the shell's `tauri-plugin-epicenter-recorder` lists
  the inputs, reads a level, and writes `<path>.wav` into the granted folder
  as it captures, finalizing it on stop and on a page reload or a closed
  window; the page opens no microphone. In a browser tab
  (`src/lib/webview-microphone.ts`) `MediaRecorder` holds the audio and the
  page writes `<path>.webm` (or the browser's container) on stop.
- The fixture device (`src/lib/capture.ts`) writes fixed bytes on stop, under
  the fixture's own extension, and marks the row `fixture`.

When the library starts it calls `recoverRecordings` over `recordings/` and the legacy `audio/` directory: on
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

`src/lib/microphone-input.svelte.ts` is the app's state over that, a field
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

Nothing here runs at launch. The app reads the saved choice through
`services.preferences` and opens nothing; the first listing is when the
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

`src/lib/transformation.ts` is the request: `POST <base>/chat/completions` with
the model, the prompt as the system message, and the input as the user
message, reading `choices[0].message.content`. It is plain `fetch` with
`redirect: 'error'` and `credentials: 'omit'`, shared by both platform adapters like
the transcription request (in Epicenter, its `fetch` goes through
the `epicenter` CLI), and it refuses a base URL
that is not plain HTTP(S) before sending. `transformOverConnection` is the one
entry both use: it reads the text connection once, refuses a request prepared
for another base URL, and sends with that connection's key. An error never
carries the key: an endpoint that echoes it has it removed.

`src/lib/recipe.ts` decides whether a recipe runs and with what, from the
recipe as read (a listed row, or its text as typed in Source) and the text connection
as last read: the file must read without issues and have instructions; a text
connection must be set up; the model is the recipe's if it names one, else the
connection's. The library
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

1. Its result row is saved with those fields and an empty body
   (`table.set(id, null, …)`) before the request goes out. A row that cannot
   be saved refuses, and nothing is sent.
2. The request goes out. While it is out the row shows as running.
3. The answer is saved into the row with `table.set(id, from, { body })`,
   where `from` is the row with the empty body the run wrote, so the folder
   merges it into the file as it is now (ADR-0632): a field someone changed
   meanwhile stays, and the same answer filled elsewhere is written once. A
   row that is gone was discarded and is not written: the fill reads the row
   first and writes nothing when it is gone. A save that fails is tried again
   after a wait that doubles from half a second to thirty seconds, for as long
   as the window is open.

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
transcripts, and the results made from them, each as it is when the deletion
runs, and keeps its audio: an ordinary file the table
does not own, which Files can delete. What goes is read from
the folder then, never taken from a listing; a result file that does not read
refuses the deletion, since it might be this recording's. It must not race
the work that writes those rows. `deletionFor` and `delete`
both refuse while a transcription or transformation of that recording is
running or one of its rows is being written, and `delete` also refuses when
a result was written after the person was asked. While `delete` runs, no request
starts for that recording. A failed run holds nothing; it is dropped with the
recording. Results on pasted text name no recording, so they are neither
deleted with one nor in the way of deleting one, readable or not.

What a deletion of a recording or transformation path removes is decided by
its file as read after the typing held for it saved, not by the last
listing. A row that reads is deleted through its edit handle
(`folder.tables[table].edit(id).delete()`), which sends the typing held for
it once, waits for the row's running save, and deletes it as stored then. A file that is there and does not read as a row (bytes that
are not text, say) is deleted alone, as the bytes read then, and the person is
told its results are kept: nothing in the file says which results are its
own, so none is deleted with it. Any other file is deleted the same way,
`files.delete(path, bytes)`. Each delete names what it read (ADR-0632), so a
file another program changes in that very moment is kept, and the person is
told. For a recording, the same guards hold by its name: the capture and the
confirmation both refuse while work for that recording is running, and
nothing new starts for it from the deletion's reservation through its result
reads and final deletes.

## Editing through Folder

Folder owns accepted file edits and their persistence ([ADR 0656](../../docs/adr/0656-a-folder-owns-typed-input-from-open-to-close.md)). `FolderApp` opens it
and creates the UI context; `WhisperingApp` installs that same context for
`getFolder()`. Its TanStack Query cache holds saved rows and file reads
(ADR-0528). Folder also owns each editable document and its retained input;
the Svelte edits expose tracked properties over its read methods. A read never replaces unfinished input.

- **Reads** use the context's generated queries. One Folder change listener
  invalidates affected representations, and visible queries poll for outside
  edits. Save completion and closing do not wait for display refresh.
- **Row typing** uses `folder.tables[table].edit(id)`. `getRow()` answers the
  document with pending fields and body; `change({ fields?, body? })` types
  over it. `createRowEdit(table, id)` exposes that row as a reactive `.row`
  property for Svelte and shares the core commands. Callers supply no source or observation. Autosave policy
  is configured when opening Folder.
- **Whole-file text** uses `folder.files.edit(path)`: `getText()` reads the
  editable text, and `change(text)` supplies its replacement. Row and text edits share one owner
  per physical path, including input, save ordering, and failures. Whispering
  has no separate text queue. Fields and Source read and change the same path's
  input, so switching requires no save or refresh. A structured view uses the
  current editable text, while failed input and its recovery remain shared.
- **A failed save** keeps the typing. The file's status line says **Not
  saved** with **Try again** and **Discard** (`SaveStatus.svelte`). Try again retries
  it; accepted new typing clears the error and may autosave. A run, rename,
  deletion or close sends new input but leaves failed input held for recovery.
  Discard leaves the file as it is and offers
  what was typed to copy. A failed save of a file's whole text is also told
  with the shared failure toast. The library emits the shared `WriteFailure`
  directly; the app root passes it to `toastWriteFailure`.
- **A row deleted elsewhere** with typing held for it comes back with that
  typing: an unseen deletion never erases an edit (ADR-0632). With nothing
  typed it stays deleted.
- **A value the schema does not accept** is saved as written, and the row is
  listed for repair. A field change leaves the rest of the file's bytes as
  they were; text typed into a body saves with LF line endings (ADR-0572).
- **A recording's initial row save** stays on its active capture. Stop and
  Cancel await that attempt before changing or deleting its row, even if
  another capture has since started.
- **A recording's lifecycle** (its row at start, its length at stop, saving
  a transcript or a result) is tracked work scoped by the recording's path,
  which the audio's "settling" state reads. Waiting on an endpoint is not
  tracked, so a request that does not answer never keeps the app from
  closing.

Whispering retains view selection, connection forms, pasted text, capture
state, and answers whose files are not written. Folder retains accepted
file edits. Renaming a file saves its typing, saves its exact
bytes under the new name, then deletes the old name as read; the selection
follows it. Recording and transformation files keep their names. Once the
context is closing during normal teardown, typing changes nothing; teardown
waits for tracked work and the folder's held input. This differs from the
person confirming immediate departure.

## Closing

Closing the desktop window checks whether accepted Folder work is saving or
unsaved. Pending work prompts: Cancel keeps the window and input; Close Anyway
destroys it without waiting for a save. Unsubmitted settings and pasted text
do not prompt. Normal page teardown still waits for tracked app actions before
closing the Folder. Recorded audio and started requests have their own lifetimes:

- A recording is in the folder from its start
  ([ADR-0543](../../docs/adr/0543-a-recording-streams-into-its-folder-from-the-moment-it-starts.md)).
  On the desktop the recorder plugin appends its audio as it captures and
  finalizes the file when the window reloads or closes; a WAV cut off by a
  crash has its header rewritten (`recoverRecordings`) when the folder next
  opens.
- A transcription or recipe run writes its result row before the request goes
  out. An answer that has not arrived when the app quits is lost, and the row
  stays unfinished, to run again.
- File edits autosave while the window is open. Failed edits remain available
  to retry, copy, or discard while the page stays open; confirming departure
  can lose them.

A save is staged and then renamed over its path by the shell, so one cut off
between them leaves the path as it was and a staged copy, which a later
opening sweeps.

A window whose folder could not be opened closes the same way: nothing is
open in it.

In a browser tab the browser owns leaving: `beforeNavigate` in `WhisperingApp`
holds an unload while a change is still being written, which raises the
browser's own leave warning. A recording in a browser tab is held in the page
until it stops, so reloading or closing the tab loses it.

## Saving and status

Whispering keeps no versions and does not sync its folder: Save version,
Connect, and Sync were removed with the move to the local `Folder`.
`src/lib/status.ts` words the header's one line from what the library knows
about saving: an answer whose file is not written yet, typing that did not
save, a save running, or the last save storage refused (the folder's
`status.storageFailure`), and otherwise "All changes saved on this device".

## Noticing outside changes

The context listens to `folder.onChange` once to refresh affected queries
after saves, including another browser tab's saves. Visible queries poll for
edits from other programs; returning to a visible page refreshes active reads
(ADR-0654). Storage saves and closing never wait for those display reads.

## Debug builds

A development browser build opened with `?fixture=tone` records a generated
tone instead of the microphone (`src/lib/capture.ts`); a production build and
Epicenter never do.

No build offers failure injection. Tests fail a save by wrapping a table
in `src/lib/services.test-support.ts`: `withObstructedCreates` puts a real
obstacle where a new row's file goes, so the folder itself fails the save,
and `withResultFailures` refuses a result save before it reaches the folder.
Tests open a directory with the folder package's Bun and Tauri openers by
their modules until public entries export them.

## Where things are

| Path | Role |
| --- | --- |
| `src/lib/definition.ts` | The tables, each row's schema, and row paths. |
| `src/lib/platform/` | The service contract, browser implementation, and native adapters grouped under `desktop/`. |
| `src/lib/whispering.svelte.ts` | Product state for the mounted root: what the shell shows, post-processing, pasted text, settings, startup, and teardown. |
| `src/lib/folder.ts` | Whispering's typed folder context, provided by WhisperingApp. |
| `src/lib/settings-draft.svelte.ts` | The one draft of the two connections, shown by the header's Settings and (transcription only) by the control on Home. |
| `src/lib/connections.ts` | The connection rules both storages apply: canonical base URLs, key keep/replace/remove. Pure; stores nothing. |
| `src/lib/recipe.ts` | The one decision about whether a recipe runs and with what. |
| `src/lib/post-processing.ts` | The post-processing choice type and how a transformation is named. The app reads the current choice (`whispering.postProcessing`). It runs nothing. |
| `src/lib/library.svelte.ts` | Recording and inference workflows, product lists and selections, and actions over the shared Folder and query context. |
| `src/lib/runs.svelte.ts` | Transcription and recipe runs: the result row written when each starts, its answer written into it, and what each row shows. |
| `src/lib/deletion.ts` | What a deletion deletes, read fresh for the person to confirm, and running it. |
| `src/lib/capture.ts`, `microphone.ts`, `webview-microphone.ts`, `audio-format.ts`, `transcription.ts`, `transformation.ts` | The capture contract and fixture device, the real microphone over `@epicenter/recorder` and the browser's inputs, extension-to-MIME mapping and WAV length, the transcription and transformation requests. |
| `src/lib/microphone-input.svelte.ts` | The chosen microphone and the test of it, for one mounted app. |
| `src/lib/file-reads.ts` | Text and audio query representations; unchanged audio bytes retain the player's Blob. |
| `src/lib/microphone-preference.ts` | The device's saved microphone choice, shared by both platforms. |
| `src/lib/status.ts`, `files.ts` | The header's status line; file messages, the listing, and reading a file's bytes. |
| `src/routes/` | The layout that mounts FolderApp, the product root, and the three pages. |
| `src/routes/components/` | The shell, navigation, header, recorder, recording and transformation lists and details, file browser and view. |
| `src/lib/assets/` | The microphone mark from the earlier Whispering. |
| `src/lib/tauri/bindings.gen.ts` | Epicenter's typed commands, generated by its Rust tests. Only the desktop adapter imports it. |
