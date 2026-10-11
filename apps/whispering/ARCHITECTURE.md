# Whispering architecture

Whispering is three parts. Each has one job, and exactly one of them owns the
data folder.

```text
src-tauri/        the shell     a window, the folder's owner, and one child process
native/           the host      serves the page and does what a page cannot
src/              the page      the UI; attaches to the folder, fetches the host
```

```text
┌───────────────── Tauri shell (Rust) ─────────────────┐
│ chooses the folder, registers it for the main window │
│ starts the host with that path, reads its port,      │
│ grants the page the owner's commands for that origin │
│ loads http://127.0.0.1:<port>/, injects the token    │
│                                                      │
│   tauri-plugin-epicenter-folder: the one owner       │
│   files, tables' bytes, history, lock                │
└────┬──────────────────▲────────────────┬─────────────┘
     │ spawns           │ invoke, events │ owns
     ▼                  │                ▼
┌── host (Bun) ─────┐  ┌┴─ page (WebView) ──┐   the data folder
│ page, terminal,   │◄─│ fetch /bridge/app  │   and its .git
│ requests, key,    │  │ Bearer <token>     │        ▲
│ close relay       │─►│ event stream       │        │
└─────────┬─────────┘  └────────────────────┘        │
          └── an ordinary program in that directory ─┘
```

The folder has one owner, the shared Rust plugin
(`tauri-plugin-epicenter-folder`), running in the shell's process. The page
attaches to it with `@epicenter/folder/tauri`, the shared desktop adapter, and
names only the folder's ID. This app has no folder code of its own on the
desktop: no copy of the plugin's bindings and no second transport.

The host does not open the folder. It is told the directory by the shell and
uses it as any other program would. The terminal runs the person's shell
there. Transcription reads one audio file out of it. The device's connections
and keys are a file under its `.git`. Nothing in the host takes the folder's
lock, initializes Git, watches the directory, or saves a file the folder
tracks.

This is not the end of the host. The page is still served by it, and the
terminal, revealing the folder, the provider requests, the connections and
their keys, fixture audio, and the close relay still live there. A new native ability that is not the
folder is a host operation in `native/`, exposed through the workspace type
with a browser implementation or an explicit `undefined`.

The two fail apart. If the host stops while the app is open, the folder is
still open and still saves; what stops is what the host did.

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
- Connections are not folder data. There are two, transcription and text, each
  a canonical base URL, a default model, and an optional key. On the desktop
  they are fields of `<root>/.git/epicenter/whispering/device.json`, which Git
  never commits; an earlier build's single key stays in that file, unused,
  until the person moves it into a connection. `src/lib/connections.ts` holds
  the rules both storages apply.
- The chosen microphone is not folder data either: it names hardware on one
  device. It is another field of the same `device.json`, never `kv.json`.
  `native/device-file.ts` owns that file. Each change starts from what the
  file holds when its turn comes, replaces only the fields it names, and keeps
  every other field, including ones this build does not know. Changes run one
  at a time, so a connection save and a microphone save that overlap both
  land, and a connection's base URL and key change in one write.

Short file commands, including settings saves and file creation or deletion,
start independently. The library joins their completion promises. Quit
preparation awaits those accepted
commands and the drafts' saves before deciding what remains unsaved. Recording
publication and provider work keep their own pending states and discard choices.

## The storage boundary

`src/lib/workspace/types.ts` is the one seam. `openWorkspace()` picks an
implementation when the app layout mounts:

| | Desktop (`desktop.ts`) | Browser (`browser.ts`) |
| --- | --- | --- |
| Folder | The real directory, through the shell's owner (`openFolder` from `@epicenter/folder/tauri`) | One OPFS directory, files and `.git` together (`openFolder` from `@epicenter/folder/browser`); a folder an earlier build kept in IndexedDB is not read |
| Terminal | Your shell in the directory, run by the host | The folder's own in-page shell (`folder.terminal()`) |
| Transcription | The host reads the connection, then the audio, and makes the request | The page does the same |
| Transformation | The host reads the text connection and makes the request | The page makes the request, so the endpoint must allow its origin (CORS) |
| Connections and keys | Fields of a file under `.git`; the page is told no key | `whispering.connections` in `localStorage` |
| Chosen microphone | The same file under `.git`. The page's own storage does not last, since the host serves it from a new port each launch | `localStorage` |
| Reveal, failure injection | Yes | No |

`isTauri()` selects the storage: inside a desktop app the folder is the
shell's, and in a browser tab it is the browser's. There is no build flag, and
the host's token is not the test. The desktop workspace needs two things, and
each is opened or refused on its own terms:

