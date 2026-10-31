# Whispering architecture

Whispering is a page that runs in a browser tab and keeps its folder in
browser storage. Exactly one thing opens the data folder: the page's own
folder mirror. Whispering has no desktop shell; Epicenter no longer hosts it
([ADR-0701](../../docs/adr/0701-apps-run-as-separate-programs.md)). The
hosted design is archived at the tag `archive/app-hosting`.

```text
src/                        the page      the UI; opens this site's folder
```

The page opens the folder with `@epicenter/folder` and names no folder: in a
browser tab that is this site's local folder in IndexedDB. The page's own
folder mirror then makes every read and every change, and notices outside
changes when it looks at storage again. Its two AI connections live in this
site's `localStorage`, and a request leaves from the page, either to a custom
endpoint, which must allow the page's origin (CORS), or to the Epicenter API
through the signed-in account.

## The data model

`src/lib/definition.ts` names five tables and the schema each row's
frontmatter reads through (`whisperingTables`), built from the shared field
vocabulary (`@epicenter/definition`). The folder mirror from
`@epicenter/folder` reads them as Markdown rows at `<table>/<id>.md`. A
schema only interprets (ADR-0632): a row that does not fit comes back as a
`Row` with its issues (`not-text`, `frontmatter`, `schema`, or `unreadable`
for a read that failed), and a save never validates, so a field another
program added survives every edit. A table owns exactly one Markdown file per
row; any other file is an ordinary file, a `FolderFile` from `folder.file(path)`
or `folder.files`.

Opening lists the folder and reads every text file (Markdown, the common text
extensions, and names with no extension such as `.gitignore`), so reads are
synchronous and complete; there is no loading or missing state, and a row
that is not there is `row(id) === undefined`. Audio and other files are listed
with `data: undefined` and fetched with `folder.read(path)`. The mirror never
runs ahead of the disk: it changes when a write lands or a read sees another
writer's change, so a failed write needs no rollback. Every write answers
`Saved` once it landed and the mirror shows it. Writes wait in one queue and land
in order over the file as it is then; an `update` sets the fields and body it
names and writes canonical frontmatter (declared keys in schema order, then
others sorted, comments dropped), and a patch that changes no value writes
nothing. `readRow(text, schema)` reads typed text exactly as the mirror reads a
saved row, which is how a repair view checks Source before it saves. The
package's `src/folder.ts` is the contract.

`definition.ts` builds the table schemas with `@epicenter/definition` and
TypeBox. Schemas interpret the files; they do not own their persistence.

What Whispering adds on top:

- A recording's identity is its stem. Results refer to it by `recordingId`, so
  the app never renames a recording's row; the title is a field.
- A recording resolves its audio from the unique supported same-stem file
  beside its Markdown row in `recordings/`. No matching file is absent; several
  matching files are ambiguous and cannot play or transcribe. Rows store no
  path, and no metadata field overrides this layout. Deleting a recording
  keeps the audio as an ordinary file.
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
  optional key. They are `whispering.connections` in this site's
  `localStorage`; either one may instead name the signed-in Epicenter
  account and a model. `src/lib/connections.ts` holds the rules a storage
  applies.
- The chosen microphone is not folder data either: it names hardware on one
  device. It is `whispering.microphone` in the origin's `localStorage`
  (`src/lib/microphone-preference.ts`), so it lasts between visits to the
  same site.

Every file action, including settings saves, file creation, rename, and
deletion, checks `whispering.closing` before starting. Late provider and
recording answers check the same state before changing product state or
saving. Product teardown itself waits for nothing; `<OpenFolder>` then closes
the folder, which refuses new writes, sends what waits, and releases storage.
A request to
an endpoint is not waited for: its result row is in the folder before it goes
out (ADR-0542), and an answer that has not arrived when the app quits is lost.

## Folder and platform capabilities

The layout gives `<OpenFolder>` (`@epicenter/svelte/open-folder`) an inline
opener:

