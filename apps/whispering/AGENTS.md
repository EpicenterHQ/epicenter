# Whispering App

Whispering runs in a browser tab; its own desktop app is a later step
([ADR-0701](../../docs/adr/0701-apps-run-as-separate-programs.md)).
Recordings, transcripts, transformations, and results are the `whispering`
contract's files (`src/lib/contract.ts`), shown in two views that are never
merged (decision 76): "On this device", this browser's files, and "Synced",
the person's repository, signed in. Read `README.md` for behavior and
`ARCHITECTURE.md` for structure.

## Constraints

- **Files through the contract's client only.** The device is opened in
  `src/lib/device.ts`; the repository and its uploader only in `SignedIn`.
  Each view composes one client's files in `WhisperingView`
  (`deviceFiles` or `syncedFiles`), and components read and edit through
  `library.files` and `fieldEdit`, never a client of their own.
- **Two views, no merging.** Do not show both sides in one list, tag a note
  with where it is, count what is waiting to upload, or follow a note across
  its upload. A merged view may return later as its own decision. Do not reintroduce `openFolder`, `svelteFolder`,
  `defineTable`, `@epicenter/svelte/folder`, a second store, or a cache of
  notes. `src/lib/page-boundary.test.ts` enforces this; keep it passing.
- **No migration or compatibility code** (decision 72). Nothing reads an
  earlier build's IndexedDB folder or Yjs store.
- **Capabilities through the seam.** Capture, inference, connections and
  preferences come from `#platform/services`, auth from `#platform/auth`
  (`src/lib/platform/`). Nothing under `src/` imports Node, Bun, or Tauri.
- **One mounted app lifetime per account.** `WhisperingApp` makes what both
  views share once; route changes keep it. Each view's library lives while
  its pages are open; leaving it refuses nothing, so a run still keeps its
  answer. Keep product state out of module-level variables. `dispose`
  refuses new work and late replies and waits for nothing; a recording
  under way ends with the page.
- **A recording is kept at Stop, on the device, as one capture** (audio and
  note, `saveCapture`), signed in or not. Its note holds facts only: never add
  a status, pending, or interrupted field. Store no audio path in a note: the
  audio is `recordings/<id>.<ext>`; refuse ambiguous matches. A recording the
  device cannot keep stays in the page to save again or download.
- **Audio is read from the view's files:** the device's on this device; in
  "Synced", the cache (decision 66), then the repository. Only an upload
  fills the cache.
- **A result is created when its answer arrives,** with an id fixed when the
  run starts. Saving an answer again must not call the endpoint or create a
  second note. A transformation never writes its transcript. A result on
  pasted text names no recording and never takes part in deleting one.
- **A lost reply is not a refusal.** When an answer never arrives, report the
  outcome as unknown, never as "not sent", and never send a provider request
  again without the person asking.
- **Provider requests are explicit.** Nothing is sent at launch or after a
  recording without the person asking; post-processing is a button.
- **A key never reaches the files.** Connections, keys included, and the
  microphone choice stay in this site's `localStorage`. A key is never logged
  or written, including inside an error message. A request goes only to the
  base URL it was prepared for.
- **Ids are identity.** Never rename a note's file; change its title. Ids come
  from `timeId()`.
- **Fixture audio is for tests.** `?fixture=tone` works only in a dev build or
  one built with `VITE_WHISPERING_FIXTURES=1`, and its recordings say
  `capture: fixture`.
- Use wellcrafted `Result` types instead of try-catch for expected failures.

## Checks

From `apps/whispering`: `bun run typecheck`, `bun run test` (Svelte's browser
runtime; the lists notify nothing on the server runtime), `bun run build`,
and `bun run test:e2e` (Playwright in Chromium and WebKit over the local
stack; port 1420 must be free). Unit tests open two `/node` device clients
over temporary directories, one standing in for the repository, and a
library over each. Only the
end-to-end suite, or using the app, establishes that it works in a browser.