1. The host. The standalone shell injects `window.__WHISPERING_BRIDGE__`
   before the page runs. A desktop app that injected none did not start
   Whispering's host, and the page refuses with `HostMissing` before it asks
   anyone for a folder. A host that does not answer is `HostUnreachable`.
2. The folder. `openFolder({ id: WHISPERING_FOLDER_ID, definition })`
   attaches to the scope `so.epicenter.whispering`. The owner's refusal (an unknown scope, a window
   the scope does not list, a folder another process holds, a missing
   permission, another protocol version) is `DesktopFolder`, with the owner's
   own reason.

The page then checks that the owner and the host name the same directory and
refuses with `FolderMismatch` if they do not, since the terminal and
transcription would otherwise use a directory the saves do not go to.

Everything above the seam (`library.svelte.ts`, the drafts, the components)
is the same code for both. Opening returns a `Result`, and a refusal is shown
on the "Could not open the recordings folder" screen as it is. The two
storages are never substitutes: nothing that is missing or refuses inside a
desktop app is replaced by browser storage, and the browser opener itself
refuses there (`InsideTauri`).

Page code names types and helpers from `@epicenter/folder`. `vite.config.ts`
aliases that exact specifier to `@epicenter/folder/browser`. The desktop
workspace imports `@epicenter/folder/tauri` by its own name, which the alias
leaves alone, and the opener loads that workspace with a dynamic import, so a
browser tab never loads the desktop adapter. `src/lib/page-boundary.test.ts`
fails if anything else under `src/` opens a folder, imports a Node or Bun
module, imports a Tauri module other than the opener's `isTauri`, or imports
the Yjs store.

## The shell, the folder, and the window

The shell settles four things, in this order, before the window exists
(`start` in `src-tauri/src/lib.rs`):

1. **Where the folder is.** `WHISPERING_DATA_ROOT`, or
   `~/Epicenter/local/so.epicenter.whispering`. The shell creates it when
   absent and resolves it once. That resolved path is the only spelling used
   afterward.
2. **The host.** It is started with that path in its environment and reports
   only its port. A path on its ready line would not be read.
3. **The registration.** The scope `so.epicenter.whispering` is registered
   with that path for the window labelled `main`, with the author
   `Whispering <whispering@localhost>` and no remote. The repository's own
   `user.name` and `origin` are not read, so a save never pushes.
4. **The capability.** The page is served from `http://127.0.0.1:<port>`,
   which Tauri treats as a remote origin with no commands at all. One
   capability, added at runtime because the port is not known until then,
   grants the `main` window, on exactly `http://127.0.0.1:<port>/*`, the
   owner's commands (`epicenter-folder:default`) and listening for its events
   (`core:event:allow-listen`, `core:event:allow-unlisten`). `tauri.conf.json`
   lists no capability.

So the page cannot choose a directory: it names a scope, and the shell decided
what that scope is. Another window, a page from another origin or port, and a
local page are each outside the capability, and a window other than `main`
would be refused by the registration even with one.

If any of the four fails, the host is stopped and nothing is granted. The
window that opens is the local failure page, which can call no command and
reach no folder.

## The session and the pages

```text
routes/+layout.svelte      opens one session on mount, closes it on destroy
└── AppShell               sets the session in context; header, navigation,
    │                      unsaved notices, Files, Terminal, close prompt
    ├── /                  +page.svelte            recorder and latest recording
    ├── /recordings        recordings/+page.svelte list, details, raw files
    └── /transformations   transformations/+page.svelte
```

`src/lib/session.svelte.ts` is the owner. A session is the workspace, the
product state over it (`library.svelte.ts`), the close guard, and what the
shell is showing. The layout holds one opening (`mountSession`) and nothing
else does: pages call `getSession()` and never open a workspace. There is no
module-level store, so a session exists only while a layout holds it, and
releasing the layout releases the folder. `src/lib/page-boundary.test.ts` reads
the sources and fails if anything but the layout holds an opening.

A session exists only once it has started: the folder was read, the device's
connections were read (or their read failed and says so), and the close guard
is listening. An opening that fails leaves no
session. The same holder then answers the shell's close question, so the
window showing the refusal can be closed; see "Closing".

Because the pages are routes under that one layout, a page change is a
re-render inside the same session. The live recording, pending captures,
selections, running requests, held results, drafts, and the terminal session
are fields of the library, and the pasted text a transformation is tried on is
a field of the session's view, not of any page, so none of them is touched by
navigation. What a
page keeps in its own component (which tab is showing) is the only thing a page
change resets.