```svelte
<OpenFolder open={() => openFolder({ tables: whisperingTables })}>
	{#snippet children(folder)}
		<WhisperingApp {folder}>{@render props.children?.()}</WhisperingApp>
	{/snippet}
</OpenFolder>
```

OpenFolder opens the folder, wraps it with `svelteFolder` so every read is a
tracked getter or lookup, looks at storage again on focus, visibility, and
coming online, asks on browser unload only while a write is out, and closes the folder
when it unmounts. WhisperingApp puts that folder in Whispering's own context
(`setFolder` in `src/lib/folder.ts`, typed `SvelteFolder<WhisperingTables>`)
and constructs its product state with `createWhispering(folder)`. That
constructor assembles the app's capture,
inference, connections, and preferences through `#platform/services`. The
layout and route pages do not construct or receive a separate workspace.

`#platform/services` (package.json "imports") maps to
`src/lib/platform/browser.ts`, and `#platform/auth` to
`src/lib/platform/auth.ts`. `platform/types.ts` describes those app
capabilities. They neither open nor close storage:

| | Browser (`browser.ts`) |
| --- | --- |
| Folder | This site's local folder in IndexedDB (`openFolder({ tables })` from `@epicenter/folder`); earlier OPFS folders are not read or changed |
| Recording | `MediaRecorder`, written on stop |
| Transcription and transformation | The page sends the request, so a custom endpoint must allow its origin (CORS); the account route sends through the signed-in account's `fetch` |
| Connections and keys | `whispering.connections` in `localStorage` |
| Local transcription | None (`localTranscription` is `undefined`) |
| Chosen microphone | `localStorage` |

`platform/types.ts` still names members only a desktop shell would supply,
such as `localTranscription` and a status-read `problem` on the auth handle.
The browser leaf leaves them `undefined`; they stay unused until Whispering
has a desktop shell, which would reuse `@epicenter/recorder/tauri`,
`tauri-plugin-epicenter-recorder`, and the CLI's
`epicenter whispering-connection` command.

Everything above the seam (`whispering.svelte.ts`, the components) names
only the service contract. Opening returns a `Result`, and OpenFolder shows a
refusal on its "Could not open storage" screen as it is. The browser folder
refuses to open inside a Tauri window rather than open browser storage there.

Page code names types, `readRow`, and the layout's `openFolder` from
`@epicenter/folder`. `src/lib/platform-selection.test.ts` bundles the
browser build and reads what it pulls in: the browser services, the WebView
microphone, and no Bun or Node module or the native recorder.
`src/lib/page-boundary.test.ts` fails if anything else under `src/` opens a
folder, imports a platform adapter other than through `#platform/services`,
imports a Node, Bun, or Tauri module, or imports the Yjs store, sync, or an
account module.

## Connections and requests

`transcribe` and `transform` take what to send, the model, and the base URL
the page prepared the request for (`expectedBaseUrl`). The platform adapter
reads the operation's connection once, at entry; if it is missing, or the
base URL is not exactly `expectedBaseUrl`, it answers `ConnectionUnavailable`
or `ConnectionChanged` and sends nothing. `applyConnectionChange` refuses
keeping a key for another base URL before anything is saved.

Before preparing a request, the run captures valid current owner content. It
reads the input only if it has not been acquired and never saves source files
as part of preparation. Current audio siblings are discovered independently of
the listing. Running a result again inspects its held body and checks that its
own durable record still exists. Close and recording-deletion checks run again
after preparation and initial result publication.

A transcription reads its audio through the folder engine, from the path the
recording's row names, and sends those bytes with the file's own name and the
type its extension calls for. Audio that cannot be read is `AudioUnreadable`,
and nothing is sent.

A request whose reply never arrived says only that no reply arrived: the
endpoint may have received it and the answer been lost on the way back. The
page reports that as an unknown outcome and never as "not sent", and does not
make the call again; trying again is the person's choice and is one more
request.

## The product root and the pages

