<h1 align="center">Whispering</h1>
<p align="center">Record → transcribe → transform → keep it all as files.</p>

Whispering is a standalone desktop app for voice notes. It records audio,
transcribes it with an OpenAI-compatible endpoint you choose, turns a transcript
into another text with prompts you write, and keeps every recording, transcript,
prompt, result, and setting as an ordinary file in one Git-versioned folder. It
needs no account, no Epicenter desktop, and no hosted API.

This is a development milestone, not a release. Its voice-note workflow is launch, record,
stop, save, play, transcribe, transform, inspect files and history, quit, reopen.
Native verification results and remaining checks are recorded below. The
current build's desktop window has not been checked by hand: recording
publication as two separate saves is covered by tests, not yet by a desktop
run. Dictating into other apps is not part
of it. [What is not supported](#what-is-not-supported) lists the rest.

## The data folder

```text
~/Epicenter/local/so.epicenter.whispering/
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

These files are the data. The app, the embedded terminal, and any other program
edit the same paths; there is no export step and no second copy. Set
`WHISPERING_DATA_ROOT` to use another directory, such as a disposable one for a
test.

A recording's ID is its file stem, set when the recording ends
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

From the repository root. Rust and Bun are required, and `git` must be on `PATH`.

```sh
# The desktop app: builds the page and the host, then opens the window
bun dev:whispering

# The same app against a disposable folder
WHISPERING_DATA_ROOT=/tmp/whispering-demo bun dev:whispering

# A release bundle: apps/whispering/src-tauri/target/release/bundle
bun build:whispering

# The page alone in a browser tab, over a folder kept in the browser's OPFS
bun dev:whispering:ui
```

`bun dev:whispering` runs `tauri dev`. There is no hot reload: the page is built
once and served by Whispering's host process. Use `bun dev:whispering:ui` for a
fast UI loop.

The desktop app has three parts. The window's shell owns the data folder and
is the only thing that saves to it or records its history. A host process
serves the page, runs the terminal, and sends transcription and transformation
requests. The page is the UI. The host cannot be run on its own: only the
shell starts it, with the folder it chose.

Checks, from `apps/whispering`:

```sh
bun run --filter @epicenter/folder build:addon   # once: the Bun opener's file exchange (macOS, Linux)
bun run typecheck                 # the page, then the host
bun run test                      # host, workspace, publication, and workflow tests, then the mounted row views
bun run build                     # the page, into build/
bun run build:sidecar             # the compiled host, for the desktop bundle
cargo test --manifest-path src-tauri/Cargo.toml   # the shell: folder registration and window grant
```

### Environment

| Variable | Meaning |
| --- | --- |
| `WHISPERING_DATA_ROOT` | The data folder. Default `~/Epicenter/local/so.epicenter.whispering`. Created when absent. |
| `WHISPERING_TRANSCRIPTION_API_KEY` | Makes the transcription connection for this launch: this key (empty for none) at `WHISPERING_TRANSCRIPTION_BASE_URL` with `WHISPERING_TRANSCRIPTION_MODEL`. It replaces the saved transcription connection and cannot be changed from the app. It is never used for text. |
| `WHISPERING_TRANSCRIPTION_BASE_URL`, `WHISPERING_TRANSCRIPTION_MODEL` | With the key above, that connection's base URL and model (default `https://api.openai.com/v1` and `whisper-1`). Without it, only where the transcription form starts. |
| `WHISPERING_AUDIO_FIXTURE` | Debug builds only. A file whose bytes answer every recording. See [Fixture audio](#fixture-audio). |
| `WHISPERING_BUN` | Debug builds only. The Bun executable that runs the host, when `bun` is not on `PATH`. |

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
request keeps running, unsaved typing stays in its editor, and the terminal
keeps its output, history, and directory. One folder is opened when the app
starts and it stays open until the app closes.

The header is the same on every page: the status line, a recorder control,
Settings, Reveal folder, Files, and Terminal. Directly under it, also on every
page, is anything that is not saved yet.

| Control | What it does |
| --- | --- |
| Start recording / Stop recording (Space) | On Home. Records, then saves the audio and its row to `recordings/`. Space also starts and stops it on Home when focus is on the page or microphone. Fields, other controls, and open popovers keep their own keyboard behavior. On other pages the header has a microphone button to start, and while a recording runs it shows the elapsed time and Stop. |
| Microphone input | On Home, under the recorder. Chooses the microphone the next recording uses: System default, or one by name. See [Under the recorder](#under-the-recorder). |
| Transcription model | On Home, under the recorder. Shows the transcription connection in use and opens its part of Settings. |
| Post-processing | On Home, under the recorder. Chooses one of your transformations, or None. Choosing sends nothing; **Run** on the latest transcript does. |
| Transcribe | Sends the saved audio over the transcription connection in Settings and saves the answer as a row in `transcriptions/`. Nothing is transcribed until you press it. |
| A recording | Opens an optional detail pane for playback, title, transcript editing, Copy, Transform, and notes. Close restores the full table. Narrow windows show the detail with Back. Source edits the recording's Markdown. |
| Search recordings | Matches the title, notes, ID, and every transcript. Excerpts show the matching passage. Recording files that need repair are listed apart, under the table, and never searched out. |
| Sort | Click Recording, Recorded, Length, or Status to sort; click again to reverse. |
| Select recordings | Check individual rows or every row shown. Search keeps hidden selections; bulk actions use only selected rows shown. |
| Transcribe selected | Sends recordings shown with no transcript, one at a time. Existing transcripts, missing audio, and pending or unsaved requests are skipped. Closing stops queued requests. |
| Copy transcripts | Copies the newest transcript of each selected row shown, in table order, with titles when copying several. |
| Delete selected | Captures the selected rows shown and their results before confirmation. Audio stays in the folder. |
| Transform | On a transcript. Applies one of your transformations and saves the answer as a new file under the transcript. |
| Status | Saved files, uncommitted changes, the last commit attempt, and the folder path as separate lines, with Check again and Commit now. |
| Settings | The two connections, transcription and text: each an endpoint, a default model, and an optional key, kept on this device and outside history. See [Connections](#connections). |
| Reveal folder | Opens the data folder in Finder. |
| Files (Ctrl+Shift+E) | The folder's files, beside any page. A recording row opens on Recordings and a transformation on Transformations; an audio file opens a player and other text a plain editor, both on Recordings. |
| Terminal (Ctrl+\`) | Commands in the data folder, under any page. Its output, history, typed command, and directory stay when it is hidden. |

### Working with recordings

The table starts at full width. Activate a recording to open its detail pane,
then close the pane to return that space to the collection. Search, sorting,
selection, and typed drafts stay when you change pages or hide details.

Edit transcript text beside playback. Each transcript is its own draft beside
the recording, saved as you type; opening its file from Files shows the same
draft. Copy uses the text shown; Transform first waits for its saves and reads
the saved transcript.
Dates, file paths, capture information, endpoint, and history are under
**File details**.

The collection workflows are covered by synthetic-history tests. Visual
acceptance and manually editing while listening remain pending because the
current browser preview could not be accessed for inspection.

### Under the recorder

Three small controls sit at the microphone's lower right on Home, or under it
on a narrow window. Each opens its own popover.

**Microphone input.** System default, or one microphone by name.

- Opening the popover lists the inputs the app is already allowed to see. It
  never asks for microphone access. Until access is allowed, inputs are not
  listed by name; **Enable microphones** asks for it, which opens the system
  default microphone for a moment and records nothing.
- A microphone you choose is the only one a recording will use. If it is not
  connected, the recording does not start and says so. No other microphone is
  used in its place; connect it or choose another input.
- The choice applies to the next recording. A recording that is starting,
  running, or finishing keeps the microphone it opened, and the choice cannot
  be changed until it ends.
- **Test microphone** opens the chosen input and shows its level. Nothing is
  recorded, sent, or saved. The test, and a pending Enable microphones, end
  when you close the popover, leave Home, start a recording, or close the app.
  Only one of the two runs at a time, and never beside a recording.
- The choice is kept on this device and is never written to `kv.json`. In the
  desktop app it is in the same file as the connections, under the folder's
  `.git`; in a browser tab it is in `localStorage`.
- A microphone is identified by the ID the app is given for it, never by its
  name: two microphones can share a name. If the saved ID is not among the
  listed inputs, the choice is shown as "not listed" and nothing is chosen
  for you. Not being listed does not prove the microphone is gone, since the
  list can be limited by permission, so a recording still asks for exactly
  that ID. If it cannot be opened, the recording does not start and no other
  microphone is used. Choose the input again, or System default, to change
  it. The desktop app may be given new IDs on a later launch, so this
  can happen after a restart; that has not been checked on hardware.
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
text as the user message. An answer on a transcript is saved as a new file in
`transformation_runs/`. The transcript's own file is never written, so the
original text is always there.

Each result file records what it came from, when, the model and endpoint, and
the exact instructions and text that were sent. A result therefore still reads
correctly after you edit or delete its transformation. Deleting a
transformation keeps its results. Nothing here claims an endpoint answers the
same way twice.

**Pasted text.** Try it has **A transcript** and **Pasted text**. Paste any
text and press **Run on pasted text**; no recording is needed. The pasted text
stays while you move between pages and transformations, and is never written
anywhere.

- Running saves open edits to the transformation first, then fixes the run
  before anything is sent: its file name and the exact instructions, text,
  model, and endpoint. Editing the text, the transformation, or Settings
  afterward changes nothing about that run.
- The answer is shown beside the text that was sent, with **Copy**, **Save**,
  and **Discard**. It is held in the window, not saved, until you press
  **Save**, which writes it to `text_runs/`. A held answer keeps the app from
  closing without asking, and the notice under the header points to it from
  every page. Its **Open to save or discard** shows Try it, even when that
  transformation is already open on Instructions or Source. The Try it tab shows
  when a run is in progress, failed, or waiting to be saved. Reopening that
  transformation starts on Try it.
- One transformation holds one answer on pasted text at a time. While it runs,
  or while its answer waits, Run on pasted text sends nothing.
- Saved results on pasted text are listed with the transformation's results as
  "Pasted text", and open, copy, and delete like any other result. They name
  no recording, so they are never deleted with one, and a file in
  `text_runs/` that does not read never stops a recording from being deleted.
Deleting a recording deletes its file, its transcripts, and the results made
from them. Its audio file is kept, and the confirmation says so; delete it
from Files when you no longer want it. A recording cannot be deleted while a transcription or transformation of it is
running, or while an answer for it is waiting to be saved: finish it, save it
again, or discard it in the notice under the header first.

What is sent is always what the folder holds when you press the button. If the
transcript's file was edited in Files, the terminal, or another program, the
edited text is sent; if it or its recording is gone, or the file cannot be
read, nothing is sent and the app says why.

When a request fails, the notice under the header (for a transcript) or the
transformation's page (for pasted text) says why and offers **Try again**,
which sends the same request, under the same file name, only while the text
connection is still the endpoint it was prepared for. If you changed the
connection since, it is not sent: dismiss it and run again. When an answer
cannot be written, the text is kept in the window and saving it again writes
the same file. Saving again never calls the endpoint, recognizes a file an
earlier save already wrote, and never overwrites another file of that name.

### Connections

Settings has two connections, **Transcription** and **Text**. Each is a base
URL, the model used when a request names none, and an optional API key. They
are kept on this device: in the desktop app in the folder's `.git` (Git never
commits it, but copying the whole directory carries it), in a browser tab in
this site's `localStorage`. Nothing about them is in `kv.json` or history.

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
  has a key. In the desktop app the key never reaches the window, the folder,
  or history, and errors that echo it have it removed.
- In a browser tab (`bun dev:whispering:ui`) the tab sends requests itself, so
  the endpoint must allow the page's origin (CORS). Most hosted providers
  refuse that; a local endpoint or the desktop app works.

**From an earlier version.** An earlier version kept one key for every
endpoint, and the endpoint and model in `kv.json`. That key stays where it was
and is sent nowhere. Settings shows it as "A key saved by an earlier version";
tick the connections it may go to, each at the endpoint its form shows, and
press **Use the earlier key there**. It moves into those connections and is
removed from where it was; it is never shown. The `kv.json` endpoint and model
fill in the transcription form until you save it; this version never writes
`kv.json`.

One failure is different. If the desktop app's host process stops answering
partway, the window cannot tell whether the request reached the endpoint: it
may have been sent, and even answered, with the reply lost on the way back. The
notice says the outcome is not known, not that nothing was sent. Whispering
never sends it again on its own; **Try again** is one more request, and with a
paid endpoint possibly one more charge. This applies to transcription too.

### Saved is not committed

A save writes files. A commit records them in history. They are separate
outcomes and the status reports them separately.

- Every content save through tables, KV, or Files tries one commit
  automatically. Typing saves after a short pause.
- In the desktop app that try happens only if the folder is free at that
  moment. A save that lands while another save or commit is running is saved
  and not committed; nothing retries it later. The next save's commit, or
  **Commit now**, includes it.
- A commit that fails or is blocked never undoes a save and never reports the
  save as failed. The status says "Saved" and what happened to the commit, and
  **Commit now** tries again.
- Quitting commits nothing. Saves that are underway finish, and whatever was
  saved and not yet committed stays that way until the next commit.
- The browser terminal follows the folder's automatic history policy and refuses
  `git add` and `git commit` in automatic mode. Staged authoring requires a folder
  opened with `commitOnEdit: false`.
- Desktop terminal commands and other programs edit disk directly. Their changes
  enter the next automatic checkpoint or an explicit commit.

### When a save does not finish

Captured audio stays in the window until the folder is known to have both files. If writing
stops partway (the audio is saved and its row is not), the recording appears in
the notice under the header, on every page, with what happened, a player for
the audio held in the window, and **Try again**. Trying again keeps the
recording's ID and cannot create a second recording. It first reads what the
folder has. If the audio there is exactly the audio held in the window, it
saves the recording's file beside it and does not write the audio again.
Another program could still change the audio between that read and the save;
the audio and the recording's file are two saves, never one. If a different
file is at the recording's audio path or its own path, even audio of the same
length, nothing is overwritten and the recording stays pending. A file that only shares the recording's name with
another extension is not in the way.

Once both files are confirmed, the recording opens. If its file cannot be read
then, or another program removed it in between, the details say so; it is
never written a second time.

A transcript or a transformation result whose file could not be written is kept
the same way: the status says it is not saved, and the notice shows the text
with **Save it again** and **Copy**. A transformation result keeps the file name
it was given when the run began, so saving again cannot produce a second result,
and if another file has taken that name it is left alone.

Pending audio, an unsaved transcript or result, and unsaved typing live only in
the open window. They are not written anywhere else.

### Closing and quitting

Closing the window (the close button or Command-W) and quitting (Command-Q,
the Whispering menu, or on macOS Quit in the Dock, a logout, restart, or
shutdown) all ask the window first:

- When nothing is held, typing that can still be saved is saved and the app
  closes with no prompt.
- When something is held (a recording in progress, a recording that is not in
  the folder, a transcript or transformation result whose file was not written,
  a result on pasted text not saved yet, a running transcription or
  transformation, or edits whose save failed, conflicted, or was not
  confirmed),
  the app stays open and shows what would be lost. **Keep working** closes the
  prompt and changes nothing. **Discard and quit** closes the app and drops
  what was held.

Only leaving the app asks. Moving between Home, Recordings, and
Transformations never does, because nothing is lost by it.

The app closes only on an explicit answer from the window. A window that is
busy or slow keeps the app open until it answers; closing again only asks
again.

A logout, restart, or shutdown is always stopped while Whispering is open,
even when nothing is held: Whispering asks the window as for any quit, and the
logout does not continue on its own. Start it again once Whispering has
closed.

If Whispering's host process stops while the window is open, the terminal,
Reveal folder, and new transcription and transformation requests stop working
until you restart the app. Saving does not stop: the folder belongs to the
window's shell, so changes to recordings, transcripts, and other files can
still be saved, a pending recording can still be tried again, and **Commit
now** still works. A save can still fail for its own reasons, such as a full
disk, exactly as it can at any other time.

What the window can no longer do is be asked through the host whether it may
close. Closing or quitting then shows a prompt that says so and lists what is
still only in the window. The list follows what you save, and **Keep working**
lets you save, play a pending recording, or copy text out first. The app stays
open until you choose **Discard and quit** (or **Quit** when nothing is held);
in this state it never closes without that choice.

If the folder could not be opened at all and the window shows "Could not open
the recordings folder", nothing is open and nothing can be unsaved, so closing
or quitting just closes it.

This covers an ordinary close or quit. It does not cover the process being
ended from outside: Force Quit, `kill`, a crash, or power loss discard whatever
was only in the window, and nothing can recover it afterwards. Force Quit is
also the only way out if the window itself stops responding, or is closed
while it is still opening the folder and never finishes, since a window that
cannot answer is never closed on its behalf.

In a browser tab (`bun dev:whispering:ui`) the browser's own leave warning
applies instead.

### Editing and conflicts

Each open file is a draft, saved as you type: the recording or file you
selected, the recording's transcripts beside it, and the transformation you
selected. Selecting another item leaves the drafts it replaces once their
saves land.

- Every save is guarded by the version this window last saved. When the file
  changed elsewhere, your changes and theirs are combined: a field or line
  only one side changed is saved with no question. Parts you both changed
  show in a review under the save line, with **Your edit** and **Saved
  elsewhere** side by side. Pick one for each part (or **Use all from** one
  side when there are several), then **Apply** saves them all at once. There
  is no Cancel: your edits stay on screen, unsaved, until you apply.
- A file deleted elsewhere shows the same review for the whole file. **Your
  edit** creates it again from your version; **Saved elsewhere** leaves it
  deleted and closes it. A recording deleted elsewhere can only stay
  deleted, because its audio may be gone too: choosing **Your edit** is
  refused, and the reason shows beside it.
- A row file that no longer reads as a row after a change elsewhere: **Saved
  elsewhere** keeps that text and opens it as text with what to fix.
- A save that failed, or whose reply never arrived, keeps your edits on screen.
  **Try again** (or **Save again**) saves them; your next edit saves too.
- Leaving an item whose save failed or conflicted asks "Discard unsaved
  changes?" first. Keeping it keeps the item open.
- Deleting an item whose save failed or conflicted goes ahead: it deletes the
  version last saved, and the delete dialog says edits that are not saved are
  discarded too.
- A draft that is not a valid row, such as a field with the wrong kind of
  value, is never written; the save line names what to fix.
- Text typed or pasted into a field that a file cannot hold exactly (a lone
  surrogate) is saved with U+FFFD in its place.
- The lists are read when the page opens, after this window's own actions and
  terminal commands, and when you return to the window or its tab. Returning
  also takes a newer version of an open file that has nothing unsaved.

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

Deleting a recording also deletes its results; its audio stays. It is refused
while any result file cannot say which recording it belongs to (text that does
not read, or a file that is not text). Repair or remove those from Files
first.

### The terminal

On the desktop the terminal runs your own shell (`zsh`, `bash`, or `sh`) with
the data folder as its working directory, so `git log`, `git status`, `cat`,
`sed -i`, and redirection work on the real files.

It is not an interactive terminal. Each command runs in a new shell that starts
where the last one ended, so `cd recordings` holds but shell variables and
functions do not. There is no terminal device, so full-screen programs such as
`vim` or `less` exit at once; `git` output is not paged. A command that leaves
the data folder returns to its root. A command is stopped after two minutes.

Avoid making files executable in the data folder. History records plain files
only, so while an executable file is present a commit is not made, the branch
does not move, and the status reads "Commit blocked" with the reason. Saving
is not affected: your files are still written, and the status says so on its
own line. Remove the executable bit (`chmod -x <file>`) and commit again.

## Fixture audio

For repeatable automation, a debug build can answer every recording with the
bytes of one file:

```sh
WHISPERING_DATA_ROOT=/tmp/whispering-demo \
WHISPERING_AUDIO_FIXTURE=/path/to/tone.wav \
bun dev:whispering
```

The header shows a "Fixture audio" badge on every page and the recorder on Home
says the microphone is not used. Recordings made this way are saved with
`capture: fixture` and labelled on Home, in the list, and in details. A release
build refuses the variable, says so under the recorder, and records from the
microphone.

A fixture recording proves the save, playback, transcription, and history path.
It proves nothing about the microphone. Test the microphone separately, in a
launch without the fixture: with it, the microphone input control says there
is no real input and opens none.

## Failures you can cause on purpose

A debug build has a bug-icon menu in the header:

| Control | Effect |
| --- | --- |
| Fail the next recording file write | The next save lands the audio and fails the row, leaving audio with no recording file. Each press arms one more. |
| Fail the next audio write | The next save of a new recording fails before anything is written. |
| Lock the branch | Creates a lock on the branch ref, where an interrupted Git process leaves one, so commits fail while saves succeed. Press again to unlock. It never replaces a lock that already exists and only ever removes the lock it created. |

Both publication failures are real: for the length of that one save, the host
puts an empty directory where the file would be written, so the folder itself
fails that step and reports it. The directory is removed afterward.

The same failures can be armed at launch with
`WHISPERING_DEBUG_FAIL_ROW_WRITES=<n>`, `WHISPERING_DEBUG_FAIL_AUDIO_WRITES=<n>`,
and `WHISPERING_DEBUG_BLOCK_COMMITS=1`. The branch lock is taken when the
window has opened the folder, since there is no branch before that. To cause the commit failure by hand in
any build:

```sh
touch "$WHISPERING_DATA_ROOT/.git/refs/heads/main.lock"   # commits now fail
rm "$WHISPERING_DATA_ROOT/.git/refs/heads/main.lock"      # Commit now works again
```

## Restoring from history

History is ordinary Git, so a recording can be recovered without the app:

```sh
git -C "$WHISPERING_DATA_ROOT" log --oneline -- recordings/
git clone "$WHISPERING_DATA_ROOT" /tmp/whispering-restore
afplay /tmp/whispering-restore/recordings/<recording-id>.wav
```

## Changed promises

This build edits files through the folder's edit sessions. These promises of
the earlier build changed:

- A change made elsewhere is not overwritten. The next save of an open
  recording, transcript, or transformation used to write over another
  program's change unless you chose **Reload from file**. Now changes that do
  not overlap are combined, and you choose for each part you both changed.
- A file deleted elsewhere can be created again from your version (**Your
  edit**), except a recording. It used to be never created again.
- No "Keep both". A conflicting text file used to offer writing your
  version to `conflicts/<name>-<time>.md`.
- No paused autosave. The debug menu's "Pause autosave" is gone; every
  draft saves as you type.
- Several drafts are no longer kept per path. Leaving an item releases its
  draft once its saves land; one whose save failed asks before it is
  discarded. Drafts used to stay in the window for every file you had opened.
- A row that does not read is repaired as text. A recording with one bad
  field used to stay in the table and keep playing and transcribing; now it is
  listed under "Needs repair" until its text reads.
- A lone surrogate is saved as U+FFFD. It used to be refused with a notice.
- No "saved, cannot be shown" notice for a new recording. Once both files
  are confirmed the capture is dropped and the recording opens; the
  "Saved · 1 recording to check" status and its Refresh are gone.
- The lists no longer follow change hints. They used to refresh within a
  couple of seconds of any program's change; now they refresh when you return
  to the window, act, or press Check again.

## What is not supported

These are absent, not hidden behind a setting:

- Accounts, sign-in, sync between devices, and any hosted transport. Recordings
  are local.
- Git remotes, push, and pull from the app. Use `git` in the terminal.
- Git LFS.
- System-wide dictation: global shortcuts, push-to-talk, voice-activated
  recording, and delivering text to the cursor or clipboard automatically. Copy
  buttons are the only way text leaves the app. Space on Home works only while
  the app's window has focus.
- Automatic transcription or transformation after a recording. Each is a button
  you press, so nothing is sent to a paid endpoint on its own.
- On-device transcription models. Transcription needs an endpoint.
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
- Windows and Linux are untested. The terminal needs a POSIX shell.
- A release pipeline. `bun build:whispering` produces a locally signed bundle.
- Running inside the Epicenter desktop host. `bun run build:epicenter` still
  emits the page for that host, but the page opens nothing there. Epicenter
  does not start Whispering's host process and registers no Whispering
  folder, so the page shows "Could not open the recordings folder" and says
  that the desktop app did not start Whispering's host. Browser storage is
  never used inside a desktop app. The host's Whispering commands in
  `apps/epicenter/src-tauri` are not called by this app.
- Running the host process by hand, or opening the desktop folder from a
  browser tab. The folder belongs to the window's shell.
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
[desktop verification](./docs/desktop-verification.md) for native acceptance
results, screenshots, the microphone hardware limit, and what has not been
checked in the desktop app since the pages and transformations were added.