Leaving is guarded in one place, the shell. `beforeNavigate` holds a navigation
only when it unloads the document and something is held; a navigation between
routes is never held. The desktop close handshake below is answered by the
session's guard, above the routes, for the same reason.

The host serves `index.html` for any path that is not a file, so
`/recordings` and `/transformations` open directly and survive a refresh.

## The bridge

The bridge is the page's link to the host. It carries Whispering's own
operations and the close question, and nothing of the folder: there is no
folder route, no generic method call, no file change sent as data, and no Git
snapshot pushed over it. Tables, KV, conditional publication, and history are
the shared adapter's calls to the shell's owner.

```text
POST /bridge/app      { op, payload }   -> { ok: <value> } | { fault: "<message>" }
GET  /bridge/events   newline-delimited JSON: "close-requested" and pings
```

`src/lib/bridge/http.ts` is the page's end and `native/host.ts` the host's.
`src/lib/bridge/codec.ts` encodes what JSON cannot carry (`undefined`, bytes,
maps, errors), so fixture audio arrives as bytes and a transcription `Result`
arrives with its error intact. It is still a wire encoding this app owns.

Every bridge request must carry the per-launch token. The host also refuses a
request whose `Host` or `Origin` is not its own loopback address. The page is
served with a content security policy that allows connections to the host and
to the shell's own commands (`ipc:`), and to nothing else.

`/bridge/app` operations: `info`, `terminal`, `reveal`, `transcribe`,
`transform`, `connections`, `set-connection`, `adopt-legacy-key`,
`preferences`, `set-preferences`, `close`, and, in a debug shell only,
`fixture`, `inject`, `injection`, `injection-launch`, `obstruct`, and
`unobstruct`.

`transcribe` and `transform` take what to send, the model, and the base URL
the page prepared the request for (`expectedBaseUrl`). The host reads the
operation's connection once, at entry; if none is set up, or its base URL is
not exactly `expectedBaseUrl`, it answers `ConnectionUnavailable` or
`ConnectionChanged` and sends nothing. Otherwise it sends to the
connection's own base URL with the connection's key, and a connection saved
while the request is out does not change it. The payload never chooses a
destination. The answer is a `Result`; the key is never in it.

`connections` answers each connection's base URL, model, whether it has a key,
and why it is read-only, plus whether an earlier build's key is present.
`set-connection` takes an operation, base URL, model, and a key change
(`keep`, `replace` with the key, or `remove`); keeping is refused when the
base URL changes. `adopt-legacy-key` moves the earlier key into the chosen
connections at the base URLs the page showed. All three answer with what
`connections` answers, never a key. With `WHISPERING_TRANSCRIPTION_API_KEY`
set, the transcription connection is that key at the launch's base URL and
model, read-only; it is never used for text.

`preferences` and `set-preferences` read and save the chosen microphone. Their
replies are built from that field alone, so no key beside it is ever in one,
and saving a microphone works while the transcription connection comes from
the environment.

A bridge call that fails says only that no reply arrived. The host may never
have been reached, or it may have called the endpoint and had its reply lost.
The page reports that as `HostUnavailable`, worded as an unknown outcome and
never as "not sent", and does not make the call again; trying again is the
person's choice and is one more request. `AudioUnreadable` is the opposite,
certain case: it is the host's own answer that the file was not read and no
request was made. So are `ConnectionUnavailable` and `ConnectionChanged`.

### Reading audio for transcription

`transcribe` is given the folder-relative path a recording's row names, the
base URL it was prepared for, and the model. The page sends no audio. The
connection is checked first, so a request that will not be sent reads no
audio. The host reads the file
itself (`native/audio.ts`), once, and sends those bytes with the file's own
name and the type its extension calls for.

The read is literal and narrow:

- The path must pass the folder's own path rule: folder-relative, no `.` or
  `..`, no empty segment, no backslash or control character, nothing under
  `.git`.
- Every component must appear in its directory under exactly that spelling, so
  a case-insensitive disk cannot alias another name.
- No component may be a symbolic link, whether it points inside the folder or
  out of it. Every component before the last must be a directory and the last
  a regular file.
- The file is opened once, without following a link and without blocking,
  checked again through the open handle, read into bytes the host owns, and
  closed.

Anything else is `AudioUnreadable` and no request is sent.

What is sent is what the path held when it was read. No version is asked for
or checked: the row gives a path, not a capture, exactly as before this read
moved out of the folder. A change to the file after the read does not change
the request.