```text
routes/+layout.svelte      mounts one shared OpenFolder
└── OpenFolder             opens, wraps, watches, and closes the folder
    └── WhisperingApp      creates product state; header, navigation, Files
        ├── /             recorder and latest recording
        ├── /recordings   list, details, raw files
        └── /transformations
```

`OpenFolder` owns opening, refreshing, and closing. `WhisperingApp`
receives only the folder it hands on, constructs product state with
`createWhispering(folder)`, and provides `getWhispering()` and `getFolder()`
to descendants. Pages build no product state and open no folder. There is no
module-level mutable state.

Unmount closes the folder: new writes are refused, waiting writes are sent,
and storage is released once they answer. If opening finishes after unmount,
OpenFolder closes that folder without registering a window guard.

Product construction is synchronous and reads nothing. Its `start()` first
calls `maintainExclusions` (`src/lib/exclusions.ts`), before any product read.
It reads the root `.gitignore` and inserts the four Markdown-only defaults before
existing text, after any BOM, if that ordered block is missing. An existing block
stays where it is. Authored rules after it and nested `.gitignore` files can
override the defaults; Git alone determines commit eligibility. The exact bytes
read (`folder.read('.gitignore')`) are preserved in an ordinary whole-file
`folder.write`.
A write is followed by a read to check that the root block remains present.
A refusal becomes `exclusionNotice`, shown by
the shell while Files and other work remain available. Reload checks a repair.
No Git or provider request is made.

The same startup attempt then calls `services.recoverRecordings()`, then
reads the connections and the saved microphone choice. It reads no folder
file: the mirror already holds them. A thrown startup error disposes
Whispering and shows its original message under "Whispering could not start".

On destruction, WhisperingApp calls `whispering.dispose()`, which returns at once.
It refuses new work and late answers, releases a microphone test, and stops
the effect that unticks recordings that left the folder. It finishes no
recording and waits for no write; a recording under way ends with the page
(ADR-0663). OpenFolder then closes the folder.

Settings keep one replace-only draft of explicit input, separate from saved
connection values. Untouched fields follow saved values and defaults; a
completed Save releases only what it submitted. Endpoint, model, key choice,
and key typed during that save remain for the next explicit Save.

Route changes render inside the same product root. The recording, selections,
running requests, pasted text, and settings draft survive them. Only
page-local presentation state, drafts in a view included, resets. Reload
mounts a fresh root and repeats startup.

Leaving asks through `beforeunload`: edits have already queued their values, and the page is
unsure while a write is out. A browser tab raises its
leave warning then. Internal route changes keep the mounted app and need no
guard; see "Closing".

The browser build serves a fallback page for every path, so `/recordings` and
`/transformations` open directly and survive a refresh.

## Recording

Whispering holds one capture state: idle, starting with its abort controller,
recording with its handle and initial row save, or stopping with its handle.
The recorder UI and transcription guard derive from it. Stop's completion can
outlive capture while its duration write finishes: the microphone is already
free for another recording. A repeated Stop joins that completion. Capture
state and Stop completion stay separate because their lifetimes differ.

A recording is in the folder from the moment it starts (ADR-0543). Whispering
names it at start: `startRecording` makes the ID from the start time,
asks the capture device to record into
`recordings/<id>` (`recordingAudioStem`), and writes the row with the start
time and capture source. The device
adds its format extension; the row stores no path. `stopRecording` stops the
device and writes the length (`durationMs`) onto the row it reads again, so a
title typed meanwhile is kept. Stop reports separately when audio was saved
but its row could not be created. Capture has no discard operation.
Closing Whispering neither stops nor deletes a running recording: leaving
the page ends it, and the recording held in the page is lost. Its row,
written at start, gets no length. A Stop already under way when Whispering
closes writes no length either. Nothing in a row says whether a recording is
running: Whispering's live capture says that, and a running recording is
refused transcription.

