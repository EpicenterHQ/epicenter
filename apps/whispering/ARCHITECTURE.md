# Whispering architecture

Whispering is a page that runs in a browser tab. Its data is the `whispering`
contract's files (`src/lib/contract.ts`): five note collections and the audio
beside each recording. It reads and writes them only through the contract's
typed client, in two views that are never merged (decision 76): "On this
device", over this browser's device, always there, and "Synced", over the
person's repository, signed in. Whispering's own desktop app is a later step;
see the README.

```text
src/lib/contract.ts          the contract (published as static/contract.json)
src/lib/device.ts            this browser's device: openDevice(whispering), OPFS
src/lib/files.svelte.ts      one view's files: one client's note lists, and its audio
src/lib/whispering.svelte.ts what both views share: services, connections, microphone, recorder
src/lib/library.svelte.ts    one view's state over its files: lists, selection, runs, deletion
src/lib/platform/            capture, inference, connections, sign-in (#platform/*)
src/routes/                  the root, the signed-in boundary, the two views and their pages
```

## The roots

`routes/+layout.svelte` renders `WhisperingRoot` for every route but the
sign-in callback, which finishes sign-in and loads the page it started from,
so a page lifetime is one account.

- `lib/device.ts` opens the device once for the page, a module singleton
  (`export const device = openDevice(whispering)`).
- `WhisperingRoot.svelte` installs the leave guard and reads `getAuth()`.
  Signed out, it renders `WhisperingApp`. Otherwise, under
  `{#key auth.state.account}`, it renders `SignedIn` around `WhisperingApp`,
  so the signed-in boundary wraps every page and the uploader runs on any.
- `SignedIn.svelte` is the signed-in boundary: it opens the repository,
  `openRemote(whispering, { account })` (`<account>/whispering`, decision
  46), sets it in context (`setRepo` from `@epicenter/svelte/repo`), starts
  `startUploading(device, repository)`, and disposes the uploader when it
  leaves. Sign-out or another account retires the account, which stops its
  requests and its uploader and clears what its uploads cached.
  `reauth-required` keeps the subtree and pauses requests.
- `WhisperingApp.svelte` makes what both views share once,
  `createWhispering({ device })`: the services, the connections, the
  microphone and the recorder. It puts it in context (`setWhispering`),
  awaits `start()` (connections and the saved microphone), and disposes it
  when it leaves.

## The two views

Each view is a route tree with the same three pages: `routes/(device)/`
("On this device": `/`, `/recordings`, `/transformations`) and
`routes/synced/` ("Synced": `/synced`, `/synced/recordings`,
`/synced/transformations`). Each page route renders a page component
(`HomePage`, `RecordingsPage`, `TransformationsPage`) that reads its view
from context. Nothing merges or routes between the views: a file uploading
leaves this device's view and appears in the repository's, and no code
holds it on screen across the move. A merged view may come back later.

- `(device)/+layout.svelte` renders `WhisperingView view="device"`.
- `synced/+layout.svelte` renders `WhisperingView view="synced"` signed in,
  and a sign-in prompt signed out. The root renders it anew when the account
  changes, so it reads the account once.
- `WhisperingView.svelte` composes the view's files, `deviceFiles(device)` or
  `syncedFiles(getRepo(), device)` (`files.svelte.ts`), makes its library,
  `createLibrary({ whispering, files })`, puts it in context (`setLibrary`),
  and renders the frame: sidebar or bottom bar, and the header, with the
  "Views" links ("On this device", "Synced", to the same page in the other
  view) and the status line (`status.ts`).

A library lives while its view's pages are open. Leaving the view disposes
it and refuses nothing: a run under way still keeps its answer in that view's
files, unless Whispering itself is closing.

`src/lib/page-boundary.test.ts` pins this: `openDevice` only in `device.ts`;
`openRemote`, `setRepo` and `startUploading` only in `SignedIn`;
`createWhispering` only in `WhisperingApp`; `createLibrary`,
`deviceFiles`, `syncedFiles` and `getRepo` only in `WhisperingView`;
`fromClient` only in `files.svelte.ts`; `saveCapture` only in the recorder;
services only through `#platform/services`; nothing from Node, Bun or Tauri;
and no use of the retired folder and table API (`openFolder`, `svelteFolder`,
`defineTable`, `@epicenter/svelte/folder`) anywhere, tests included.

## One view's files

`files.svelte.ts` gives a view one client's note collections
(`fromClient(client).<collection>`) and its recordings' audio. The library
sorts each list (`newest`, `byTitle`). Each list lists and listens only while
something reactive reads it; a read outside an effect is a snapshot.