This is best effort against a program writing the folder at the same moment.
Each component is checked and then used in separate steps, so a writer that
replaces a directory on the way with a link, between its check and the open,
is followed. Opening without following a link protects the last component
only.

## Recording and publication

There are two capture devices. The microphone device (`src/lib/microphone.ts`)
uses the WebView's `MediaRecorder`. The fixture device (`src/lib/capture.ts`)
returns fixed bytes and marks them `fixture`. A workspace has exactly one,
chosen when it opens; neither falls back to the other. The saved extension
comes from the container signature in the bytes (`src/lib/audio-format.ts`),
and from the recorder's claimed MIME type only when the signature is not
recognized.

### The microphone

The microphone device also has `inputs`: listing, asking for access, and a
level reading. The fixture device has none, so in fixture mode nothing lists,
asks for, or opens a microphone.

- A chosen microphone is asked for as `{ deviceId: { exact } }`. A WebView
  that cannot open exactly that one answers with a refusal
  (`InputUnavailable`), and a stream that reports another device is released
  and refused. The system default is asked for only when nothing is chosen.
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
the same microphone another ID in a new origin, and the desktop page's origin
changes with the host's port, so a choice may need choosing again after a
restart. That is a known limit, not yet checked on hardware.

`src/lib/recordings/publish.ts` publishes a capture and finishes one that
stopped partway. A capture is fixed when it ends: its ID, its bytes, and every
field of its row, including the `audioPath` its audio is saved at. The two
files are two saves, in order: `files.create` the audio, then
`tables.recordings.create` the row (ADR-0482). Each save reports its own
outcome: `audioNotSaved` stops before the row, and `rowNotSaved` keeps the
audio's place. A lost reply leaves that save's outcome unknown. The capture
stays in the page through both.

The first attempt writes without reading. A create refused as `Exists` reads
what is there before calling it anything, since an earlier write of this
capture whose reply was lost can land late: exactly this capture's audio, or
this recording's row, is found and the attempt goes on; anything else is left
alone. A retry, which the person asks for, reads both paths first:

| The folder has | The retry |
| --- | --- |
| Neither file | `files.create` the audio, then `tables.recordings.create` the row. |
| Exactly this capture's audio, and no row | `tables.recordings.create` the row. The audio is not written again. |
| This capture's row and exactly its audio | Reports it saved and writes nothing. |
| Another row, other audio (same size or not), or the row without its audio | Refuses and writes nothing. |

Nothing ties the second save to the audio the attempt read. Another writer can
change the audio between that read and the row's creation; the attempt reports
what it observed and never claims the two files were saved together. Both
creates are exclusive, nothing is ever saved with `overwrite`, and the row's
source always comes from the table's own `create`.

Only the two paths the capture names are looked at. A file that merely shares
the stem, such as `recordings/<id>.m4a`, is not the recording's and does not
block it.

A `published` outcome names how each file is known to be in place: `receipt`
when this attempt's own create was confirmed, `found` when the attempt read it
there. A found file says nothing about which write put it there. A
`published` capture is saved: it leaves the window's list, the lists are read
again, and the recording opens unless the person selected something else
meanwhile. Opening it is an ordinary read; when the row cannot be read or is
gone, the details say so, and nothing is written again.

"This recording" is a valid row with the capture's `recordedAt`, `durationMs`,
`capture`, and `audioPath`. The title and notes are the person's to change and
are not compared, so an edited row is still this recording.

`audioNotSaved`, `rowNotSaved`, `refused`, and `unchecked` (a retry that could
not read the folder) are not confirmed publications. They stay unresolved, are
reported as not saved, hold the app open, and **Try again** starts from the
retry table above.

So a retry keeps the recording's identity, cannot create a second recording,
and never replaces a file it did not just read and recognize as its own. A
save is reported on its own; the commit it requests is a separate outcome.

## Transformations

`src/lib/transformation.ts` is the request: `POST <base>/chat/completions` with
the model, the prompt as the system message, and the input as the user
message, reading `choices[0].message.content`. It is plain `fetch` with
`redirect: 'error'` and `credentials: 'omit'`, shared by the Bun host and the
browser workspace like the transcription request, and it refuses a base URL
that is not plain HTTP(S) before sending. `transformOverConnection` is the one
entry both use: it reads the text connection once, refuses a request prepared
for another base URL, and sends with that connection's key. An error never
carries the key: an endpoint that echoes it has it removed.

