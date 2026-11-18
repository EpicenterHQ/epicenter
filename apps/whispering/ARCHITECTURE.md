# Whispering architecture

Whispering is one build that runs in a browser tab and in a Tauri window
([ADR-0781](../../docs/adr/0781-apps-branch-on-what-a-capability-offers-and-one-build-serves-every-surface.md)).
It keeps its recordings on the device it runs on
([ADR-0894](../../docs/adr/0894-whispering-8-keeps-its-recordings-and-their-audio-in-its-own-data-directory-and-needs-no-epicenter.md)):
in a Tauri window in `data/` in the app's local data directory, unless the
person picked another folder, and in a browser in `data/` in the Origin
Private File System. Both hold the same tree (`src/lib/format/folder.ts`):
five note collections, the audio beside each recording, and `settings.md`.

```text
src/lib/format/folder.ts     the folder's paths and each note's fields, and why a note does not read
src/lib/format/note.ts       a note as text: the home's Markdown grammar
src/lib/files/               Files: read, write, list, remove; tauri, opfs and memory, one conformance suite
src/lib/notes.ts             one note collection over Files: list it, set, replace, delete
src/lib/settings.ts          settings.md: the model per job, the connections, the shortcut
src/lib/folder.ts            the folder: one read of every note, settings and the audio
src/lib/folder-query.ts      the page's QueryClient over the folder: one query, writes as mutations
src/lib/note-editor.svelte.ts one note as an editor: typing, its save, and a failed save kept
src/lib/runs.svelte.ts       transcriptions and recipe runs in this window, until their answer is saved
src/lib/this-computer.ts     what stays on this computer: localStorage, secrets, the request fetch
src/lib/app.ts               the capabilities, opened once: folder, ai, speech, recorder, shortcut
src/lib/whispering.svelte.ts models, microphone, recorder: Whispering over the capabilities
src/lib/inference.ts         a request to a model, and how its failures read
src/lib/library.svelte.ts    the pages' state over the folder: lists, selection, runs, deletion
src/lib/one-tab.svelte.ts    the Web Lock that keeps a browser to one tab
src/lib/export.ts            the folder as one zip file, for a browser's export
src/routes/                  the chrome, the app's root and pages
src-tauri/                   the desktop app's shell
```

## Files

`Files` (`src/lib/files/files.ts`) is five operations over paths relative
to the folder, each answering a `Result` whose error is `NotFound`,
`Refused` or `Io`: `read`, `readMany` (many files' bytes in one call, so a
list loads without crossing to the shell once per note), `write` (the
whole file), `list` (one directory's files with their size and modified
time), and `remove`. Only plain names pass (`checkPath`): each segment is
letters, digits, `-` and `_`, and a file's name ends in at most one
extension, so `..`, a hidden file and an absolute path are refused.

- `tauriFiles(dir)` calls five of Whispering's own commands in its shell
  (`src-tauri/src/files.rs`): `files_read`, `files_read_many`,
  `files_write`, `files_list`, `files_remove`. Each checks the folder
  against the app's grant (the default folder, which the shell allows at
  start, or the one the dialog granted and `tauri-plugin-persisted-scope`
  restores) and refuses a symbolic link. Reads answer raw bytes;
  `files_read_many` answers one buffer of a count, each length (or a
  missing marker), then the bytes. A write is staged in `local/.tmp/` in
  the app's local data directory and renamed into the folder, so the
  folder only ever holds finished files. The page holds none of
  `@tauri-apps/plugin-fs`'s commands.
- `opfsFiles(dir)` writes through `createWritable()`, whose changes reach
  the file when the stream closes, and reads a few files at a time.
- `memoryFiles()` is a map, for tests.

`src/lib/files/conformance.ts` is one suite all three pass: `files.test.ts`
runs it against memory and against `tauriFiles` over a stand-in for the
shell's commands, and a real browser runs it against OPFS from the dev
page. The shell's own Rust tests cover the commands and the place step.

Notes are read and written in the home's Markdown grammar,
`@epicenter/app/markdown` (`src/lib/format/note.ts`): `key: <JSON>` lines
between `---` fences, then the body. A change rewrites only the lines of
the keys it names.

Each kind of note declares its fields as a TypeBox object in
`src/lib/format/folder.ts` (`NOTES`, `SETTINGS`). A field is required
unless it is optional, and a key no kind declares is kept and never
checked. `checkNote(fields, text)` answers a note's fields and body, or
every reason it does not read: front matter that does not parse, or each
field that does not fit, by field and at its line. A list shows a note
that does not read for repair, and `NoteRepair.svelte` runs the same check
as the person types.