- Views edit fields with `fieldEdit(library.files.<collection>, { id },
  field)`: a save over what the person saw when typing began, so another
  writer's change to another field is kept and a change to the same field
  surfaces as a conflict.
- A note that does not read is in the list's `invalid`, with its issues and
  text; `library.repairs` gathers those of recordings, transcriptions and
  transformation runs, and the transformations page shows its own and text
  runs'. `replace` repairs one from text.

Audio is a file collection, `recordings/{id}.{ext}`. `files.audioOf(id)`
answers `here` with one file (its version, and whether this browser's cache
holds it), `ambiguous` for more than one extension, `absent`, `listing`, or
`unreachable` (the repository cannot be listed and nothing is cached).
`files.readAudio(id)` reads it: on this device, the device's file; in
"Synced", the device's cache (`cacheOf(device)`, checked against the
repository's version when listed, decision 66, and read again whenever the
repository's audio or this device's changes), then the repository (an LFS
download). Offline, what the cache holds still reads. Only audio an upload
let go of is cached; a download is not.

## Recording

The capture device comes from the services (`platform/browser.ts`): the
WebView microphone (`webview-microphone.ts` over `@epicenter/recorder`'s
browser recorder) or, under `?fixture=tone` in a dev build or one built with
`VITE_WHISPERING_FIXTURES=1`, a generated tone recorded by the same recorder.
The recorder asks for AAC in MP4 first and Opus in WebM second, and names the
file by the type it produced (`m4a` or `webm`).

Start opens the chosen microphone; nothing is kept while it records. Stop
releases it and answers the audio, and the recorder keeps it with
`saveCapture` (`@epicenter/folder/browser`): the audio, then the note (`title`
from the start time, `recordedAt`, `durationMs`, `capture`), then one outbox
entry naming both, so they upload together. A recording is always kept on the
device, signed in or not, so it never waits on the network; it shows under
"On this device" until it uploads, then under "Synced". One the
device refuses is held in the page (`unsavedRecordings`) with its reason and
an object URL to download; `saveRecordingAgain` runs the same save, which
picks up what an earlier attempt kept.

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
answer arrives the result note is created with every field fixed and the
answer as its body, so a result note always holds an answer.

- A run belongs to the view it was asked from, and its result note is
  created in that view's files.
- Transcription reads the audio through `files.readAudio` only once the
  connection is known to be the one prepared for (`transcription.ts`).
- A recipe run sends what the view shows (the recipe and transcript text,
  typing included) or else the notes as listed. `recipe.ts`'s `resolveRecipe`
  is the one decision whether a recipe can run and with what; the Run button,
  the post-processing choice, the Transform menu, and the run all ask it.
- The transcript is never written by a transformation. A result records the
  exact prompt and input it sent.

## Connections

`connections.ts` holds the pure rules; `platform/browser.ts` applies them to
`localStorage['whispering.connections']`. Each operation is a custom
connection (base URL, model, optional key) or the Epicenter account
(`account.fetch` to the API). A prepared request names the base URL it was
prepared for and is refused if the connection moved. Keys never reach
Whispering's files or logs. `settings-draft.svelte.ts` is the one draft of the
Settings form, shared by the header popover and the transcription control.

## Deleting

`deletion.ts` captures what a deletion removes from what the lists show, for
the person to confirm, then deletes exactly that. A recording takes its
transcripts, the transformation results made from them, its note, then its
audio, in the view's files (repository deletes are online only). It is
refused while a run for it is under way and while any transcript or
transformation result does not read. A run that finds its recording being
deleted sends nothing. Deleting a transformation keeps its results; a result
or a note that does not read goes alone.

## Status and closing

The header's status line (`status.ts`) says what the open view shows: "On
this device"; or "Synced", "Offline" when the repository cannot be listed,
or "Sign in again". An answer not saved outranks these.

`dispose` refuses new work and late answers, releases a test microphone, and
revokes held recordings' URLs; it waits for nothing. A recording under way
ends with the page.

## Tests

`bun run test` runs under Svelte's browser runtime (`--conditions=browser`
with `packages/svelte/src/svelte-dom.test-support.ts`), since `fromClient`
notifies nothing on the server runtime. `services.test-support.ts` opens two
`/node` device clients over temporary directories, this browser's and a
stand-in for the repository (a `Client<Whispering>` is all a view needs),
with stubbed endpoints; `whispering.test-support.ts` makes the app as
`WhisperingApp` and `WhisperingView` do, one library per view, and follows
their lists. `e2e/` is the Playwright suite
over the shared stack (`packages/cli/src/app-stack.test-support.ts`).