`src/lib/recipe.ts` decides whether a recipe runs and with what, from the
recipe as read (a listed row, or the draft on screen) and the text connection
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
connection's base URL. One lifecycle serves both, with the destination as the
only difference: a transcript's run writes `transformation_runs/` as soon as
its answer arrives; a pasted-text run holds its answer until `saveTextRun`,
which writes `text_runs/`. From there a run ends one of three ways:

| The run | What is held | Trying again |
| --- | --- | --- |
| Saved | Nothing. The row is in its table. | |
| Failed: the endpoint refused, was unreachable, answered wrongly, the transport threw, the connection moved, or the host's reply was lost | Nothing was received. The run is listed as failed. After a lost reply the endpoint may still have been called. | Only when the person asks. Sends the same request, under the same stem, only while the text connection is still the base URL in the snapshot and, for a transcript, while the folder still has that transcript text and its recording. Otherwise it stays failed and says why. |
| Unsaved: the answer arrived and its row is not written (a pasted-text answer waiting for Save, or a write that failed) | The text, in the window. It blocks closing. | Writes the row. The endpoint is not called. |

One recipe holds at most one pasted-text run that is running or unsaved; a
new run on pasted text is refused until it is saved or discarded, so a
received answer is never replaced. Concurrent saves or retries of one run are
one.

Saving a run, or a received transcript, is one `createOnce`
(`src/lib/runs.svelte.ts`): the row is created exclusively at its stem, and
when the stem is taken, what is there is read. This run's own row already
there (an earlier write landed and its answer was lost) is recognized and
nothing is written. Its own row means a valid row with the same body and the
same fields, including any field another writer added. Any other
file there, including one that differs only in its prompt, model, endpoint,
input, or source, is not overwritten and the run stays unsaved. So one run
can produce at most one result file. A run discarded while its row is being
written may still land; the discard is not undone.

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
running, or its answer is received and unsaved, and `remove` also refuses when
a result was saved after the person was asked. While `remove` runs, no request
starts for that recording. A failed run holds nothing; it is dropped with the
recording. Results on pasted text name no recording, so they are neither
deleted with one nor in the way of deleting one, readable or not.

What a deletion of a recording or transformation path removes is decided by
its file as read after its draft settles, not by the last listing. A draft
whose save failed or conflicted does not refuse the deletion: the person
chose to delete the file, and the dialog says unsaved edits are discarded.
Removing releases the session, waits for it, and deletes what was confirmed,
or what the session last saved when that changed after the person was asked. A row that reads is deleted as above. A file that
is there and does not read as a row (bytes that are not text, say) is removed
alone, conditional on the exact bytes read, and the person is told its
results are kept: nothing in the file says which results are its own, so
none is deleted with it. For a recording, the same guards hold by its name:
the capture and the confirmation both refuse while work for that recording
is running or unsaved, and nothing new starts for it while it is removed.

## Drafts and conflicts

Open files are drafts (`src/lib/drafts.svelte.ts`), each in its own edit
session from `@epicenter/svelte/edit-session`. The app owns the draft; the
folder's guarded autosave writes it.

- A recording, transcript, or transformation that reads as a row is a row
  session over its fields and body.
- A row file whose text is not a valid row, a row the person chose to edit in
  Source, and any other text file is a text session over the exact text. A
  row file's text shows its issues live (`parseRow`), and its fields open
  once it reads.
- Audio and files that are not text open as what they are.

Several drafts are open at once: the selected recording or file with the
recording's transcripts beside it, and the selected transformation. Selecting
another item leaves the drafts it replaces: their saves land, then their
sessions are released. A draft whose save failed or conflicted is left only
when the person discards it; the view asks "Discard unsaved changes?" and
binds the discard to that session.

Each edit changes the draft and requests a save at once. One write runs at a
time and only the latest request waits, so rapid typing writes the latest
draft. A draft that is not a valid row is refused as `InvalidValues` and
never written. Text typed into a field is kept well formed: a lone surrogate
becomes U+FFFD, as a file holds it. Every write is guarded by the bytes the
session last saved, so a change made elsewhere, or a deleted file, is
`Conflict`. The session then asks the folder to merge the draft with the
file: a row field by field, text by line. Changes that do not overlap are
written with no question, and the draft becomes the result. Parts both
changed, a file deleted elsewhere, and a file that no longer reads as a row
become the session's review, which the save bar shows with "Your edit" and
"Saved elsewhere" for each part. Apply answers every part at once
(`library.resolveReview`); there is no Cancel, because the draft is waiting
to be saved. A recording's session merges with `restore: false`: one
deleted elsewhere is never created again, since its audio may be gone too,
so the folder refuses Your edit beside that part and Saved elsewhere closes
it. Returning to the window takes a
newer version of a draft that holds nothing unsaved; otherwise the next save
reports the change. The lists are read when the page opens, after the app's
own actions, and on return (window focus, or the page becoming visible); a
change hint from the folder does not reread. The save bar is the shared
`@epicenter/svelte/save-bar`, and the library counts its commands with
`createAdmissions` (`@epicenter/svelte/admissions`): each command from its
call, and a run only while it does folder work, never while it waits on an
endpoint.