## Notes, settings and the folder

The services keep nothing between calls, return `Result`s, and are not
Svelte.

- `createNotes` (`notes.ts`) is one collection. `list()` lists its
  directory and reads every note in one `readMany`: the notes that read,
  those that do not (with why and their text), and each note's text by
  id. `set({ id, seen, changes })` merges fields and body into the note;
  `replace({ id, seen, text })` writes text as typed, for repair;
  `delete({ id, seen })` removes it. `seen` is the note's text as the
  person saw it: each write reads the file first and refuses with
  `NoteError.Changed`, writing nothing, when it differs.
- `createSettings` (`settings.ts`) is `settings.md`, with the same `seen`
  check before each write: the model for each job, the connections (never
  a key), and the shortcut. A `settings.md` that does not read is named in
  Settings and replaced by the next save.
- `openFolder` (`folder.ts`) reads the whole folder as one snapshot: the
  five collections, the settings, and the audio in `recordings/`. A
  recording is its id: `unnotedOf` lists audio no note names as an
  untitled recording dated from its id, and `audioOf` answers `here`,
  `ambiguous` (more than one extension), or `absent`.

`createFolderQuery` (`folder-query.ts`) is the page's one TanStack
`QueryClient` over the folder:

- The folder is one query. It never goes stale by time: after every write,
  finished or failed, one `MutationCache` rule marks it stale, and the
  write stays pending until the folder on screen was read again. A read
  that a write overtakes is cancelled, so the folder shown is never older
  than a finished write. It is read again when the window regains focus,
  since another program may write the folder.
- Every write is a mutation. A kind's writes share a `scope`, so they run
  one at a time in the order made. `setNote` and `removeNote` take `seen`
  from the snapshot shown.
- `settings` reads `settings.md` from the query's answer for code that is
  not a component (the connections `ai` merges, the shortcut, the model
  choices), says when it changes, and writes through the client.

`editNote` (`note-editor.svelte.ts`) is an editor, and Svelte state on
purpose: what the person typed belongs to the page until it is saved.
Field accessors save 300 ms after typing, one save at a time. A failed
save keeps the typing and says why (`problem()`), with `retry()` and
`discard()`; after `Changed` the newer note shows under the typing and
nothing saves until the person picks one (`SaveProblem.svelte`).
`unsaved()` counts editors holding typing, which the root's leave guard
reads.

## The capabilities and the root

`src/lib/app.ts` opens every capability once, for the page's life
([ADR-0766](../../docs/adr/0766-an-apps-capabilities-are-module-values-opened-synchronously.md)).
Code imports what it uses from there, never through context.

- `folder`: `openFolder(isTauri() ? tauriFiles(desktopFolderPath) :
  opfsFiles('data'))`. The desktop folder is the path in `localStorage`
  (`folderPath`) or `data/` in the app's local data directory.
- `query`: `createFolderQuery(folder)`, and `settings`, its settings as
  components read them (`reactive`). TanStack's focus is the window's own
  focus and blur, since a desktop window stays visible behind another app.
- `ai` and `speech`: the models (see "Models and connections").
- `recorder`: the microphone device (see "Recording").
- `shortcut`: the global shortcut over `settings.md`, null in a browser.
- `keysKept`: where a connection's key is kept, which Settings says.

`routes/(app)/+layout.svelte` is the app's root. It holds the Web Lock
(`holdOneTab`): a second tab says Whispering is open in another tab and
waits. Then it asks the browser to keep its storage
(`navigator.storage.persist()`), reads the folder (`createQuery` over the
folder query, enabled once the tab holds the lock), starts holding the
shortcut, and renders `WhisperingApp` inside `QueryClientProvider`. A
folder that cannot be read is said with Try again, and on the desktop
"Use the default folder" when the person picked one. It asks before the
page is left while an editor holds unsaved typing.

`WhisperingApp.svelte` makes `createWhispering` (the models, the
microphone, the recorder) and `createLibrary` over the folder, puts both in
context, renders the frame, and disposes both when it leaves.

`src/lib/page-boundary.test.ts` pins this: `openFolder`, `tauriFiles`,
`opfsFiles` and the capabilities only in `app.ts`; `createWhispering` and
`createLibrary` only in `WhisperingApp`; nothing from Node or Bun; Tauri
only in the files it names, with every Tauri module but
`@tauri-apps/api/core` loaded when first used. `apps/whispering/scripts/first-load.test.ts`
holds that the web's first load carries no desktop module.

## Recording

`recorder` is one microphone device (`microphone.ts`) over the `recorder`
from `@epicenter/recorder`, which picks the browser's or the shell's. A take
lands at `recordings/<id>.<ext>` when Stop answers.

