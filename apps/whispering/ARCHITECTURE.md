# Whispering architecture

Whispering is three parts. Each has one job, and exactly one of them opens the
data folder.

```text
src-tauri/        the shell     a window, the folder's grant and lock, and one child process
native/           the host      serves the page and does what a page cannot
src/              the page      the UI; opens the granted folder, fetches the host
```

```text
┌───────────────── Tauri shell (Rust) ─────────────────┐
│ chooses the folder, registers it for the main window │
│ starts the host with that path, reads its port,      │
│ lets the page on that origin ask for the folder      │
│ loads http://127.0.0.1:<port>/, injects the token    │
│                                                      │
│   tauri-plugin-epicenter-folder: grant and lock;     │
│   checked reads, file changes, and `git` runs        │
└────┬──────────────────▲────────────────┬─────────────┘
     │ spawns           │ invoke         │ reads, changes, git
     ▼                  │                ▼
┌── host (Bun) ─────┐  ┌┴─ page (WebView) ──┐   the data folder
│ page, terminal,   │◄─│ the folder engine  │   and its .git
│ requests, key,    │  │ fetch /bridge/app  │        ▲
│ close relay       │─►│ event stream       │        │
└─────────┬─────────┘  └────────────────────┘        │
          └── an ordinary program in that directory ─┘
```

The page opens the folder with `@epicenter/folder/tauri` and names only the
folder's ID. The shared Rust plugin (`tauri-plugin-epicenter-folder`), in the
shell's process, grants the main window the directory the shell registered
and holds the folder's lock. The page's own folder engine then makes every
read (`read_folder_file` and the rest), every change (`write_folder_file` and
the rest), and every `git` command (`run_git`) through the folder plugin. It
reads only inside the granted directory and never through a link; it checks
each change against the shared path rule and keeps it out of Git's private
state. This app has no folder code of its own on the desktop: no copy of the
plugin's bindings and no second transport.

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

Every file command, including settings saves, file creation, rename, and
deletion, is a TanStack mutation. Closing the session waits until the
mutation cache is idle. A request to an endpoint is not waited for: its result
row is in the folder before it goes out (ADR-0542), and an answer that has not
arrived when the app quits is lost.

## The storage boundary

`src/lib/workspace/types.ts` is the one seam. `openWorkspace()` picks an
implementation when the app layout mounts:

| | Desktop (`desktop.ts`) | Browser (`browser.ts`) |
| --- | --- | --- |
| Folder | The real directory the shell grants, opened by the page's engine (`openFolder` from `@epicenter/folder/tauri`) | One OPFS directory, files and `.git` together (`openFolder` from `@epicenter/folder/browser`); a folder an earlier build kept in IndexedDB is not read |
| Terminal | Your shell in the directory, run by the host | None |
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
2. The folder. `openFolder({ id: WHISPERING_FOLDER_ID, definition })` asks
   the shell for the scope `so.epicenter.whispering` (`grant_directory`) and
   opens the directory it is granted. The shell's refusal (an unknown scope,
   a window the scope does not list, a folder another process holds, a
   missing permission) is `DesktopFolder`, with the shell's own reason, as is
   a granted folder the engine cannot open.

The page then checks that the grant and the host name the same directory and
refuses with `FolderMismatch` if they do not, since the terminal and
transcription would otherwise use a directory the saves do not go to.

Everything above the seam (`library.svelte.ts`, its query cache, the components)
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
   with that path for the window labelled `main` alone, as a folder the page
   opens with its own engine. Its author,
   `Whispering <whispering@localhost>`, is only the fallback: the page reads
   `user.name` and `user.email` from Git's configuration, the repository's
   and the person's global settings, and records versions as them when they
   are set. Nothing is pushed: Whispering offers no sync.