The capture forwards the recorder's first unexpected ending, including one
received before subscription. The active capture alone handles it, through
`finishRecording`, so it is finalized like an explicit Stop. Repeated or
stale endings cannot stop another capture, and an ending heard after Whispering
closed finishes nothing. Stop retires the recorder's listeners;
interruption adds no persisted status or second save queue. The browser
listens for final encoder output from startup, so an encoder that already
stopped can still save its bytes.

There are two capture devices, and each mounted product has exactly one, chosen at construction; neither falls back to the other.

- The microphone device (`src/lib/microphone.ts`) records with the recorder
  the platform adapter supplies, over that adapter's inputs: the browser
  adapter imports `@epicenter/recorder/browser`; shared code names only the
  bare contract. In a browser tab (`src/lib/webview-microphone.ts`)
  `MediaRecorder` holds the audio and the page writes `<path>.webm` (or the
  browser's container) on stop.
- The fixture device (`src/lib/capture.ts`) writes fixed bytes on stop, under
  the fixture's own extension, and marks the row `fixture`.

When Whispering starts it calls `recoverRecordings`, which a browser answers
with nothing to repair.

### The microphone

The microphone device also has `inputs`: listing, asking for access, and a
level reading. The fixture device has none, so in fixture mode nothing lists,
asks for, or opens a microphone.

- In a browser, a chosen microphone is asked for as `{ deviceId: { exact } }`.
  A WebView that cannot open exactly that one answers with a refusal
  (`InputUnavailable`), and a stream that reports another device is released
  and refused. Listing is `enumerateDevices` and nothing else. It never asks
  for access, so before access is allowed it names no input. `allow` is the
  separate action: it opens the default microphone and releases it at once.
- The system default is asked for only when nothing is chosen.
- Every request takes an `AbortSignal`. A stream that arrives after its
  request was withdrawn is released there, so a late answer leaves nothing
  open.

`src/lib/microphone-input.svelte.ts` is the app's state over that, a field
of Whispering (`whispering.input`): the choice, the listing, and the one request
that may open a microphone outside a recording. Enabling and a test share that
one owner: at most one is under way, and `release` aborts it and stops its
meter and polling timer. The enabling/opening/running state owns those
resources together. An ending received before the meter's open reply is replayed to
its subscriber; releasing that test also retires its timer. The popover's close, leaving Home, a new choice, `startRecording`, and
closing Whispering all call it, so nothing they leave behind holds a stream.
The recorder and that request never hold a microphone together.
`startRecording` releases before it asks for its own microphone and passes the
choice it read at that moment; the choice, a test, and `allow` are refused
while a recording is starting, running, or finishing. A recording closed while
its microphone is opening aborts that request: the browser releases the
microphone when it answers. Closing Whispering releases a test's microphone
at once, waits for no save of the choice, and stops listening for
`devicechange`, by which a browser announces connected inputs.

Nothing here runs at launch. The app reads the saved choice through
`services.preferences` and opens nothing; the first listing is when the
person opens the control.

The choice's identity is its device ID and nothing else. A name does not
identify a microphone: another one of the same model has the same name. So a
saved ID that is not listed is never matched to a listed input by name. The
choice stays as it is, the control shows it as not listed, and it changes only
when the person chooses again. A listing can be limited by permission, so
absence from it proves nothing about the microphone: a recording still asks
for exactly that ID, and refuses only if it cannot be opened. A WebView may
give the same microphone another ID in a new origin.

## Transformations

`src/lib/transformation.ts` is the request: `POST <base>/chat/completions` with
the model, the prompt as the system message, and the input as the user
message, reading `choices[0].message.content`. It is plain `fetch` with
`redirect: 'error'` and `credentials: 'omit'`, like the transcription
request, and it refuses a base URL
that is not plain HTTP(S) before sending. `transformOverConnection` is the one
entry: it reads the text connection once, refuses a request prepared
for another base URL, and sends with that connection's key. An error never
carries the key: an endpoint that echoes it has it removed.

`src/lib/recipe.ts` decides whether a recipe runs and with what, from the
recipe as read (a listed row, or its text as typed in Source) and the text connection
as last read: the file must read without issues and have instructions; a text
connection must be set up; the model is the recipe's if it names one, else the
connection's. Whispering
exposes it as `whispering.resolve`, and the Run check, the post-processing
choice, a transcript's Transform menu, the recipe's page, and both run entry
points call it, so they cannot disagree.

`whispering.transform(transcript, recipe, shown?)` sends what the person sees:
`shown.recipe` is the recipe as TransformationDetail's fields show it
(`{ fields: { title, model }, body }` from its edits), and `shown.input` the
transcript text TranscriptCard shows. Whatever is not shown is read from its
row in the mirror; in Source, Run sends the mirror's row, so it is blocked
while that row has issues. Invalid or empty input and a missing related
recording refuse the request. Preparation writes neither input.
`whispering.transformText` takes a recipe, as shown or as its row, and pasted
text without a recording. The result records the exact prompt and input
before its backend request.

Both fix a run before anything is sent: the result's stem, and every field the
result row will hold, including the instructions, input, model, and the text
connection's base URL. A transcription fixes its row the same way: the
recording, the time, the model, and the transcription connection's base URL.
Every run then follows one lifecycle (ADR-0542, `src/lib/runs.svelte.ts`):

1. Its recording is checked to still be in the folder, then its result row is
   created with those fields and an empty body
   (`folder.tables.<table>.create(id, { fields, body: '' })`) before the
   request goes out. A row that cannot be created refuses, and nothing is sent.
2. The request goes out. While it is out the row shows as running.
3. The answer is set as the row's body with `update(id, { body })`, over the
   file as it is when the save runs. A row deleted meanwhile answers
   `NothingToUpdate`, which counts as left absent: nothing is written. A
   write that fails keeps the answer in this window, with why, until the
   person presses **Save again** (one more `update`) or copies it; nothing
   writes it again on its own and nothing sends the request again.

Nothing that says what is happening is written. What a row shows is derived
from its body and this window's live state:

| The row | What it shows |
| --- | --- |
| Has a body | The answer. An empty answer is written as one newline, so only a row nothing was written to has an empty body. |
| No body, request out | Running. |
| No body, request failed (refused, unreachable, answered wrongly, the transport threw, or the connection moved) | Why, with Run again and Delete. |
| No body, answer received and its write failed | "Answer not written" with why, the text, Save again, and Copy. The header counts these. |
| No body, nothing in this window | Unfinished: the window that sent it closed first. Run again and Delete. |

Run again (`whispering.runAgain`) reads the row now and sends the request its
fields record, into the same row, only while the connection is still the base
URL the row names; for a transcript, the audio is the one its recording names
now. It never reads the transcript a result came from: the row records the
text that was sent. Delete is the ordinary deletion of the row's file, and is
the only discard. Two asks for one transcript and recipe at once, two runs on
pasted text with one recipe at once, or two Run agains of one row at once,
send one request.

A transformation only ever creates rows in `transformation_runs/` and
`text_runs/`. No code path writes a transcription row from a transformation.
A file in `text_runs/` that does not read is listed apart.

Deleting a recording (`src/lib/deletion.ts`) deletes its row, its
transcripts, and the results made from them, each as it is when the deletion
runs, and keeps its audio: an ordinary file the table
does not own, which Files can delete. What goes is read from the mirror when
the person is asked, and read from it again when the deletion runs; a result
file that does not read refuses the deletion, since it might be this
recording's. It must not race
the work that writes those rows. `deletionFor` and `delete`
both refuse while a transcription or transformation of that recording is
running or one of its rows is being written, and `delete` also refuses when
a result was written after the person was asked. While `delete` runs, no request
starts for that recording. A failed run holds nothing; it is dropped with the
recording. Results on pasted text name no recording, so they are neither
deleted with one nor in the way of deleting one, readable or not.

The confirmation reads current row metadata and result membership from the
mirror. A malformed recording or transformation is deleted alone, so its
results remain. Each `folder.delete(path)` waits in the folder's queue behind
the writes asked for before it. A partial cascade failure reports the result
files that could not be removed.

## Editing through edits

The mirror shows only what landed, so an input bound straight to it would
lose keystrokes typed while a save is out. Every text input bound to folder
data therefore uses an edit (`edit(source, save)` from
`@epicenter/svelte/folder`): it shows what was typed until that text's
save succeeds, then follows `source` again, which by then is the landed text.
A failed save keeps the typed value and exposes its error. Typing again or
**Save again** retries; **Discard** follows the disk. Each keystroke enters the
folder queue immediately. Leaving an editor discards a failed edit; it sends
nothing on teardown. Folder-backed checkboxes, selects, and action buttons
write directly.

```ts
const row = $derived(folder.tables.recordings.row(id));
const title = edit(
	() => (row?.issues === null ? row.fields.title : ''),
	(title) => folder.tables.recordings.update(id, { fields: { title } }),
);
const source = fileEdit(folder, path);
```

- **One edit per editor component.** RecordingDetail has title, notes, and
  source edits; TransformationDetail title, model (empty saves `null`),
  instructions, and source; TranscriptCard and FileView a transcript body;
  FileView a text file's source. An edit is never shared between components.
  Switching between Source and fields changes the view immediately. The new
  view follows the mirror as earlier queued edits land and may briefly show
  older text. A whole-file edit made during that interval replaces the file
  at its turn, so an earlier field change survives only if the editor includes it.
- **Source** uses `fileEdit` to show LF and save with the file's own newlines. Whether a
  row shows as text is `showsText(path)`: the person chose Source
  (`asText`, a `SvelteSet` of view state), or the row has issues. Repair
  reads the typed Source text with `readRow(source.value, schema)`, so the
  issue list, the Details tab, and `useForm`'s refusal follow what is typed,
  before it saves.
- **A value the schema does not accept** is saved as written, and the row is
  listed for repair. An `update` writes canonical frontmatter; text typed
  into a body saves with LF line endings (ADR-0572).
- **A recording's initial row create** stays on its active capture. Stop
  awaits that create before setting its length, even if another capture has
  since started, and a `NothingToUpdate` answer (the row was deleted) is
  ignored.
- **Just-finished audio**: while a recording is captured or stopping, and
  after Stop until the listing has an audio sibling for its stem, its audio
  is the path the capture wrote (a `Map` of just-finished recordings, cleared
  inside `audioOf`), so it is never reported absent while the folder catches
  up. Stop calls `folder.refresh()` and clears the entry if no sibling is listed.
- **Playback** reads audio bytes with `folder.read(path)` each time the
  file's `FolderFile` changes, and owns the object URL it made until the next
  read or unmount.
- **FileView** shows a file by its `FolderFile`: string data is editable text;
  `Uint8Array` data is not UTF-8 and is not opened; `undefined` data with no
  read error is a file the mirror does not keep (audio plays, others show
  their kind); a read error shows its message with Try again
  (`refresh()`); no file says it is no longer in the folder and keeps a failed
  edit's inline recovery controls. A read error alongside known text leaves
  that text editable.

Whispering retains view selection, connection forms, pasted text, capture
state, and answers whose files are not written; it holds no typed text.
Rename uses `folder.move(from, to)`: its turn follows edits already queued,
reads the source at that turn, creates the destination only if absent, then
removes the source. If removal fails, both paths remain and the error names
them. A successful move carries the selection to the new path. An outside
deletion keeps the missing path selected until the person leaves it; a
successful in-app deletion clears selection. Recording and transformation
files keep their names. When
`whispering.closing` becomes true, Whispering refuses new app work and late
answers. Disposal returns immediately; OpenFolder's close then sends what
waits before releasing storage.

## Closing

Unsubmitted settings and pasted text do not hold the page.
Recorded audio and started requests have their own lifetimes:

- A recording is in the folder from its start
  ([ADR-0543](../../docs/adr/0543-a-recording-streams-into-its-folder-from-the-moment-it-starts.md)):
  its row is written at start, and only Stop writes its audio and length.
- A transcription or recipe run writes its result row before the request goes
  out. An answer that has not arrived when the app quits is lost, and the row
  stays unfinished, to run again.
- File edits save after a short pause in typing. The editor keeps a failed
  value with Save again,
  Discard, and Copy.

In a browser tab, the page warns only while a write is out. Recording adds no warning. Browser audio stays in the page
until Stop saves it, so reloading or closing the tab loses an unfinished take.

## Saving and status

Whispering keeps no versions and does not sync its folder: Save version,
Connect, and Sync were removed with the move to the local folder.
`src/lib/status.ts` words the header's one line with
`headerStatus({ saving: folder.saving, unwrittenAnswers })`: answers whose file
could not be written, then "Saving…" while a write waits or is being saved,
and otherwise the neutral "On this device". Every typed edit is queued at
once. A command awaiting `Saved`
shows its own failure once; a failed edit offers Save again, Discard,
and Copy. There is no per-file save line.

## Noticing outside changes

The mirror looks at storage again when OpenFolder sees focus, a visibility
change, coming online, or page hide, and at once when another browser tab
names a changed path. A listing compares each file's change token (its
content in a browser) and rereads
the text files that changed. Saves and closing never wait for it.