- In a browser the recorder asks for AAC in MP4 first and Opus in WebM
  second, keeps each piece in memory, and at Stop writes the take once
  through `Files`. A crash or a closed tab loses the take.
- In a Tauri window the shell encodes Opus into the take
  `local/recording/<id>.webm` in the app's local data directory, outside
  the folder, a second at a time, and at Stop finishes it and places it at
  `recordings/<id>.webm` by one rename that replaces nothing. A take it
  cannot place answers `Unplaced` and stays.

A recording has no note while it records: the record screen
(`RecorderCard.svelte`) shows the take. Once Stop answers with the audio at
its path, the note (title, `recordedAt`, `durationMs`) is written and the
audio listed again. Audio that could not be written fails the recording,
saying why. A note that could not be written leaves the audio listed as an
untitled recording, and the recorder says so.

On the desktop a quit or a crash leaves the take in `local/recording/`.
Each launch, beside the pages, `capture.recover` finishes it from its
whole seconds and places it in the folder, where it lists as an untitled
recording; what it cannot complete, and a take whose audio's place is
taken, is said.

The microphone choice and its test belong to `microphone-input.svelte.ts`,
one owner of at most one open microphone. The choice is in `localStorage`
(`microphone-preference.ts`).

## Requests and results

`runs.svelte.ts` owns transcriptions and recipe runs. A run is keyed by what
it runs on, so the same run does not go twice at once, and gets its
result's id and its target (the endpoint and model chosen then) when it
starts. Sending is a plain call; saving the answer is a note write through
the folder query. Its state lives in this window as Svelte state, like an
editor's typing, until the answer is saved: `running`, `saving`, `failed` (Run
again sends the same request to the same target, and refuses when that
endpoint was removed or moved), or `unsaved` (the answer arrived and its
note could not be written; Save again writes it and sends nothing).

- Transcription reads the audio only once the target's endpoint is known to
  be where it was, and checks again before it sends (`inference.ts`).
- `recipe.ts`'s `resolveRecipe` is the one decision whether a recipe can
  run and with what.
- A transformation never writes its transcript. A result records the exact
  prompt and input it sent.

## Models and connections

Every model is an endpoint
([ADR-0757](../../docs/adr/0757-every-model-is-an-endpoint-every-model-file-is-a-cache.md)).
`app.ts` makes one `openAi` (`ai`) from, in order, `customEndpoints` (one
endpoint per connection in `settings.md`), `localServers` (Ollama and LM
Studio), and on the desktop `localSpeech()` from `@epicenter/transcription`
(`speech`, administered by `SpeechSettings`).

A connection's key is a secret on this computer (`this-computer.ts`): a
Keychain item the shell keeps on the desktop (`secret_get`, `secret_set`),
and `localStorage` in a browser. `customEndpoints` reads it as each request
leaves and sends it only while the connection is at the base URL it was
entered for. The page sends every request itself: on the desktop through
`@tauri-apps/plugin-http`, which follows no redirect, and in a browser with
`fetch`.

The person chooses one model for transcription and one for text
(`ModelPicker` from `@epicenter/ai/picker`, in `ModelSetting.svelte`), kept
in `settings.md`. A refusal before sending says nothing was sent; an
endpoint that never answered leaves the outcome unknown. Keys never reach
Whispering's files, logs or errors.

## Deleting

`deletion.ts` captures what a deletion removes from what the lists show, for
the person to confirm, then deletes exactly that, stopping at the first
failure. A recording takes its transcripts, the transformation results made
from them, its note if it has one, then its audio. It is refused while a
run for it is under way or waits to be saved again, and while any of its
results does not read.

## Settings and export

`FolderSettings.svelte` shows the folder. On the desktop: its path, Show in
Finder, Copy path, and Change…, which opens the folder dialog and reloads
the page over the folder picked. In a browser: how much is stored, whether
the browser keeps it, and Export as zip (`export.ts`, a stored zip of
`settings.md` and the five directories, up to 65,535 files and 4 GB).

## Tests

`bun run test` runs under Svelte's browser runtime over jsdom
(`src/lib/svelte-dom.test-support.ts`), since Svelte's server runtime
notifies nothing. `services.test-support.ts` makes `testFiles()` (memory
that a test can make refuse writes or reads under a directory) and
capabilities with one stub endpoint saved in `settings.md`;
`whispering.test-support.ts` makes the app as the root and `WhisperingApp`
do. `desktop.test.ts` composes the capabilities as a Tauri window gets
them, over a stand-in shell; `shortcut.test.ts` checks the global shortcut.
