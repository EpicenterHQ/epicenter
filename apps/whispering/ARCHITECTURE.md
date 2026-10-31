# Whispering architecture

Whispering is a page that runs in a browser tab. Its data is the `whispering`
contract's files (`src/lib/contract.ts`): five note collections and the audio
beside each recording. It reads and writes them only through the contract's
typed client, on two sides: this browser's device, always there, and, signed
in, the person's repository. Whispering's own desktop app is a later step; see
the README.

```text
src/lib/contract.ts          the contract (published as static/contract.json)
src/lib/device.ts            this browser's device: openDevice(whispering), OPFS
src/lib/files.svelte.ts      the files as lists: one oneList per collection, audio across sides
src/lib/whispering.svelte.ts product state over the files: views, recording, runs, deletion
src/lib/platform/            capture, inference, connections, sign-in (#platform/*)
src/routes/                  the root, the signed-in subtree, the pages and views
```

## The roots

`routes/+layout.svelte` renders `WhisperingRoot` for every route but the
sign-in callback, which finishes sign-in and loads the page it started from,
so a page lifetime is one account.

- `lib/device.ts` opens the device once for the page, a module singleton
  (`export const device = openDevice(whispering)`).
- `WhisperingRoot.svelte` reads `getAuth()`. Signed out, it renders
  `WhisperingApp signedIn={false}`. Otherwise, under
  `{#key auth.state.account}`, it renders `SignedIn` around
  `WhisperingApp signedIn`.
- `SignedIn.svelte` is the signed-in boundary: it opens the repository,
  `openRemote(whispering, { account })` (`<account>/whispering`, decision
  46), sets it in context (`setRepo` from `@epicenter/svelte/repo`), starts
  `startUploading(device, repository)`, and disposes the uploader when it
  leaves. Sign-out or another
  account retires the account, which stops its requests and its uploader and
  clears what its uploads cached. `reauth-required` keeps the subtree and
  pauses requests.
- `WhisperingApp.svelte` makes the product state once,
  `createWhispering({ device, repository })` with `repository` from
  `getRepo()` signed in and null signed out, puts it in context
  (`setWhispering`), awaits `start()` (connections and the saved microphone),
  and disposes it when it leaves. Pages and views read state from context
  (`getWhispering`) and never open a client.

`src/lib/page-boundary.test.ts` pins this: `openDevice` only in `device.ts`,
`openRemote`, `setRepo` and `startUploading` only in `SignedIn`, `createWhispering` only
in `WhisperingApp`, services only through `#platform/services`, nothing from
Node, Bun or Tauri, and no use of the retired folder and table API
(`openFolder`, `svelteFolder`, `defineTable`, `@epicenter/svelte/folder`)
anywhere, tests included.

## The files as lists

`createWhispering` composes each note collection directly: signed out, the
device's own (`fromClient(device).<collection>`); signed in, one `oneList`
per collection (`@epicenter/svelte/client`): the notes still on the device
("not uploaded yet") and the repository's as one `ReactiveNotes`. It sorts
each with its order from `files.svelte.ts` (`newest`, `byTitle`). Each list
lists and listens only while something reactive reads it; a read outside an
effect is a snapshot.

- Signed in, `where({ id })` says `'device' | 'repository'`. Writes go to
  the copy shown; a write that meets a device copy the upload already let go
  of follows the note to the repository.
- `create` goes to the repository when there is one and it answers, else to
  the device, recorded in the device's outbox (`outboxOf(device)`) to
  upload (decision 12).
- Views edit fields with `fieldEdit(whispering.files.<collection>, { id },
  field)`: a save over what the person saw when typing began, so another
  writer's change to another field is kept and a change to the same field
  surfaces as a conflict.
- A note that does not read is in the list's `invalid`, with its issues,
  text and side; `whispering.repairs` gathers those of recordings,
  transcriptions and transformation runs, and the transformations page
  shows its own and text runs'. `replace` repairs one from text.

Audio is a file collection, `recordings/{id}.{ext}`, so it has no `oneList`;
`createAudio({ device, repository })` (`files.svelte.ts`) reads it across
both sides, and `files` is the lists and those reads together.
`files.audioOf(id)` merges the repository's listed audio, the device's (which
wins while both hold it, mid-upload), and, signed in, the device's cache
(`cacheOf(device)`, read again whenever either side's audio changes). It
answers `here` with one file and where it is, `ambiguous` for more than one
extension, `absent`, `listing`, or `unreachable` (only the repository may hold
it, and it cannot be listed). `files.readAudio(id)` reads the nearest copy:
the device, then the cache (checked against the repository's version when
listed, decision 66), then the repository (an LFS download). Only audio an
upload let go of is cached; a download is not.

## Recording

The capture device comes from the services (`platform/browser.ts`): the
WebView microphone (`webview-microphone.ts` over `@epicenter/recorder`'s
browser recorder) or, under `?fixture=tone` in a dev build or one built with
`VITE_WHISPERING_FIXTURES=1`, a generated tone recorded by the same recorder.
The recorder asks for AAC in MP4 first and Opus in WebM second, and names the
file by the type it produced (`m4a` or `webm`).

Start opens the chosen microphone; nothing is kept while it records. Stop
releases it and answers the audio, and `files.saveRecording` keeps it with
`saveCapture` (`@epicenter/folder/browser`): the audio, then the note (`title`
from the start time, `recordedAt`, `durationMs`, `capture`), then one outbox
entry naming both, so they upload together. A recording is always kept on the
device first, signed in or not, so it never waits on the network. One the
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
audio, on whichever side each is (repository deletes are online only). It is
refused while a run for it is under way and while any transcript or
transformation result does not read. A run that finds its recording being
deleted sends nothing. Deleting a transformation keeps its results; a result
or a note that does not read goes alone.

## Status and closing

The header's status line (`status.ts`) says where the files are: in this
browser signed out, how many are not uploaded yet, in the repository, or the
repository unreachable; an answer not saved outranks all of these.

`dispose` refuses new work and late answers, releases a test microphone,
revokes held recordings' URLs, and stops following the lists; it waits for
nothing. A recording under way ends with the page.

## Tests

`bun run test` runs under Svelte's browser runtime (`--conditions=browser`
with `packages/svelte/src/svelte-dom.test-support.ts`), since `fromClient`
notifies nothing on the server runtime. `services.test-support.ts` opens two
`/node` device clients over temporary directories, this browser's and a
stand-in for the repository (a `Client<Whispering>` is all the lists need),
with stubbed endpoints; `whispering.test-support.ts` makes the app as
`WhisperingApp` does and follows its lists. `e2e/` is the Playwright suite
over the shared stack (`packages/cli/src/app-stack.test-support.ts`).
