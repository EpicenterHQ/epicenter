# Whispering architecture

Whispering's web build is a page that runs in a browser tab, and it is the
local variant: one store, this browser's private files (OPFS), for the
page's whole life. Its desktop app is the same pages over a data folder on
the computer (see the README's "The desktop app"). Its data is the `whispering` contract's files
(`src/lib/contract.ts`): five note collections and the audio beside each
recording. It reads and writes them only through the contract's typed
client. Nothing syncs, uploads, or moves between stores, and signing in
grants capabilities, never storage
([ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)).
```text
src/lib/contract.ts          the contract (published as static/contract.json)
src/lib/files.svelte.ts      one client's note lists, and its recordings' audio
src/lib/whispering.svelte.ts services, models, microphone, recorder
src/lib/inference.ts         a request to a model, and how its failures read
src/lib/library.svelte.ts    the pages' state over the files: lists, selection, runs, deletion
src/lib/platform/            what each build decides: root, services, auth, variant (#platform/*)
src/lib/components/          the variants' startups, header chrome, settings, callbacks
src/routes/                  the chrome, the app's root and pages, the sign-in callback
src-tauri/                   the desktop app's shell
```

## The roots

- `routes/+layout.svelte` is the chrome every route shares: tooltips, the
  confirmation dialog, toasts, the theme, and the leave guard
  (`guardLeave`), which asks before leaving while a save is out.
- `routes/(app)/+layout.svelte` is the app's root: under a
  `<svelte:boundary>` it renders the build's `Startup` (`#platform/root`),
  which opens the store, wraps it for Svelte once there (decision 87), and
  hands both to `<WhisperingApp {client} {files}>`:
  `LocalStartup` awaits this browser's device; `DesktopStartup` awaits the
  AppData root and the data folder, or renders the recovery screen. Its
  pages are `/`, `/recordings` and `/transformations`.
- `routes/auth/callback/` is outside the group, so it opens no files: it
  renders the build's `Callback`, which finishes a web sign-in and loads the
  page it started from.
- `WhisperingApp.svelte` takes the client and its Svelte state as props. It makes
  `createWhispering({ client })` (the services, the models, the
  microphone and the recorder) and
  `createLibrary({ whispering, files: filesOf(client, files) })`, puts both in
  context (`setWhispering`, `setLibrary`), awaits `start()` (the model
  choices, the saved connections and the saved microphone), renders the frame (sidebar or bottom bar, and
  the header with its status line), and disposes both when it leaves.

Nothing below `WhisperingApp` knows which store it is; where only a
sentence differs, a component reads `variant` from `#platform/variant`.

Each page route renders a page component (`HomePage`, `RecordingsPage`,
`TransformationsPage`) that reads the library from context. Changing pages
keeps everything in progress, and a run under way still keeps its answer in
the files unless Whispering itself is closing.

`src/lib/page-boundary.test.ts` pins this: `openDevice` only in
`LocalStartup`, `openDataFolder` only in `DesktopStartup`; nothing
calls `openRemote` or imports `@epicenter/folder/remote`; `createWhispering`,
`filesOf` and `createLibrary` only in `WhisperingApp`; `fromClient` only
where each build's store is opened (`LocalStartup`, `DesktopRoot`, which
also wraps the AppData root); auth only through `#platform/auth`; services only through
`#platform/services`; and nothing from Node or Bun, Tauri only in the desktop
leaves.

## The files

`files.svelte.ts` gives the pages one client's note collections (its
Svelte state, `files.<collection>`) and its recordings' audio. The library
sorts each list (`newest`, `byTitle`). Each list lists and listens only while
something reactive reads it; a read outside an effect is a snapshot.

- `WhisperingApp` sets the collections the pages edit (`setRecordings`,
  `setTranscriptions`, `setTransformations`), and a page edits one note with
  one editor (`getRecordings().edit({ id })`): its saves go one at a time,
  over what the person saw when typing began, so another writer's change to
  a field not typed is kept and a change to a typed one surfaces as a
  conflict.