4. **The capability.** The page is served from `http://127.0.0.1:<port>`,
   which Tauri treats as a remote origin with no commands at all. One
   capability, added at runtime because the port is not known until then,
   grants the `main` window, on exactly `http://127.0.0.1:<port>/*`, the
   folder plugin's commands (`epicenter-folder:default`) and nothing else.
   They read and change only the directory `grant_directory` names, `.git`
   included. `tauri.conf.json` lists no capability.

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
    │                      Files, Terminal, close prompt
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
selections, running requests, the query cache, and the terminal
session are fields of the library, and the pasted text a transformation is tried on is
a field of the session's view, not of any page, so none of them is touched by
navigation. What a
page keeps in its own component (which tab is showing) is the only thing a page
change resets.

Leaving is guarded in one place, the shell. `beforeNavigate` holds a navigation
only when it unloads the document while a change is still being written; a navigation between
routes is never held. In a browser tab that raises the browser's own leave
warning. The desktop app does not raise it, and quitting there is immediate;
see "Closing".

The host serves `index.html` for any path that is not a file, so
`/recordings` and `/transformations` open directly and survive a refresh.

## The bridge

The bridge is the page's link to the host. It carries Whispering's own
operations, and nothing of the folder: there is no
folder route, no generic method call, no file change sent as data, and no Git
snapshot pushed over it. Tables, KV, conditional publication, and history are
the page's own folder engine, over the directory the shell granted.