## Debug builds

A development browser build opened with `?fixture=tone` records a generated
tone instead of the microphone (`src/lib/capture.ts`); a production build
never does.

No build offers failure injection. Tests open a real directory with
`@epicenter/folder/bun`, or a folder over memory with
`@epicenter/folder/testing` whose host a test can hold (`putGate`), make
refuse a save (`failPut`, `beforePut`), or change behind the folder
(`outside`), so the folder itself answers as it would on a real disk
(`src/lib/services.test-support.ts`).

## Where things are

| Path | Role |
| --- | --- |
| `src/lib/definition.ts` | The tables, each row's schema, and row paths. |
| `src/lib/platform/` | The service contract and its browser implementation. |
| `src/lib/whispering.svelte.ts` | One mounted app owner: startup, capture and inference workflows, lists, selections, settings drafts, file actions, and synchronous disposal. |
| `src/lib/folder.ts` | `WhisperingFolder` (`SvelteFolder<WhisperingTables>`) and its context, provided by WhisperingApp. |
| `src/lib/settings-draft.svelte.ts` | The one draft of the two connections, shown by the header's Settings and (transcription only) by the control on Home. |
| `src/lib/connections.ts` | The connection rules both storages apply: canonical base URLs, key keep/replace/remove. Pure; stores nothing. |
| `src/lib/recipe.ts` | The one decision about whether a recipe runs and with what. |
| `src/lib/post-processing.ts` | The post-processing choice type and how a transformation is named. The app reads the current choice (`whispering.postProcessing`). It runs nothing. |
| `src/lib/runs.svelte.ts` | Transcription and recipe runs: the result row written when each starts, its answer written into it, and what each row shows. |
| `src/lib/deletion.ts` | What a deletion deletes, read fresh for the person to confirm, and running it. |
| `src/lib/capture.ts`, `microphone.ts`, `webview-microphone.ts`, `audio-format.ts`, `transcription.ts`, `transformation.ts` | The capture contract and fixture device, the real microphone over `@epicenter/recorder` and the browser's inputs, extension-to-MIME mapping and WAV length, the transcription and transformation requests. |
| `src/lib/microphone-input.svelte.ts` | The chosen microphone and the test of it, for one mounted app. |
| `src/lib/microphone-preference.ts` | The device's saved microphone choice. |
| `src/lib/status.ts`, `files.ts` | The header's status line; file messages, the listing, and reading a file's bytes. |
| `src/routes/` | The layout that mounts OpenFolder, the product root, and the three pages. |
| `src/routes/components/` | The shell, navigation, header, recorder, recording and transformation lists and details, file browser and view. |
| `src/lib/assets/` | The microphone mark from the earlier Whispering. |