- A note that does not read is in the list's `invalid`, with its issues and
  text; `library.repairs` gathers those of recordings, transcriptions and
  transformation runs, and the transformations page shows its own and text
  runs'. `replace` repairs one from text.

Audio is a file collection, `recordings/{id}.{ext}`. `files.audioOf(id)`
answers `here` with one file (its extension and version), `ambiguous` for
more than one extension, `absent`, or `listing`. `files.readAudio(id)` reads
it through the client.

## Recording

The capture device comes from the services (`#platform/services`): one
microphone device (`microphone.ts`, `createMicrophoneDevice`) over the
`recorder` each build's services leaf imports, `@epicenter/recorder`'s one
interface. It writes the recording into the client's files as it records
(decision 84), through `recorder.start({ device, path })` and
`recorder.recover({ device, under })`, and the microphone choice lists and
tests inputs through the same recorder (`listInputs`, `openMeter`, and in a
browser `allow` and `onInputsChange`). In a browser (`platform/browser.ts`,
over `@epicenter/recorder/browser`) the recorder asks for AAC in MP4 first
and Opus in WebM second, and appends each piece (about a second) to
`recordings/<id>.m4a` or `.webm` in this browser's files as it arrives. On
the desktop (`platform/services.tauri.ts`, over `@epicenter/recorder/tauri`)
it is the shell's microphone, which encodes Opus into a WebM from the first
sample in the folder's `.epicenter/recordings`, a second at a time, and at
Stop finishes it and places it at `recordings/<id>.webm`.

A recording has no note while it records: the record screen
(`RecorderCard.svelte`) shows the take. Stop releases the microphone and
answers once the audio is at its path, with how long it plays; the note
(`title` from the start time, `recordedAt`, `capture`, `durationMs`) is
written then (`keepRecording` in `folder-recordings.ts`), so the library
gains the row then and every note names audio that is there. On the
desktop Stop finishes the file and places it in the same few milliseconds
for a recording of any length, so nothing waits after Stop. A recording
that wrote no audio (the store refused it, or nothing was captured), or
whose audio could not be placed, leaves no note.
Recording never waits on the network. Where the browser keeps no files (a
private window) the recorder refuses before any microphone opens.

A quit, a crash, or a closed tab leaves audio that no note names. Each
start first gives it one (`finishCutOffRecordings`), the only path by which
a cut-off recording reaches the library: `capture.recover(unnamed)` repairs
it (on the desktop finished from its whole seconds, as Stop would have,
and placed at its path, or deleted when its path already holds the file
placed before the cut; an `m4a` or `webm` cut back to its last whole piece
in a browser, skipping one another tab is still writing) and answers each
recording whose audio is whole at its path,
and each one no note names gets a note titled "Recovered recording", its
length the one recovery answered or read from the audio
(`audioDurationMs`). In a browser nothing is read for repair unless some
audio has no note; on the desktop, where a cut-off recording waits outside
its path, recovery always looks, and audio at its path is finished (one
the shell placed after its page left, or whose note was never written).
Starting runs this before the app shows any page (`WhisperingApp` awaits
`whispering.start()`), and a desktop cut-off recording is at no data path
until recovery has finished it, so nothing lists, plays, or transcribes one
first: such a file reads wrong (no length in a player, a torn block in the
transcription decoder) until it is finished.

The microphone choice, its test, and Enable microphones belong to
`microphone-input.svelte.ts`: one owner of at most one open microphone,
released by choosing, recording, or closing. The choice is kept in
`localStorage` (`microphone-preference.ts`).

## Requests and results