```text
POST /bridge/app      { op, payload }   -> { ok: <value> } | { fault: "<message>" }
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
`fixture`, `inject`, `injection`, `obstruct`, and `unobstruct`.

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
the same microphone another ID in a new origin, and the desktop page's origin
changes with the host's port, so a choice may need choosing again after a
restart. That is a known limit, not yet checked on hardware.

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
- **An edit** holds its own starting version, outside the cache: a draft per
  row file (`createDraftState` from `@epicenter/folder/svelte`), held by the
  library so it outlives the view it was typed in. A read never touches it;
  the detail shows the draft, and the table shows the row once it is saved.
- **A save** is the table's `save` mutation, over the version the edit
  started from, one at a time per file. Changes typed while one runs are sent
  next, from the version it wrote. A file changed since is merged in the
  engine: what only one side changed is kept, and where both changed the
  edit wins and the save names what it replaced, which the shell shows as a
  toast.
- **Text** edited as a whole file has no merge: its write is `files.replace`
  guarded by the version the edit started from, one at a time. A file changed
  elsewhere refuses it; the typed text is dropped and the shell shows a toast
  that can copy it, and the file is read again.
- **A failed save** keeps the draft; it is saved again with the next change,
  and before anything that reads files (a run, a rename, a deletion, Save
  version, closing). A recording or transcript deleted elsewhere stays
  deleted: its save fails with `NotFound`, the draft is dropped and offered
  to copy, and the listing reads it gone.
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
ADR-0529) or by `git commit` in the terminal.

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

On exit the shell stops the Bun host by closing its standard input, and the
folder plugin releases the folder's lock. A save is two commands, its bytes
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
`folder.git.commit()`, or runs `git commit` in the terminal. A failed commit
stays visible and is not retried on its own. `src/lib/status.ts` turns the
folder's Git snapshot into separate lines for saved files, changes since the
last version (neutral detail, not a warning), and the last commit attempt,
and never lets a commit outcome change what it says about a save. A commit's
author is `user.name` and `user.email` from Git's configuration, the
repository's or the person's global settings, and
`Whispering <whispering@localhost>` only where neither is set.

## The terminal

`native/terminal.ts` runs one shell process per command in the data folder. The
shell prints its final directory behind a marker that is new for each run; the
host cuts that tail off and carries the directory to the next command. There is
no terminal device, so nothing interactive runs. `src/lib/terminal.svelte.ts`
keeps the session (output, history, typed command) for the life of the window,
so hiding the terminal loses nothing.

It is the person's real shell, not the folder's in-page one, and it writes the
directory as any other program does, outside the page's engine. Nothing it writes is
committed until a version is saved. A file it changed is read again after the
command and when the shell's watcher reports it; an edit of that file merges
with the change when it saves, like any other outside edit.

## Noticing outside changes

The folder's change channel (`folder.onFilesChanged`) is the one detector of
changes the page did not make (ADR-0548). On the desktop the shell's file
watcher on the granted directory reports changed paths, or everything after
it starts, after the computer wakes, and when it dropped events; in a browser
tab the folder's relay reports other tabs' writes, and everything when a tab
resumes. Each report invalidates exactly the queries it names. The host
watches nothing and says nothing about files. Returning to the window reads
nothing.

## Debug builds

The shell sets `WHISPERING_DEBUG=1` for the host when it is compiled with debug
assertions and removes it otherwise, whatever the environment says. Only then
does the host accept `WHISPERING_AUDIO_FIXTURE` and construct
`native/failure-injection.ts`.

Injected recording-write failures are counted, so a test can order them
exactly. They are real failures of the real saves. The library runs a
recording's row write at start, and its stop (which writes fixture audio),
through `aroundRecordingWrite`; in a debug shell it asks the host to
`obstruct` before the write and to `unobstruct` afterward. The host puts an
empty directory at the path of the write that should fail, the page's engine
runs the write, and the host removes the directory. The folder then reports
the row's own failure (the recording runs, and its audio has no row) or the
audio's own failure (the row has no audio). Only a recording's row path and
its audio path can be obstructed; both are checked before they are joined
onto the root, and a path that is occupied or passes through a link is left
alone, so microphone audio the shell already wrote is never obstructed. A
host that cannot be asked places nothing, and the write is made all the
same.

The injected commit failure is a real lock file on the ref of the branch `HEAD`
names, created exclusively and tagged with a marker unique to that host. The
host removes only a lock carrying its own marker, so it never takes or clears a
lock another Git process holds. A folder with no repository yet has no
`HEAD`: opening creates none, and the first commit does, on the folder's own
branch `main`, so that branch is locked, and the first commit fails on it as
any later one does. A lock asked for at launch
(`WHISPERING_DEBUG_BLOCK_COMMITS=1`) is taken when the host starts; one it
cannot take is logged. Released before any repository exists, the lock takes
the directories made for it along.

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
| `src/lib/library.svelte.ts` | Product state over the query cache: the listings, the change channel, edits held as drafts and their saves, selections, the live recording, settings, and every action as a mutation. |
| `src/lib/runs.svelte.ts` | Transcription and recipe runs: the result row written when each starts, its answer written into it, and what each row shows. |
| `src/lib/deletion.ts` | What a deletion removes, captured from fresh reads, and the removal. |
| `src/lib/capture.ts`, `microphone.ts`, `audio-format.ts`, `transcription.ts`, `transformation.ts` | The capture contract and fixture device, the real microphone over `@epicenter/recorder`, container detection, the transcription and transformation requests. |
| `src/lib/microphone-input.svelte.ts` | The chosen microphone and the test of it, for one session. |
| `src/lib/audio-source.ts` | What a player holds, reloaded by content version on each folder refresh. |
| `src/lib/status.ts`, `files.ts`, `terminal.svelte.ts` | Status lines, the file tree, the terminal session. |
| `src/routes/` | The layout that owns the session, and the three pages. |
| `src/routes/components/` | The shell, navigation, header, recorder, recording and transformation lists and details, file browser and view, terminal. |
| `src/lib/assets/` | The microphone mark from the earlier Whispering. |
| `native/` | The host: `main.ts`, `host.ts`, `audio.ts`, `device-file.ts`, `terminal.ts`, `failure-injection.ts`. |
| `src-tauri/` | The shell: the window, the folder's registration and capability, and the host's lifetime. `shell/index.html` is shown only when the app cannot start. |
| [scripts/build-sidecar.ts](./scripts/build-sidecar.ts) | Compiles the host for the bundle. |
| `src/lib/tauri/bindings.gen.ts` | Generated by the Epicenter host's build for its own tests. Nothing here imports it. |
