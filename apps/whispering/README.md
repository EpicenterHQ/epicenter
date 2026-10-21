<h1 align="center">Whispering</h1>
<p align="center">Record → transcribe → transform → keep it all as files.</p>

Whispering is an app for voice notes. It records audio,
transcribes it with an OpenAI-compatible endpoint you choose, turns a transcript
into another text with prompts you write, and keeps every recording, transcript,
prompt, and result as an ordinary file in one folder. It needs no account and
no hosted API. Epicenter bundles the desktop page
([ADR-0493](../../docs/adr/0493-whisperings-only-desktop-shell-is-epicenter.md))
and opens it on a directory on disk. In a browser tab it keeps its folder in
the browser's storage for the site.

This is a development milestone, not a release. Its voice-note workflow is launch, record,
stop, save, play, transcribe, transform, inspect files, quit, reopen.
Native recording, Close/Quit and reopening were exercised on macOS with
copied test folders and a silent virtual input. Provider transcription remains
covered by tests, rather than a live endpoint run. Dictating into other apps is not part
of it. [What is not supported](#what-is-not-supported) lists the rest.

## App composition

The layout passes an inline `openFolder({ tables: whisperingTables })` opener
to FolderApp. Its child is `<WhisperingApp {context}>`: the product root
installs that exact context and calls `createWhispering(context)`. Whispering
constructs its own platform services internally; callers do not assemble a
workspace or provide a second folder lifetime. The build selects browser or
native capture and inference through `#platform/services`.

One Whispering owner holds capture, requests, selections and settings drafts.
Its startup maintains exclusions before recovery and reads. Its synchronous
`dispose()` refuses new work and late replies without finishing recordings or
waiting for workflows. FolderApp protects accepted saves; native departure
finalizes captured audio. Route changes retain the same app state.

Product-specific components read that mounted instance with `getWhispering()`
during initialization. Props select files or supply UI actions. Transformation
input stays in `whispering.view`, so closing an editor or switching pages keeps
it without parent bindings.

## The data folder

```text
~/Epicenter/Whispering/
├── .gitignore                     app-maintained Markdown-only Git defaults
├── recordings/
│   ├── <recording-id>.md            title, time, length; notes in the body
│   └── <recording-id>.<extension>   matching audio beside its Markdown file
├── transcriptions/
│   └── <result-id>.md               names its recording in frontmatter; transcript in the body
├── transformations/
│   └── <transformation-id>.md       title (and an optional model) in frontmatter; the instructions in the body
├── transformation_runs/
│   └── <run-id>.md                  a result on a transcript: what it was made from and with; the result in the body
└── text_runs/
    └── <run-id>.md                  a result on pasted text you saved: what was sent and with what; the result in the body
```

Startup maintains `.gitignore` so Git includes untracked Markdown and ignore files only. Where
requests go is set up per device in Settings and is never in the folder;
until you set it up, nothing is sent to a provider. Recording, transcript,
transformation, and result files are created by explicit actions. A folder has no
`transformations/` until you create a transformation, and no `text_runs/`
until you save a result on pasted text.

These files are the data. The app and any other program edit the same paths;
there is no export step and no second copy. Epicenter opens
`<folder root>/Whispering` by default, or another folder you choose through
"Open with…" in the Folders window. The folder an earlier installed copy
used, `<folder root>/so.epicenter.whispering`, remains on disk, is listed as a
data folder, and opens through that same menu. Epicenter no longer installs
apps. Set `EPICENTER_FOLDER_DIR` when starting Epicenter to
use another root, such as a disposable one for a test.

A recording's ID is its file stem, set when the recording starts
(`20260102-030405-k3f9`). Its title is a field, so renaming a recording changes
frontmatter and never moves a file. Audio is an ordinary same-stem file under `recordings/`,
saved as its exact bytes. Whispering keeps no history and copies the folder
nowhere, and a fresh folder has no `epicenter.json`: opening and recording
declare nothing. Whispering maintains Markdown-only rules in `.gitignore`. A copy of the
folder that leaves recording audio out has each recording's row, notes, and
transcripts, and no audio. There a recording says "This recording's audio
isn't on this device", and it cannot be played or transcribed.

The `epicenter` CLI's `save-version` and `sync` use Git's tracked-file
and ignore rules, without requiring `epicenter.json`. By default, the root
`.gitignore` excludes untracked audio, images, PDFs, and other non-Markdown files.
Those files stay on disk and travel with a complete folder copy. Already-tracked
files remain tracked; the app never silently removes them from Git or rewrites
history. There is no extra binary refusal or declaration privacy policy.

Whispering supplies these root defaults, which also apply in nested directories:

```gitignore
*
!*/
!*.md
!.gitignore
```

Whispering reads `.gitignore` before starting its first product reads. If that
ordered block is already present, startup writes nothing; comments and blank
lines do not interrupt it. Otherwise it inserts the block before existing text,
after any UTF-8 BOM, through `folder.files.write`, using the exact bytes read as
the merge base. Existing text and line endings survive. No version flag or rule
registry is stored.

Rules after the block and nested `.gitignore` files can override these defaults.
For example, `/private/` after the block excludes that directory, and `!*.wav`
allows WAV files into Git. Startup never overrides these customizations. A block
installed at the end by an earlier build stays there; move it to the top in Files
to let earlier custom rules take precedence.

A changed file is read again to confirm the root block survived merging. This
checks its presence, not the inclusion policy of the whole folder.
An unreadable file or failed update shows a warning while the rest of Whispering
and Files remain available. Fix `.gitignore` in Files, then reload to check again.
Startup leaves invalid UTF-8 or binary source unchanged. Removing a required
rule can cause Whispering to restore it on the next startup. Other writers and
sync can change it afterward; this is no permanent exclusion guarantee.

A successful save is local; later commit or sync records it. Whispering creates
no `epicenter.json`, initializes no Git repository, and sends no Git requests at
startup. The folder opener and clone do not perform app maintenance themselves.

A new recording pairs `recordings/<id>.md` with one supported audio file
`recordings/<id>.<extension>`. Desktop capture writes WAV; browser capture
keeps its supported container. The filename supplies the link, so new rows
store no `audioPath` field.

- No matching audio means the recording is readable but cannot play or transcribe on this device.
- Multiple matching audio files need repair. Whispering lists the candidates and never chooses by extension order.
- Only the same-stem layout supplies recording audio. Frontmatter paths have no special meaning, and startup performs no migration.
- Renaming a linked audio file from the app is refused. Deleting the recording still keeps its audio as an ordinary file.

See [ADR-0659](../../docs/adr/0659-whispering-audio-lives-beside-its-markdown.md).

## Run it

From the repository root, with Bun.

```sh
# The page alone in a browser tab, over this site's folder in the browser's storage
bun dev:whispering

# Epicenter, which bundles Whispering's desktop page (needs Rust)
bun dev:epicenter
```

In Epicenter's Folders window, choose Whispering under Apps to open its default
folder, or Choose folder… to pick another. Choose "Open with…" beside a listed
folder to open that folder in Whispering. Each folder opens in its own window.
The shell binds the directory to the window before opening it, then serves
the bundled page at `/whispering/`. Local opening needs no installation,
account, approval, or network connection. Build changes take effect when you
rebuild Epicenter and reopen the window.

Inside Epicenter the shell binds the window its folder, and the page names
no path or folder. The page is the UI, and it opens the
folder itself: it reads the files and saves them, and every read and save goes
through the shell, which keeps them inside the folder and out of Git's private
files. The shell's recorder writes a recording into the folder
as it captures. Requests to an endpoint go through the `epicenter` CLI,
which adds the connection's key.

Checks, from `apps/whispering`:

```sh
bun run typecheck                 # the page
bun run test                      # platform and workflow tests, then the mounted row views
bun run build                     # the browser build, into build/
bun run build:host                # Epicenter's bundled page, into dist/
```

Epicenter's native checks cover what it grants Whispering:
`cargo test --manifest-path apps/epicenter/src-tauri/Cargo.toml`.

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
| Status | Whether everything you did is saved on this device, and where the folder is. |
| Settings | The two connections, transcription and text: each an endpoint, a default model, and an optional key, kept on this device and outside the folder. See [Connections](#connections). |
| Files (Ctrl+Shift+E) | The folder's files, beside any page. A recording row opens on Recordings and a transformation on Transformations; an audio file opens a player and other text a plain editor, both on Recordings. |

### Working with recordings

The table starts at full width. Activate a recording to open its detail pane,
then close the pane to return that space to the collection. Search, sorting,
and selection stay when you change pages or hide details.

Edit transcript text beside playback. Each change is written to the
transcript's file as you type; opening the file from Files shows the same
text. Copy uses the text shown; Transform first waits for what is being
written and reads the saved transcript.
Dates, file paths, capture information, and endpoint are under
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
- The choice is kept on this device and is never written to the folder. It is
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
  adds files on its own. A new transformation is written with `model: null`:
  it uses the text connection and its model.
- A transformation's page has three tabs. **Instructions** opens first and
  edits the title and instructions; **Model and connection** below them holds
  the optional model and where requests go. **Try it** runs it (below).
  **Source** edits the file's exact text. A file that does not read as a
  transformation opens in Source with its issues, and Instructions opens once
  the text reads. Typing in either saves as you type. A save from Instructions
  changes only what you changed, keeping fields the app does not know and
  your comments; Source saves the text exactly as typed.
- A model typed in a transformation is used instead of the text connection's;
  leave it empty to use the connection's. Whispering keeps no list of
  providers or models.
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
this site's `localStorage`. Nothing about them is in Whispering's folder.

You can keep editing while a connection's Save runs. Its completion preserves
any newer endpoint, model, key choice, or key for the next explicit Save.

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
  has a key. In Epicenter the key never reaches the window or a folder: the
  `epicenter` CLI adds it to the request, and the endpoint needs no CORS
  headers.
- In a browser tab (`bun dev:whispering`) the tab sends requests itself, so
  the endpoint must allow the page's origin (CORS). Most hosted providers
  refuse that; a local endpoint or Epicenter works. The key is saved in this
  browser, where code running on the site can read it, and the key form says
  so. Errors that echo the key have it removed.

One failure is different. If Epicenter stops answering partway, the window cannot tell whether the request reached the endpoint: it
may have been sent, and even answered, with the reply lost on the way back. The
notice says the outcome is not known, not that nothing was sent. Whispering
never sends it again on its own; **Try again** is one more request, and with a
paid endpoint possibly one more charge. This applies to transcription too.

### Saving

Every change is saved as you make it, on this device. The status says whether
everything you did is saved, and nothing about versions: Whispering keeps no
history and does not sync its folder. Save version, Connect, and Sync are not
in this build.

- Terminal commands and other programs edit the files directly.
- Folder reports saves made through its handles, including another browser
  tab's saves. Visible queries poll for edits from other programs or a
  terminal. A save over a file that changed since your edit started merges with the
  change (see [Editing](#editing)).
- If the folder is a Git repository you manage, `git` works on it as on any
  directory. Whispering commits nothing, and recording audio stays out of
  that repository only according to its tracked-file and `.gitignore` rules.

### Where a recording is while it runs

A recording is in the folder from the moment it starts. Its row is written
then, with the time it started and its capture source; its length
is written when it stops. Nothing in the row says whether it is still
recording: the window knows that, and only while it runs.

- In Epicenter the shell writes the audio as it is captured, to
  `recordings/<id>.wav`, and brings its header up to date about once a
  second. Stop finishes the file and writes its length. Reloading or closing
  the window finishes the file too, without a length. A quit, a crash, or
  power loss keeps the audio up to that moment; when
  the folder next opens, the app rewrites the header of any recording that
  was cut off so it plays to its end. Its row then has no length.
- In a browser tab the audio is held in the page and written on stop, as
  `recordings/<id>.webm` (or `.mp4` or `.ogg`, as the browser records).
  Reloading or closing the tab loses it, and the row stays without its audio.
  A recording does not hold the tab open.
- The app never deletes a recording's audio; deleting a recording keeps it.

If the microphone disconnects, access is revoked, or capture fails, recording
stops and the app reports why. It finishes the captured audio through the same
save path as Stop, keeps the recording, and reports any failure to save. It
does not restart the microphone or send a transcription automatically.

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

Closing a desktop window asks only if its Folder has an unfinished save.
A recording alone closes without a warning; native cleanup finishes and keeps
its audio. Epicenter always confirms application Quit and mentions any active
recording. Cancel keeps the windows, input, and recording going. Close Anyway
or Quit Anyway leaves without waiting for page workflows; unsaved input may
be lost, and departure does not promise recording length metadata. An
unfinished settings form or pasted text does not cause a window-close prompt.

Force Quit, a crash, and power loss cannot ask. A recording is in the desktop
folder from its start; a transcription or transformation writes its result
file before sending a request.

- In Epicenter a recording keeps its audio up to the moment the app
  closed, and the next time the folder opens its header is repaired so it
  plays to its end.
- A transcription or transformation whose answer had not arrived stays
  unfinished, to run again.
- A change typed in the last instant before quitting can be lost, as it can
  be in any app. Every earlier change is already in its file.

Moving between Home, Recordings, and Transformations keeps the mounted app
and never prompts. In a browser tab (`bun dev:whispering:ui`), the browser's
leave warning appears while the Folder has an accepted change still saving.
Reloading or closing the tab loses a browser recording in progress.

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
  field or the same lines, your edit wins, with no notice. Reading the folder again never touches
  what you are typing.
- Text edited as a whole file (Source, or any text file from Files) merges the
  same way, by line (ADR-0551).
- Typing into a row deleted elsewhere brings the row back with what you
  typed: a deletion you did not see never erases an edit (ADR-0632). A row
  deleted elsewhere with nothing typed in it stays deleted.
- A save that fails, or whose reply could not be confirmed, keeps your edit in
  the window, and the file's status line says **Not saved** with **Try
  again** and **Discard**. It is also saved again with your next change, and
  before anything that reads the file, such as a run or a deletion. Discard
  leaves the file as it is and offers what you typed to copy. A failed save of
  a file's whole text is also reported with the text to copy.
- A value that does not fit a row, such as a field with the wrong kind of
  value, is saved as written, and the row is listed under "Needs repair" until
  it is fixed. Nothing you typed is refused.
- A field you change leaves the rest of the file's bytes as they were. Notes,
  transcripts, and instructions you type are saved with LF line endings.
- Folder change notifications refresh affected lists after saves, and visible
  queries poll for outside changes. Save completion does not wait for reads.

A recording, transcript, or transformation file whose text does not read as a
row is listed under "Needs repair" with why, and opens as its text with the
issues of its saved text; they update once what you type is saved, a moment
after you pause. Source stays open after a repair until you explicitly return to fields. A row starts
with a `---` line, its fields, and a closing `---` line; Markdown without
those lines, bad YAML, a repeated key, a missing field, or a field with the
wrong kind of value does not read. A transformation runs once its file reads
and it has instructions. Fields the app does not know are kept. Saving a row
from its fields changes only what you changed: comments, the spelling of
other fields, and the body are kept.

Any file name works for a row, including a trailing space or `recordings/.md`.
Only `.md` in lowercase makes a file a row.

A deletion reserves every file it will remove and saves their held input first.
If any input cannot save, no file is deleted. It then deletes each file as it is stored; an outside change during deletion keeps that file. Deleting a recording also deletes its results; its audio stays. It
is refused while any result file cannot say which recording it belongs to
(text that does not read, or a file that is not text). Repair or remove those
from Files first.

Files lists files. A folder appears while files are in it and goes when they
do, so Files creates files, not empty folders. Renaming a file saves it under
its new name and then deletes the old name; if the old file changed in that
moment, both are kept and you are told.

## Fixture audio

For repeatable automation, a development build in a browser tab
(`bun dev:whispering`) opened with `?fixture=tone` answers every recording
with a generated tone instead of the microphone. Recordings made this way are
saved with `capture: fixture` and labelled on Home, in the list, and in
details. A production build ignores the parameter. Inside Epicenter, recording
always uses the microphone.

A fixture recording proves the save, playback, and transcription path. It
proves nothing about the microphone: with it, the microphone input control
says there is no real input and opens none.

## Changed promises

This build opens its folder as the local `Folder` (`@epicenter/folder`) with
Whispering's tables, and keeps what you type in the folder's drafts until it
is saved (ADR-0632). These promises of the earlier build changed:

- No versions, Connect, or Sync. **Save version** and the status lines about
  changes since the last version are gone, and Whispering no longer writes
  `epicenter.json` into its folder. Startup maintains `.gitignore` through the
  ordinary files API, separately from committing or syncing.
- In a browser tab, recordings an earlier build kept in OPFS are not read or
  changed. An origin with only those recordings opens an empty current folder.
- Typing into a row deleted elsewhere brings it back with what you typed. The
  earlier build kept it deleted and offered the text to copy.
- A value that does not fit a row is saved, and the row is listed for repair.
  The earlier build refused it.
- Saving a row from its fields keeps comments and the file's own spelling.
  The earlier build rewrote the frontmatter.
- A failed save of a row offers **Try again** and **Discard** where you typed,
  instead of a notice.
- A deletion deletes the file as it is when it runs. A file another program
  changes in that very moment is kept, and you are told.
- Files no longer creates empty folders, and renaming a file is a save under
  the new name followed by deleting the old one.
- Epicenter bundles Whispering, and "Open with…" can open any listed folder.
  The status names the folder as opened in Epicenter rather than showing an
  internal ID.

## What is not supported

These are absent, not hidden behind a setting:

- Accounts, sign-in, sync between devices, and any hosted transport. Recordings
  are local.
- Versions, history, Git remotes, push, and pull from the app. Use `git` in
  the folder if you keep it in a repository.
- Reading recordings an earlier build kept in a browser's storage.
- Empty folders in Files.
- System-wide dictation: global shortcuts, push-to-talk, voice-activated
  recording, and delivering text to the cursor or clipboard automatically. Copy
  buttons are the only way text leaves the app. Space on Home works only while
  the app's window has focus.
- Automatic transcription or transformation after a recording. Each is a button
  you press, so nothing is sent to a paid endpoint on its own.
- Choosing transcription on this computer. Epicenter grants Whispering its
  local model, and the native services can transcribe with it
  (`src/lib/platform/desktop/transcription.ts`), but Settings has no way to
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
- Opening the desktop folder from a browser tab. The shell binds the folder
  to Whispering's window alone.
- Moving audio away from its recording or renaming its stem and having the recording follow.
  Nothing collects orphan audio automatically or follows a frontmatter audio path.

The earlier Whispering stored recordings and transformations in a Yjs store.
Nothing reads that data. There is no migration. The pages, sidebar, and
recorder follow that app's layout; the code and the data underneath do not come
from it.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for how the pieces fit,
[recipes and connections](./docs/recipe-playground.md) for why requests are
routed by device connections and what that change costs an existing folder, and
[desktop verification](./docs/desktop-verification.md) for what was checked in
the standalone desktop app before it was deleted.