Renaming a file moves an open draft with it once its saves land
(`session.rename`); a closed file moves as it is now. Recording and
transformation files keep their names. Deleting an open file releases its
session, waits for its saves, and deletes what its last save confirmed. While
the app decides whether to close, every session is locked; closing waits for
running saves and releases them.

## Closing

Unsaved work lives only in the page, so the shell never decides to close on its
own. It holds back a window close and every exit request (Command-Q is a menu
item it owns, so that path cannot bypass it) and asks:

```text
shell   writes {"type":"close-requested"} to the host's standard input
host    sends a close-requested event to the page
page    saves what can be saved, then answers POST /bridge/app { op: "close" }
          proceed   nothing is held, or the person chose Discard and quit
          asking    it is showing its confirmation
          cancel    the person chose Keep working
host    prints {"closeApproved":true} when the answer is proceed
shell   exits; the owner settles the folder, and the host is stopped
```

On macOS a quit can also come from the system: the Dock's Quit, a logout,
restart, or shutdown, and an Apple Event send AppKit's `terminate:`, which Tao
would let end the app with no exit request at all. `src-tauri/src/quit.rs`
adds `applicationShouldTerminate:` to Tao's delegate class first in setup,
before the menu, host, or window, and the app does not start if that class is
not what the guard was checked against. The method always cancels AppKit's
quit and asks for an ordinary exit, which is held and asked like any other.
So a logout or restart is always cancelled while Whispering runs, even with
nothing unsaved; the person starts it again once Whispering has exited.
`evidence/native-quit/README.md` records the gap, the guard, its harness
(`src-tauri/examples/quit`), and what to rerun after a macOS, Tauri, or Tao
upgrade.

`src/lib/leave.svelte.ts` is the page's side, over the workspace's `closing`
capability; a browser workspace has none and relies on the browser's leave
warning. The session creates the guard, so it answers from every page and
stops with the session. The page acknowledges every request with `asking` before it does
anything else, and treats a failure to find out what is held as holding
something.

When a request arrives, before anything is awaited, the library stops
admitting new work (`pauseAdmission`): no capture starts or stops, no request,
retry, file change, terminal command, commit, or typing. Work it had already
accepted continues: saves settle, and a request already sent is shown as
running and holds the close. A transformation whose reads were under way is
counted as running, and is not sent once admission has stopped. The prompt
covers the page from that moment, so nothing on screen takes input either.
"Keep working" admits work again. Sending `proceed` commits the quit: admission
never resumes, "Keep working" is no longer offered, and an answer that could
not be delivered leaves the page frozen with one action, quitting again. A
lost reply may still have been taken, so it is never read as a refusal.

Approval is never inferred. The host approves only on the page's authenticated
`proceed`. Whether the page's event stream is open, or ever was, says nothing
about what the page holds: a page can record and save while that stream has not
connected. So a request with no stream to carry it waits and is delivered when
one connects, and a page that does not answer keeps the window open. If the
page itself stops responding, Force Quit is the way out.

The desktop workspace owns that stream (`src/lib/workspace/desktop.ts`). It
opens one, reconnects when it drops, and hands a close question to whoever is
listening. A question that arrives before the session's guard is listening is
kept and delivered when it does; the host repeats an unanswered question to
every stream that connects.

A host that has stopped is not approval either, because the page still holds
its work. The shell then keeps the window and raises a `whispering:close-blocked`
event in the page, which shows the same confirmation. Choosing to quit
navigates to `/__whispering__/quit`; the shell refuses to load that address
and, only while the host is gone, exits on it. The shell exits with no answer
at all only when the app never started and the window is the failure page.
None of this adds a Tauri command: the question and the answer travel over the
host's standard streams and the authenticated bridge, and the host-gone
fallback uses a page event and a refused navigation.

