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
src/lib/whispering.svelte.ts services, connections, microphone, recorder
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
  which opens the store and hands its client to `<WhisperingApp {client}>`:
  `LocalStartup` awaits this browser's device; `DesktopStartup` awaits the
  AppData root and the data folder, or renders the recovery screen. Its
  pages are `/`, `/recordings` and `/transformations`.
- `routes/auth/callback/` is outside the group, so it opens no files: it
  renders the build's `Callback`, which finishes a web sign-in and loads the
  page it started from.
- `WhisperingApp.svelte` takes the client as a prop. It makes
  `createWhispering({ client })` (the services, the connections, the
  microphone and the recorder) and
  `createLibrary({ whispering, files: filesOf(client) })`, puts both in
  context (`setWhispering`, `setLibrary`), awaits `start()` (connections
  and the saved microphone), renders the frame (sidebar or bottom bar, and
  the header with its status line), and disposes both when it leaves.

Nothing below `WhisperingApp` knows which store it is; where only a
sentence differs, a component reads `variant` from `#platform/variant`.

Each page route renders a page component (`HomePage`, `RecordingsPage`,
`TransformationsPage`) that reads the library from context. Changing pages
keeps everything in progress, and a run under way still keeps its answer in
the files unless Whispering itself is closing.

`src/lib/page-boundary.test.ts` pins this: `openDevice` only in
`LocalStartup`, `openDataFolder` only in `DesktopStartup`; nothing
calls `openRemote`, `setRepo` or `getRepo`, or imports
`@epicenter/folder/remote` or `@epicenter/svelte/repo`; `createWhispering`,
`filesOf` and `createLibrary` only in `WhisperingApp`; `fromClient` only in
`files.svelte.ts`; auth only through `#platform/auth`; services only through
`#platform/services`; nothing from Node or Bun, Tauri only in the desktop
leaves; and no use of the
retired folder and table API (`openFolder`, `svelteFolder`, `defineTable`,
`@epicenter/svelte/folder`) anywhere, tests included.

## The files

`files.svelte.ts` gives the pages one client's note collections
(`fromClient(client).<collection>`) and its recordings' audio. The library
sorts each list (`newest`, `byTitle`). Each list lists and listens only while
something reactive reads it; a read outside an effect is a snapshot.

- Pages edit fields with `fieldEdit(library.files.<collection>, { id },
  field)`: a save over what the person saw when typing began, so another
  writer's change to another field is kept and a change to the same field
  surfaces as a conflict.
- A note that does not read is in the list's `invalid`, with its issues and
  text; `library.repairs` gathers those of recordings, transcriptions and
  transformation runs, and the transformations page shows its own and text
  runs'. `replace` repairs one from text.

Audio is a file collection, `recordings/{id}.{ext}`. `files.audioOf(id)`
answers `here` with one file (its extension and version), `ambiguous` for
more than one extension, `absent`, or `listing`. `files.readAudio(id)` reads
it through the client.

## Recording

The capture device comes from the services (`#platform/services`), and
every one writes the recording into the client's files as it records
(decision 84), through `@epicenter/recorder`'s one API,
`startRecording({ device, path })` and `recoverRecordings({ device, under })`
(`microphone.ts`, `createMicrophoneDevice`). In a browser
(`platform/browser.ts`) it is the WebView microphone
(`webview-microphone.ts`, over `@epicenter/recorder/browser`) or, under
`?fixture=tone` in a dev build or one built with
`VITE_WHISPERING_FIXTURES=1`, a generated tone recorded the same way; the
recorder asks for AAC in MP4 first and Opus in WebM second, and appends each
piece (about a second) to `recordings/<id>.m4a` or `.webm` in this browser's
files as it arrives. On the desktop it is the shell's microphone
(`platform/microphone.tauri.ts`, over `@epicenter/recorder/tauri`), which
writes `recordings/<id>.wav` from the first sample.

Start makes the recording's note first (`client.recordings.create`: `title`
from the start time, `recordedAt`, `capture`), then opens the chosen
microphone; a microphone that does not open takes the note with it. Stop
releases the microphone and writes `durationMs` into the note over the
version it reads then (`folder-recordings.ts`). A recording that wrote no
audio (the store refused it, or nothing was captured) leaves no note.
Recording never waits on the network. Where the browser keeps no files (a
private window) the note cannot be made, so recording is refused before
any microphone opens. When a start finds a note with no length beside its
audio (what a quit, a crash, or a closed tab cut off), it first repairs the
audio (`capture.recover()`: a WAV header on the desktop; an `m4a` or `webm`
cut back to its last whole piece in a browser, skipping one another tab is
still writing) and then completes the note from it (`audioDurationMs`).
Nothing is read for repair when nothing was cut off.

The microphone choice, its test, and Enable microphones belong to
`microphone-input.svelte.ts`: one owner of at most one open microphone,
released by choosing, recording, or closing. The choice is kept in
`localStorage` (`microphone-preference.ts`).

## Requests and results

`runs.svelte.ts` owns transcriptions and recipe runs. A run is keyed by what
it runs on (`transcriptions:<recording>`, `transformation_runs:<transcript>:<recipe>`,
`text_runs:<recipe>`), so the same run does not go twice at once, and gets its
result's id (`timeId`) when it starts. Its state lives in this window:
`running`, `failed` (Run again resends the same request while the connection
is still the one it was made for), or `unsaved` (the answer arrived; its note
is being created, or why it was not; Save again creates it with the same id
and sends nothing, and `Occupied` means an earlier save landed). When the
answer arrives the result note is created in the files with every field
fixed and the answer as its body, so a result note always holds an answer.

- Transcription reads the audio through `files.readAudio` only once the
  connection is known to be the one prepared for (`transcription.ts`).
- A recipe run sends what the page shows (the recipe and transcript text,
  typing included) or else the notes as listed. `recipe.ts`'s `resolveRecipe`
  is the one decision whether a recipe can run and with what; the Run button,
  the post-processing choice, the Transform menu, and the run all ask it.
- The transcript is never written by a transformation. A result records the
  exact prompt and input it sent.

## Connections and sign-in

`connections.ts` holds the pure rules; `platform/browser.ts` applies them to
`localStorage['whispering.connections']`. Each operation is a custom
connection (base URL, model, optional key; a local endpoint or a provider)
or the Epicenter account (`account.fetch` to the API's `/v1`). A prepared
request names the base URL it was prepared for and is refused if the
connection moved. Keys never reach Whispering's files or logs.
`settings-draft.svelte.ts` is the one draft of the Settings form, shared by
the header popover and the transcription control.

Signing in is optional and lives in Settings (`AccountStatus.svelte`). The
OAuth client (`platform/auth.ts`) asks for one resource, the API audience,
with `openid profile email ai`: what the account route needs. It asks for no
Git audience and no `folders:*` scope, so its token cannot reach a
repository (`platform/web-sign-in.postgres.test.ts` checks the Git host
refuses it). Signing in or out re-reads the connections and changes no file.

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
