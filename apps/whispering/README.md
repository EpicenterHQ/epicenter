<h1 align="center">Whispering</h1>
<p align="center">Record → transcribe → transform → keep it all as files.</p>

Whispering is an app for voice notes. It records audio,
transcribes it with an OpenAI-compatible endpoint you choose, turns a transcript
into another text with prompts you write, and keeps every recording, transcript,
prompt, result, and setting as an ordinary file in one Git-versioned folder. It
needs no account and no hosted API. On the desktop it is an app you install in
Epicenter
([ADR-0493](../../docs/adr/0493-whisperings-only-desktop-shell-is-epicenter.md),
[ADR-0552](../../docs/adr/0552-every-app-is-installed-from-a-folder-in-any-git-repository.md));
in a browser tab it keeps its folder in the browser's storage.

This is a development milestone, not a release. Its voice-note workflow is launch, record,
stop, save, play, transcribe, transform, inspect files and history, quit, reopen.
The installed app has not been run in Epicenter by hand: recording into the
folder through Epicenter's recorder, and transcription through Epicenter, are
covered by tests, not yet by a desktop run. Dictating into other apps is not part
of it. [What is not supported](#what-is-not-supported) lists the rest.

## The data folder

```text
~/Epicenter/so.epicenter.whispering/
├── kv.json                          transcription endpoint and model an earlier version saved; read, never written
├── recordings/
│   ├── <recording-id>.md            title, time, length, and audioPath in frontmatter; notes in the body
│   └── <recording-id>.<extension>   the audio that row names, with the extension its bytes call for
├── transcriptions/
│   └── <result-id>.md               names its recording in frontmatter; transcript in the body
├── transformations/
│   └── <transformation-id>.md       title (and an optional model) in frontmatter; the instructions in the body
├── transformation_runs/
│   └── <run-id>.md                  a result on a transcript: what it was made from and with; the result in the body
├── text_runs/
│   └── <run-id>.md                  a result on pasted text you saved: what was sent and with what; the result in the body
└── .git/                            ordinary Git: Markdown, kv.json, and audio bytes
```

Opening the folder creates Git metadata. Where requests go is set up per
device in Settings and is never in the folder; until you set it up, nothing
is sent and nothing is saved. Recording, transcript, transformation, and
result files are created by explicit actions. A folder has no
`transformations/` until you create a transformation, and no `text_runs/`
until you save a result on pasted text.

These files are the data. The app and any other program edit the same paths;
there is no export step and no second copy. In Epicenter the folder is
`<folder root>/so.epicenter.whispering`; set `EPICENTER_FOLDER_DIR` when
starting Epicenter to use another root, such as a disposable one for a test.

A recording's ID is its file stem, set when the recording starts
(`20260102-030405-k3f9`). Its title is a field, so renaming a recording changes
frontmatter and never moves a file. Audio is committed as real bytes. There is no
LFS pointer and no LFS service.

A recording's file names its audio in `audioPath`, such as
`audioPath: recordings/20260102-030405-k3f9.wav`. That line is the only link
between the two files:

- The app plays, transcribes, and lists only the file `audioPath` names. A file
  that merely has the same name with another extension is an ordinary file and
  is not treated as the recording's audio.
- A recording file with no `audioPath` does not read as a recording. It is
  listed under "Needs repair" and has no audio to play or transcribe. This
  includes any recording file written before the field existed. The app does
  not fill the path in for you: add the line in its text, or with any editor.
- The audio file cannot be renamed from the app while a recording names it,
  since nothing would update the recording.

## Run it

From the repository root, with Bun, and `git` on `PATH`.

```sh
# The page alone in a browser tab, over a folder kept in the browser's OPFS
bun dev:whispering

# Epicenter, the desktop app Whispering installs into (needs Rust)
bun dev:epicenter
```

On the desktop, Whispering is an installed app (ADR-0552). In Epicenter's
Folders window, choose "Install from a repository…", enter this repository's
URL or local path, choose Whispering (`apps/whispering`) from the apps it
lists, and approve the build. Epicenter clones the
repository, runs `bun install` at its root and `bun run build:installed` here,
and serves `dist/` at `/apps/so.epicenter.whispering/`. Opening Whispering
from the Apps list opens its own folder, `so.epicenter.whispering`, under
Epicenter's folder root. "Open in Whispering" beside another folder opens that
folder through Whispering's definition as a lens, never rewriting its
`epicenter.json`, and refuses one that lacks Whispering's tables, naming the
folder. To try a change, commit it in the installed clone,
`~/Epicenter/Apps/so.epicenter.whispering/`, and open the app again; a commit
made there builds without asking.

Inside Epicenter the shell grants the window its folder and holds the
folder's lock. The page is the UI, and it opens the folder itself: it reads
the files, saves them, and records history, and every save and every `git`
command goes through the shell, which keeps them inside the folder and out of
Git's private files. The shell's recorder writes a recording into the folder
as it captures. Requests to an endpoint go through the `epicenter` CLI,
which adds the connection's key.

Checks, from `apps/whispering`:

```sh
bun run typecheck                 # the page
bun run test                      # workspace and workflow tests, then the mounted row views
bun run build                     # the browser build, into build/
bun run build:installed           # Epicenter's build, into dist/
```

`epicenter.app.json` names the app (`so.epicenter.whispering`) and its title
(ADR-0560). Epicenter's own checks cover what
it grants Whispering: `cargo test --manifest-path apps/epicenter/src-tauri/Cargo.toml`.

## Using it

Whispering has three pages. The sidebar switches between them on a wide window
(click the microphone, or press Ctrl+B or Command-B, to expand it), and a bar
at the bottom does on a narrow one. Each page has its own address, so back,
forward, and refresh work.

| Page | Address | What it is for |
| --- | --- | --- |
| Home | `/` | The recorder, and the newest recording with its transcript. |
| Recordings | `/recordings` | Search, sort, and select recordings; open playback and transcript editing beside the table. |
| Transformations | `/transformations` | The instructions you apply to transcripts or pasted text, and the results they produced. |

Changing pages keeps everything in progress: a recording keeps recording, a
request keeps running, and what you typed is already in its file. One folder is opened when the app
starts and it stays open until the app closes.

The header is the same on every page: the status line, a recorder control,
Settings, and Files.

| Control | What it does |
| --- | --- |
| Start recording / Stop recording (Space) | On Home. Writes the recording's row to `recordings/` when it starts and its audio beside it, then its length when it stops. Space also starts and stops it on Home when focus is on the page or microphone. Fields, other controls, and open popovers keep their own keyboard behavior. On other pages the header has a microphone button to start, and while a recording runs it shows the elapsed time and Stop. |
| Microphone input | On Home, under the recorder. Chooses the microphone the next recording uses: System default, or one by name. See [Under the recorder](#under-the-recorder). |
| Transcription model | On Home, under the recorder. Shows the transcription connection in use and opens its part of Settings. |
| Post-processing | On Home, under the recorder. Chooses one of your transformations, or None. Choosing sends nothing; **Run** on the latest transcript does. |
| Transcribe | Writes a row in `transcriptions/`, sends the saved audio over the transcription connection in Settings, and writes the answer into that row. Nothing is transcribed until you press it. |
| A recording | Opens an optional detail pane for playback, title, transcript editing, Copy, Transform, and notes. Close restores the full table. Narrow windows show the detail with Back. Source edits the recording's Markdown. |
| Search recordings | Matches the title, notes, ID, and every transcript. Excerpts show the matching passage. Recording files that need repair are listed apart, under the table, and never searched out. |
| Sort | Click Recording, Recorded, Length, or Status to sort; click again to reverse. |
| Select recordings | Check individual rows or every row shown. Search keeps hidden selections; bulk actions use only selected rows shown. |
| Transcribe selected | Sends recordings shown with no transcript, one at a time. Existing transcripts, finished or not, missing audio, and running requests are skipped. Closing stops queued requests. |
| Copy transcripts | Copies the newest transcript of each selected row shown, in table order, with titles when copying several. |
| Delete selected | Captures the selected rows shown and their results before confirmation. Audio stays in the folder. |
| Transform | On a transcript. Applies one of your transformations and saves the answer as a new file under the transcript. |
| Status | Saved files, changes since the last version, the last version saved, and the folder path as separate lines, with Save version. |
| Save version | In the status details. Records the saved files as a version in the folder's Git history. Nothing else records one. |
| Settings | The two connections, transcription and text: each an endpoint, a default model, and an optional key, kept on this device and outside history. See [Connections](#connections). |
| Files (Ctrl+Shift+E) | The folder's files, beside any page. A recording row opens on Recordings and a transformation on Transformations; an audio file opens a player and other text a plain editor, both on Recordings. |

### Working with recordings

The table starts at full width. Activate a recording to open its detail pane,
then close the pane to return that space to the collection. Search, sorting,
and selection stay when you change pages or hide details.

Edit transcript text beside playback. Each change is written to the
transcript's file as you type; opening the file from Files shows the same
text. Copy uses the text shown; Transform first waits for what is being
written and reads the saved transcript.
Dates, file paths, capture information, endpoint, and history are under
**File details**.

The collection workflows are covered by synthetic-history tests. Visual
acceptance and manually editing while listening remain pending because the
current browser preview could not be accessed for inspection.

### Under the recorder

Three small controls sit at the microphone's lower right on Home, or under it
on a narrow window. Each opens its own popover.

**Microphone input.** System default, or one microphone by name.

- Opening the popover lists the inputs. It never asks for microphone access.
  In Epicenter every input is listed by name, and Epicenter asks macOS for
  microphone access the first time you test or record. If access was denied,
  **Open Microphone Settings** takes you to the place in System Settings to
  allow it; with no microphone connected, the popover says so. In a browser, inputs
  are not listed by name until access is allowed; **Enable microphones** asks
  for it, which opens the system default microphone for a moment and records
  nothing.
- A microphone you choose is the only one a recording will use. If it is not
  connected, the recording does not start and says so. No other microphone is
  used in its place; connect it or choose another input.
- The choice applies to the next recording. A recording that is starting,
  running, or finishing keeps the microphone it opened, and the choice cannot
  be changed until it ends.
- **Test microphone** opens the chosen input and shows its level. Nothing is
  recorded, sent, or saved. The test, and a pending Enable microphones, end
  when you close the popover, leave Home, start a recording, or close the app.
  Only one of the two runs at a time, and never beside a recording. A test
  whose microphone is unplugged or loses access ends and says why.
- The choice is kept on this device and is never written to `kv.json`. It is
  in the page's `localStorage`, in Epicenter and in a browser tab; Epicenter
  serves every app from one fixed address, so the choice lasts between
  launches.
- A microphone is identified by the ID the app is given for it, never by its
  name: two microphones can share a name. If the saved ID is not among the
  listed inputs, the choice is shown as "not listed" and nothing is chosen
  for you. Not being listed does not prove the microphone is gone, since the
  list can be limited by permission, so a recording still asks for exactly
  that ID. In Epicenter the ID is the one macOS keeps for the device, so it
  lasts across launches and reconnections. If it cannot be opened, the
  recording does not start and no other microphone is used. Choose the input
  again, or System default, to change it.
- With fixture audio there is no real input: the popover says so, and no
  microphone is listed, asked for, or opened.

**Transcription model.** The transcription connection that **Transcribe**
uses. It is the transcription part of Settings, with the same draft, so typing
in one shows in the other. The model is a name you type: the app keeps no list
of models and never asks an endpoint what it serves.

**Post-processing.** None, or one of the transformations in the folder. It
starts as None each time the app opens, and the choice stays while you move
between pages. Nothing is created for you: with no transformations the list is
empty and links to the Transformations page.

- Choosing only chooses. Recording, stopping, and transcribing never run it.
- When the latest recording has a transcript, **Run** sends that transcript to
  the chosen transformation, exactly as Transform does on Recordings. The
  result is a new file in `transformation_runs/`; the transcript and its Copy
  button are unchanged.
- A choice that was deleted, or that cannot run now (it needs repair, or no
  text connection is set up), is shown as that, with why, and does not run.

### Transformations

A transformation is a title and instructions you reuse: clean up dictation,
summarize, draft an email. It is one Markdown file in `transformations/` with
the title in its frontmatter and the instructions as its body. Where it is
sent is the text connection in Settings, never the file.

- **New** creates one. It offers three starters (Clean up, Summarize, Draft an
  email) and an empty one. Nothing is created until you choose; the app never
  adds files on its own. A new transformation is written with `model: null`
  and `endpoint: null`: it uses the text connection and its model.
- A transformation's page has three tabs. **Instructions** opens first and
  edits the title and instructions; **Model and connection** below them holds
  the optional model and where requests go. **Try it** runs it (below).
  **Source** edits the file's exact text. A file that does not read as a
  transformation opens in Source with its issues, and Instructions opens once
  the text reads. Typing in either saves as you type. A save from Instructions
  keeps fields the app does not know and writes the frontmatter as plain YAML;
  Source keeps the text exactly.
- A model typed in a transformation is used instead of the text connection's;
  leave it empty to use the connection's. Whispering keeps no list of
  providers or models.
- A transformation an earlier version wrote names an endpoint. That file still
  reads and runs, but its endpoint is only a condition: it runs while the text
  connection is exactly that base URL, and otherwise says so and sends
  nothing. Its page says so at the top of Instructions, and in Try it when the
  endpoint is what stops it; **Remove the endpoint and use the text
  connection** sets it to `null`. The app never rewrites these files on its
  own.
- Run one from a transcript's **Transform** menu on Recordings, or from Try it
  on the transformation's page, on a chosen transcript or on pasted text
  (below). When it cannot run, Try it says why and offers the fix it can:
  the text connection's settings or Instructions.
  The Run button, the post-processing choice, the Transform menu, and the run
  itself all make the same decision about whether it can run and with what.

Running sends one request: `POST <text connection>/chat/completions` with the
model, the instructions as the system message, and the transcript or pasted
text as the user message. A run on a transcript writes a new file in
`transformation_runs/` before the request goes out, and the answer into it
when it arrives. The transcript's own file is never written, so the original
text is always there.

Each result file records what it came from, when, the model and endpoint, and
the exact instructions and text that were sent. A result therefore still reads
correctly after you edit or delete its transformation. Deleting a
transformation keeps its results. Nothing here claims an endpoint answers the
same way twice.

**Pasted text.** Try it has **A transcript** and **Pasted text**. Paste any
text and press **Run on pasted text**; no recording is needed. The pasted text
stays while you move between pages and transformations, and is written only
into the result of a run on it.

- Running waits for edits being written to land first, then fixes the run
  before anything is sent: its file name and the exact instructions, text,
  model, and endpoint. Editing the text, the transformation, or Settings
  afterward changes nothing about that run.
- The run is saved as it starts, in `text_runs/`, and its answer is written
  into that file when it arrives. There is no separate Save; **Delete** on a
  result discards it.
- While a transformation runs on pasted text, Run on pasted text sends
  nothing more for it. Each later run is its own result.
- Results on pasted text are listed with the transformation's results as
  "Pasted text", and open, copy, and delete like any other result. They name
  no recording, so they are never deleted with one, and a file in
  `text_runs/` that does not read never stops a recording from being deleted.
Deleting a recording deletes its file, its transcripts, and the results made
from them. Its audio file is kept, and the confirmation says so; delete it
from Files when you no longer want it. A recording cannot be deleted while a
transcription or transformation of it is running: wait for it to finish
first.

What is sent is always what the folder holds when you press the button. If the
transcript's file was edited in Files, the terminal, or another program, the
edited text is sent; if it or its recording is gone, or the file cannot be
read, nothing is sent and the app says why.

A transcript or result with no answer in its file says why where it is
shown: its request is running, its request failed, or it is unfinished
because the window that sent it closed before the answer was written. Nothing
in the file says which; the window knows what it is doing, and a file with no
answer and nothing running is unfinished. **Run again** sends the same
request, from what the file records, and writes the answer into the same
file, only while the connection is still the endpoint the file names. If you
changed the connection since, it is not sent: delete it and run anew.
**Delete** discards it.

### Connections

Settings has two connections, **Transcription** and **Text**. Each is a base
URL, the model used when a request names none, and an optional API key. They
are never in Whispering's folder. In Epicenter each is a row of Epicenter's
own folder `so.epicenter` ("Whispering transcription" and "Whispering
text"), which other apps in Epicenter can use too. The row holds the model
and syncs with that folder; the base URL and key stay in this computer's
keychain. A connection synced from another computer is not set up on this
one until you save its base URL, and key, here. In a browser tab they are in
this site's `localStorage`. Nothing about them is in `kv.json` or
history.

- Nothing is sent until a connection is saved. A keyless local endpoint is
  set up the same way, with no key.
- A request goes only to its connection's base URL, with that connection's
  key. No file in the folder, and nothing the window sends, chooses the URL. A
  request names the base URL it was prepared for, and is refused, with nothing
  sent, if the connection no longer is that URL. One already sent keeps the
  connection it started with.
- The transcription key is never sent to the text endpoint, and the text key
  never to the transcription endpoint.
- A saved key is kept only for the endpoint it was saved for. Change the
  endpoint and Save asks you to enter the new endpoint's key or remove the
  key; **Keep the saved key** is offered only while the endpoint is unchanged.
- A redirect from an endpoint is refused, not followed, so a key is never
  carried to another URL. Base URLs are `http` or `https` with no user name,
  password, query, or fragment.
- The window is told only each connection's endpoint, model, and whether it
  has a key. In Epicenter the key never reaches the window, a folder, or
  history: the `epicenter` CLI adds it to the request, and the endpoint needs
  no CORS headers.
- In a browser tab (`bun dev:whispering`) the tab sends requests itself, so
  the endpoint must allow the page's origin (CORS). Most hosted providers
  refuse that; a local endpoint or Epicenter works. The key is saved in this
  browser, where code running on the site can read it, and the key form says
  so. Errors that echo the key have it removed.

**From an earlier version.** An earlier version kept one key for every
endpoint, and the endpoint and model in `kv.json`. In a browser tab, that key
stays where it was and is sent nowhere. Settings shows it as "A key saved by an earlier version";
tick the connections it may go to, each at the endpoint its form shows, and
press **Use the earlier key there**. It moves into those connections and is
removed from where it was; it is never shown. Epicenter holds no such key.
The `kv.json` endpoint and model fill in the transcription form until you save
it; this version never writes `kv.json`.

One failure is different. If Epicenter stops answering partway, the window cannot tell whether the request reached the endpoint: it
may have been sent, and even answered, with the reply lost on the way back. The
notice says the outcome is not known, not that nothing was sent. Whispering
never sends it again on its own; **Try again** is one more request, and with a
paid endpoint possibly one more charge. This applies to transcription too.

### Saved is not a version

A save writes files. A version records them in the folder's Git history. They
are separate outcomes and the status reports them separately.

- Every change is saved as you make it, and no save records a version.
- **Save version**, in the status details, records one: it waits for what is
  being written, then commits the saved files. It is the only thing in the
  app that does. `git commit` in the folder works too.
- A version is recorded as the person Git's configuration names: `user.name`
  and `user.email` from the folder's repository or your global Git settings.
  Only when neither is set is it recorded as `Whispering <whispering@localhost>`.
- The status says "Saved" once your changes are in files. How many files
  changed since the last version is shown as a detail, not as a warning.
- A commit that fails or is blocked never undoes a save and never reports the
  save as failed. The status says what happened to it, and **Save version**
  tries again.
- Quitting records no version. Whatever changed since the last version stays
  that way until the next one.
- Terminal commands and other programs edit the files directly. Their changes
  enter the next version you save.
- The folder reports what changes in it: on the desktop the shell watches the
  data folder, so a change another program or the terminal makes appears
  within a moment; in a browser tab, another tab's writes are reported the
  same way. A save over a file that changed since your edit started merges
  with the change (see [Editing](#editing)).

### Where a recording is while it runs

A recording is in the folder from the moment it starts. Its row is written
then, naming its audio in `audioPath`, with the time it started; its length
is written when it stops. Nothing in the row says whether it is still
recording: the window knows that, and only while it runs.

- In Epicenter the shell writes the audio as it is captured, to
  `recordings/<id>.wav`, and brings its header up to date about once a
  second. Stop finishes the file. Reloading or closing the window finishes it
  too. A quit, a crash, or power loss keeps the audio up to that moment; when
  the folder next opens, the app rewrites the header of any recording that
  was cut off so it plays to its end. Its row then has no length.
- In a browser tab the audio is held in the page and written on stop, as
  `recordings/<id>.webm` (or `.mp4` or `.ogg`, as the browser records).
  Reloading or closing the tab loses it, and the row stays without its audio.
- Cancel deletes both the row and the audio.

A recording that is still recording cannot be transcribed; stop it first.

### When a save does not finish

When an answer arrives but its file cannot be written, the window keeps the
answer and writes it again while it is open, waiting longer each time. The
status says how many answers are not written yet, and the result shows the
text with **Copy**. If the window closes first, the file stays without its
answer and shows as unfinished, to run again.

If a recording's row cannot be written when it starts, the recording still
runs and says so; its audio is saved without a row naming it, as an ordinary
file. If its length cannot be written when it stops, the recording keeps its
row and audio and says so.

### Closing and quitting

Closing the window and quitting are immediate. Nothing is asked and nothing
is waited for, because nothing that matters lives only in the window: a
recording is in the folder from the moment it starts, and a transcription or
transformation writes its file before its request goes out.

- In Epicenter a recording keeps its audio up to the moment the app
  closed, and the next time the folder opens its header is repaired so it
  plays to its end.
- A transcription or transformation whose answer had not arrived stays
  unfinished, to run again.
- A change typed in the last instant before quitting can be lost, as it can
  be in any app. Every earlier change is already in its file.

Force Quit, a crash, and power loss leave the folder the same way.

Moving between Home, Recordings, and Transformations never asks either. In a
browser tab (`bun dev:whispering:ui`) the browser's own leave warning appears
while a change is not in its file yet, and reloading or closing the tab loses
a recording in progress.

### Editing

Every change is written to its file as you type: a recording's title and
notes, a transcript, a transformation's fields, and any text file opened from
Files. There is no save button. An edit starts from the version of the file it
was typed over, and the window holds what you typed until it is in the file;
the table shows the row once it is saved.

- Each file is written one change at a time. Changes typed while one write
  runs are written next, so fast typing writes what you typed last.
- A save merges with a change made elsewhere since your edit started: fields
  and lines only one side changed are both kept. Where both changed the same
  field or the same lines, your edit wins and a notice names what of theirs it
  replaced, with **Restore theirs**. Reading the folder again never touches
  what you are typing.
- Text edited as a whole file (Source, or any text file from Files) merges the
  same way, by line (ADR-0551).
- A file deleted elsewhere stays deleted. A change to it is reported with
  **Copy what was lost**, and the recording, transcript, or transformation
  closes. Nothing creates it again.
- A save that fails for another reason, or whose reply never arrived, is
  reported and your edit is kept in the window; it is saved again with your
  next change, and before anything that reads the file, such as a run or a
  deletion. The status says an edit is not saved yet.
- A value that a file cannot hold, such as a field with the wrong kind of
  value, is refused and nothing in the file changes.
- Text typed or pasted into a field that a file cannot hold exactly (a lone
  surrogate) is saved with U+FFFD in its place.
- The lists are read when the page opens, after this window's own actions and
  terminal commands, and when the folder reports that files changed.

A recording, transcript, or transformation file whose text does not read as a
row is listed under "Needs repair" with why, and opens as its text with its
issues shown as you type. Its fields open once the text reads. A row starts
with a `---` line, its fields, and a closing `---` line; Markdown without
those lines, bad YAML, a repeated key, a missing field, or a field with the
wrong kind of value does not read. A transformation runs once its file reads
and it has instructions. Fields the app does not know are kept. Saving a row
from its fields writes the frontmatter as plain YAML; comments and the
earlier spelling are not kept, and the body is kept exactly. To keep a file's
exact text, edit it in Source.

Any file name works for a row, including a trailing space or `recordings/.md`.
Only `.md` in lowercase makes a file a row.

A deletion runs after the changes being written to that file, and the
confirmation says when the file has changes that are in no saved version.
Deleting a recording also deletes its results; its audio stays. It is refused
while any result file cannot say which recording it belongs to (text that does
not read, or a file that is not text). Repair or remove those from Files
first.

### Executable files

Avoid making files executable in the data folder. History records plain files
only, so while an executable file is present a commit is not made, the branch
does not move, and the status reads "Commit blocked" with the reason. Saving
is not affected: your files are still written, and the status says so on its
own line. Remove the executable bit (`chmod -x <file>`) and commit again.

## Fixture audio

For repeatable automation, a development build in a browser tab
(`bun dev:whispering`) opened with `?fixture=tone` answers every recording
with a generated tone instead of the microphone. Recordings made this way are
saved with `capture: fixture` and labelled on Home, in the list, and in
details. A production build ignores the parameter. Inside Epicenter, recording
always uses the microphone.

A fixture recording proves the save, playback, transcription, and history path.
It proves nothing about the microphone: with it, the microphone input control
says there is no real input and opens none.

To make commits fail while saves succeed, lock the branch by hand:

```sh
touch ~/Epicenter/so.epicenter.whispering/.git/refs/heads/main.lock   # commits now fail
rm ~/Epicenter/so.epicenter.whispering/.git/refs/heads/main.lock      # Save version works again
```

## Restoring from history

History is ordinary Git, so a recording can be recovered without the app:

```sh
git -C ~/Epicenter/so.epicenter.whispering log --oneline -- recordings/
git clone ~/Epicenter/so.epicenter.whispering /tmp/whispering-restore
afplay /tmp/whispering-restore/recordings/<recording-id>.wav
```

## Changed promises

This build writes each change to its file a second after you stop typing,
or when you leave the field, holding only what is not in the file yet; a
choice or a button writes at once. A field you change is set on the file as
it is now, so it never undoes another writer's other fields (ADR-0554).
These promises of the earlier build changed:

- A change made elsewhere merges on save without asking. The earlier build
  asked about parts you both changed; now your edit wins there, and what
  only they changed stays (ADR-0548).
- A file deleted elsewhere stays deleted, transcripts included. The earlier
  build could create one again from your edit.
- No save bar, **Try again**, or **Discard unsaved changes?**. A failed save
  is reported once and saved again with your next change. Closing and opening
  another item never ask about edits.
- No commit after a save. Each save used to try one commit; now a version is
  recorded only by **Save version**, which replaces **Commit now**. Changes
  since the last version are a neutral count in the status, not a warning.
- A row that does not read is repaired as text, and a lone surrogate is saved
  as U+FFFD, as before.
- The lists follow the folder's reports of what changed. Returning to the
  window reads nothing on its own.
- A version is recorded as you. The earlier build recorded every version as
  `Whispering <whispering@localhost>` and ignored Git's configuration; now
  `user.name` and `user.email` decide, with Whispering only as the fallback.

## What is not supported

These are absent, not hidden behind a setting:

- Accounts, sign-in, sync between devices, and any hosted transport. Recordings
  are local.
- Git remotes, push, and pull from the app. Use `git` in the folder.
- Git LFS.
- System-wide dictation: global shortcuts, push-to-talk, voice-activated
  recording, and delivering text to the cursor or clipboard automatically. Copy
  buttons are the only way text leaves the app. Space on Home works only while
  the app's window has focus.
- Automatic transcription or transformation after a recording. Each is a button
  you press, so nothing is sent to a paid endpoint on its own.
- Choosing transcription on this computer. Epicenter grants Whispering its
  local model, and the workspace can transcribe with it
  (`src/lib/workspace/local-transcription.ts`), but Settings has no way to
  choose it yet, so transcription needs an endpoint.
- A terminal and Reveal folder. The standalone desktop app ran them in its own
  host; Epicenter gives Whispering neither. Use a terminal or Finder on the
  folder.
- Transformations beyond one prompt and one request: chained steps, find and
  replace rules, tools, running code, importing the earlier Whispering's
  transformations or recipes, a provider or model catalog, and a connection or
  key per transformation. There are exactly two connections, transcription and
  text.
- A settings page. Settings is one form, shown in the header's popover and in
  the transcription control on Home.
- Importing audio files and recording overlays.
- Running post-processing on its own after a recording or a transcript. It is
  a button you press.
- Windows and Linux are untested.
- A desktop app of its own. Whispering's standalone Tauri shell is deleted
  (ADR-0493); on the desktop it runs only in Epicenter.
- Opening the desktop folder from a browser tab. The shell grants the folder
  to Whispering's window alone.
- Moving a recording's audio and having the recording follow. Nothing repairs
  `audioPath`, and nothing collects audio files that no recording names.
- Recordings saved by an earlier build of this app, whose files have no
  `audioPath`. They are listed as needing repair until the line is added.

The earlier Whispering stored recordings and transformations in a Yjs store.
Nothing reads that data. There is no migration. The pages, sidebar, and
recorder follow that app's layout; the code and the data underneath do not come
from it.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for how the pieces fit,
[recipes and connections](./docs/recipe-playground.md) for why requests are
routed by device connections and what that change costs an existing folder, and
[desktop verification](./docs/desktop-verification.md) for what was checked in
the standalone desktop app before it was deleted.