With the host gone the folder is still open, since the shell owns it. Changes
to recordings, transcripts, and other files can still be saved, a pending
recording can still be tried again, and a commit can still be made. What is
gone is what the host did: the terminal, new transcription and transformation
requests, reveal, the key, and the relay of this question. The prompt says
exactly that and reads what is held live, so it shrinks as things are saved.
It promises nothing about any one save, which can fail for its own reasons
with or without the host. Quitting in this state is always the person's
explicit choice, even when nothing is held, because nothing can relay an
answer for them.

### While the session is starting

Opening starts the workspace, reads the folder, and reads the device's
connections. A connection that is not set up stays that way; opening creates
no file and sends nothing.
The close guard is not created until startup has settled
(`createSession` in `src/lib/session.svelte.ts`): until then there is an
opening, not a session, and nothing answers the shell, not even `asking`.

A close asked in that time is not dropped. The host keeps an unanswered
request and repeats it to every stream that connects, and the desktop
workspace keeps one that arrives while nobody is listening, over the stream or
as the shell's host-gone event, and hands it to the first listener. When the
session has started, its guard receives the kept request and decides as it
would for any other: from a session that has finished starting.

If the start fails, the library and the workspace are closed first. Only a
completed close permits the answer described next to take over. If cleanup
also fails, the opening preserves both causes and approves no close. A layout
released while its session is still starting gets the same cleanup and no
answer at all.

One request is not carried across: a close attempted with the host already
gone, during a start that then fails. The shell raises that event once per
attempt and nothing repeats it, so the person closes again.

### When opening failed

The shell marks the page as opened when the window is built, before the page
has attached to anything. If the workspace then cannot be opened (the host
does not answer, the owner refuses the window, or the two name different
directories), or the session cannot start, there is no session and no guard,
and the shell would wait forever for an answer to a close.

So the holder of the opening answers instead (`mountSession` in
`src/lib/session.svelte.ts`, `answerCloseWithNothingOpen` in
`src/lib/workspace/closing.ts`). A returned refusal or an
`OpeningReleasedError` proves that nothing remains open. Only then is each
close the person asks for answered `proceed` through the host, or with the
quit address when the host is gone. A failed cleanup or an unexpected
rejection from the opener proves no such thing and installs no answer.

Whatever the failure, the failure page in Whispering's shell offers a Quit
button. Pressing it answers `proceed` through the host and, if the host does
not take it, navigates to the quit address as well; the page says when
neither was confirmed. It refuses while the opening is under way and after
the layout is released, and nothing listens for it. `closing.ts` reaches only
the bridge, so this works when the desktop workspace's own module is what
failed to load. A browser tab and a desktop app that injected no host token
offer no Quit.

It is narrow on purpose:

- It answers requests. It never closes anything unasked and has no timer.
- It does not run while an opening is under way, which includes the session's
  first read and connections read. A close asked then waits: for the session's
  guard if the opening succeeds, for this answer if it fails, and in that case
  only after everything the opening had opened was closed.
- It does not run while a session exists, and it is stopped when the layout
  is released, so it can never answer for a session that holds work.
- It uses the same authenticated `close` operation and the same quit address
  as the guard. The shell gained no command and no privilege for it.
- A desktop app that injected no host token is not Whispering's shell and
  asks no close question, and a browser tab has the browser's own; neither is
  answered.

When the shell exits, the owner refuses new work, lets the saves and commits
it had already admitted finish, and releases the folder. Checkpoints already
inside Git protection finish; waiting automatic requests are cancelled.
Shutdown makes no final commit, so those saves can remain uncommitted. Closing the page's folder handle only detaches the window.

## History

The shell registers the folder with automatic commits on and no remote. A
complete content save requests automatic local history and does not wait for
Git. While protection is busy, requests coalesce; the worker captures the
latest files when admitted. A failed checkpoint stays visible and is not
retried until a newer save or **Commit now** requests another attempt.
`src/lib/status.ts` turns the folder's Git snapshot into separate lines for
saved files, uncommitted changes, and the last commit attempt, and never lets
a commit outcome change what it says about a save.

## The terminal

`native/terminal.ts` runs one shell process per command in the data folder. The
shell prints its final directory behind a marker that is new for each run; the
host cuts that tail off and carries the directory to the next command. There is
no terminal device, so nothing interactive runs. `src/lib/terminal.svelte.ts`
keeps the session (output, history, typed command) for the life of the window,
so hiding the terminal loses nothing.

It is the person's real shell, not the folder's in-page one, and it writes the
directory as any other program does, outside the owner. Nothing it writes is
committed until a save or an explicit commit includes it. An open draft whose
file it changed conflicts on its next save, like any other outside edit.

## Noticing outside changes