`runs.svelte.ts` owns transcriptions and recipe runs. A run is keyed by what
it runs on (`transcriptions:<recording>`, `transformation_runs:<transcript>:<recipe>`,
`text_runs:<recipe>`), so the same run does not go twice at once, and gets its
result's id (`timeId`) and its target (the endpoint and model chosen then)
when it starts. Its state lives in this window: `running`, `failed` (Run
again resends the same request to the same target, and fails with why when
that endpoint was removed or moved since), or `unsaved` (the answer arrived; its note
is being created, or why it was not; Save again creates it with the same id
and sends nothing, and `Occupied` means an earlier save landed). When the
answer arrives the result note is created in the files with every field
fixed and the answer as its body, so a result note always holds an answer.

- Transcription reads the audio through `files.readAudio` only once the
  target's endpoint is known to be where it was, and checks again before it
  sends (`inference.ts`).
- A recipe run sends what the page shows (the recipe and transcript text,
  typing included) or else the notes as listed. `recipe.ts`'s `resolveRecipe`
  is the one decision whether a recipe can run and with what; the Run button,
  the post-processing choice, the Transform menu, and the run all ask it.
- The transcript is never written by a transformation. A result records the
  exact prompt and input it sent.

## Models, connections and sign-in

Every model is an endpoint
([ADR-0757](../../docs/adr/0757-every-model-is-an-endpoint-every-model-file-is-a-cache.md)).
`whispering.svelte.ts` merges, in this order, `hosted(account)` (Epicenter's
models through the account signed in now), one `custom` endpoint per
connection the person saved, and what runs on this computer: Ollama and LM
Studio (`localServers()`), and on the desktop `localSpeech()`. The build
supplies each through `#platform/services` (`endpoints`): the web keeps
connections, keys included, in this site's `localStorage` and sends from the
tab; the desktop keeps them in AppData's `connections.md` with each key in
the credential store, and sends every one of them, Ollama's and LM Studio's
included, through the shell's fetch (`connection_fetch`), which adds the key.

The person chooses one model for transcription and one for text
(`ModelPicker` from `@epicenter/ai/picker`, in `ModelSetting.svelte`, kept by
`createModelChoices` in `localStorage`); the same picker adds, edits and
removes a connection. `inference.ts` sends a prepared request through the
endpoints merged at that moment, to its target alone, and refuses one whose
endpoint was removed or moved. A refusal before sending says nothing was
sent; an endpoint that never answered leaves the outcome unknown. Keys never
reach Whispering's files, logs or errors: an endpoint removes its key from a
refusal it reads, and on the desktop the shell does.

Signing in is optional and lives in Settings (`AccountStatus.svelte`). The
OAuth client (`platform/auth.ts`) asks for one resource, the API audience,
with `openid profile email ai`: what the account route needs. It asks for no
Git audience and no `folders:*` scope, so its token cannot reach a
repository (`platform/web-sign-in.postgres.test.ts` checks the Git host
refuses it). Signing in or out merges the endpoints again and changes no file.

## Deleting

`deletion.ts` captures what a deletion removes from what the lists show, for
the person to confirm, then deletes exactly that. A recording takes its
transcripts, the transformation results made from them, its note, then its
audio. It is refused while a run for it is under way and while any
transcript or transformation result does not read. A run that finds its
recording being deleted sends nothing. Deleting a transformation keeps its
results; a result or a note that does not read goes alone.

## Status and closing

The header's status line (`status.ts`) says where the recordings are kept,
"On this browser"; an answer not saved outranks it.

`dispose` refuses new work and late answers, releases a test microphone, and
revokes held recordings' URLs; it waits for nothing. A recording under way
ends with the page.

## Tests

`bun run test` runs under Svelte's browser runtime (`--conditions=browser`
with `packages/svelte/src/svelte-dom.test-support.ts`), since `fromClient`
notifies nothing on the server runtime. `services.test-support.ts` opens a
`/node` device client over a temporary directory, as the browser's OPFS
holds it, with stubbed endpoints; `whispering.test-support.ts` makes the app
as `WhisperingApp` does and follows its lists. `e2e/` is the Playwright
suite over the shared stack (`packages/cli/src/app-stack.test-support.ts`).