The page reads the folder when it opens, after its own actions and terminal
commands, and when the person returns to the window, which also takes a newer
version of each open draft that holds nothing unsaved. It does not follow the
folder's change hints. The host watches nothing and says nothing about files.

## Debug builds

The shell sets `WHISPERING_DEBUG=1` for the host when it is compiled with debug
assertions and removes it otherwise, whatever the environment says. Only then
does the host accept `WHISPERING_AUDIO_FIXTURE` and construct
`native/failure-injection.ts`.

Injected publication failures are counted, so a test can order failure and
retry exactly. They are real failures of the real saves, and the folder's own
saves are still the only thing that publishes. `publishRecording` takes an
optional `around` hook that runs each of its two writes; in a debug shell the
workspace supplies `aroundRecordingWrite`, which asks the host to `obstruct`
before the write and to `unobstruct` afterward. The host puts an empty
directory at the path of the write that should fail, the owner runs the
write, and the host removes the directory. The owner then reports the row's
own failure (`rowNotSaved`, audio saved) or the audio's own failure
(`audioNotSaved`, nothing saved). Only a recording's row path and the audio path
it creates can be obstructed; both are checked before they are joined onto
the root, and a path that is occupied or passes through a link is left alone.
A host that cannot be asked places nothing, and the recording is published
all the same.

The injected commit failure is a real lock file on the ref of the branch `HEAD`
names, created exclusively and tagged with a marker unique to that host. The
host removes only a lock carrying its own marker, so it never takes or clears a
lock another Git process holds. Because the host does not initialize Git, the
lock can only be taken once the owner has opened the folder: a lock asked for
at launch (`WHISPERING_DEBUG_BLOCK_COMMITS=1`) waits until the page has
attached and says so (`injection-launch`).

## Where things are

| Path | Role |
| --- | --- |
| `src/lib/definition.ts` | The inert folder declaration. |
| `src/lib/workspace/` | The storage seam and its two implementations. |
| `src/lib/bridge/` | The page's link to the host: its wire encoding and the HTTP calls. Nothing of the folder. |
| `src/lib/session.svelte.ts` | The one session a mounted layout owns, and its context. It holds what the shell shows, the post-processing choice, the pasted text, and the settings draft. |
| `src/lib/settings-draft.svelte.ts` | The one draft of the two connections, shown by the header's Settings and (transcription only) by the control on Home. |
| `src/lib/connections.ts` | The connection rules both storages apply: canonical base URLs, key keep/replace/remove, moving an earlier build's key. Pure; stores nothing. |
| `src/lib/recipe.ts` | The one decision about whether a recipe runs and with what. |
| `src/lib/post-processing.ts` | What the post-processing choice is now, read against the listed transformations and the recipe resolver. It runs nothing. |
| `src/lib/library.svelte.ts` | Product state: lists, selections, open drafts, pending captures, settings, and the command that answers a draft's review. |
| `src/lib/drafts.svelte.ts` | The open files, one edit session each. |
| `src/lib/runs.svelte.ts` | Transcription and recipe runs, and `createOnce` for their result rows. |
| `src/lib/deletion.ts` | What a deletion removes, captured from fresh reads, and the removal. |
| `src/lib/recordings/publish.ts` | Publication and recovery. |
| `src/lib/capture.ts`, `microphone.ts`, `audio-format.ts`, `transcription.ts`, `transformation.ts` | The capture contract and fixture device, the real microphone, container detection, the transcription and transformation requests. |
| `src/lib/microphone-input.svelte.ts` | The chosen microphone and the test of it, for one session. |
| `src/lib/audio-source.ts` | What a player holds, reloaded by content version on each folder refresh. |
| `src/lib/status.ts`, `files.ts`, `terminal.svelte.ts` | Status lines, the file tree, the terminal session. |
| `src/routes/` | The layout that owns the session, and the three pages. |
| `src/routes/components/` | The shell, navigation, header, unsaved notices, recorder, recording and transformation lists and details, file browser and view, terminal. |
| `src/lib/assets/` | The microphone mark from the earlier Whispering. |
| `native/` | The host: `main.ts`, `host.ts`, `audio.ts`, `device-file.ts`, `terminal.ts`, `failure-injection.ts`. |
| `src-tauri/` | The shell: the window, the folder's registration and capability, and the host's lifetime. `shell/index.html` is shown only when the app cannot start. |
| [scripts/build-sidecar.ts](./scripts/build-sidecar.ts) | Compiles the host for the bundle. |
| `src/lib/tauri/bindings.gen.ts` | Generated by the Epicenter host's build for its own tests. Nothing here imports it. |
