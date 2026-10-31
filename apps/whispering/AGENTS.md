# Whispering App

Whispering's web build is its local variant: it runs in a browser tab and
keeps recordings, transcripts, transformations, and results as the
`whispering` contract's files (`src/lib/contract.ts`) in this browser's
storage, for good. Nothing syncs, uploads, or moves to a repository
([ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)).
Signing in with Epicenter is optional and grants capabilities only. Its
desktop app is built separately later
([ADR-0701](../../docs/adr/0701-apps-run-as-separate-programs.md)), with its
own store. Read `README.md` for behavior and `ARCHITECTURE.md` for
structure.

## Constraints

- **One store, chosen in one place.** The device is opened in
  `src/lib/device.ts` and chosen only by the variant's root,
  `src/routes/(local)/+layout.svelte`, which passes it to `WhisperingApp`
  as `client`. Components read and edit through `library.files` and
  `fieldEdit`, never a client of their own, so a later variant passes its
  own client and changes nothing below its root.
- **Sign-in grants capabilities, never storage.** It asks for the API
  audience and `ai` only (`src/lib/platform/auth.ts`). Do not add a Git
  audience, a `folders:*` scope, `openRemote`, `setRepo`, an uploader, an
  outbox, a cache of uploaded audio, a repository view, or a switcher.
  Nothing a sign-in or sign-out does touches the files.
  `src/lib/page-boundary.test.ts` enforces this; keep it passing.
- **No migration or compatibility code** (decision 72). Nothing reads an
  earlier build's IndexedDB folder or Yjs store. Do not reintroduce
  `openFolder`, `svelteFolder`, `defineTable`, `@epicenter/svelte/folder`, a
  second store, or a cache of notes.
- **Capabilities through the seam.** Capture, inference, connections and
  preferences come from `#platform/services`, auth from `#platform/auth`
  (`src/lib/platform/`). Nothing under `src/` imports Node, Bun, or Tauri.
- **One mounted app lifetime per page.** `WhisperingApp` makes Whispering
  and its library once; route changes and sign-in keep them. Keep product
  state out of module-level variables. `dispose` refuses new work and late
  replies and waits for nothing; a recording under way ends with the page.
- **A recording is kept at Stop as two writes:** its audio, then its note,
  so a note never names audio that is not there. Its note holds facts only:
  never add a status, pending, or interrupted field. Store no audio path in
  a note: the audio is `recordings/<id>.<ext>`; refuse ambiguous matches. A
  recording the browser cannot keep stays in the page to save again or
  download.
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
stack; port 1420 must be free). `bun run test:postgres` checks the sign-in
against a real authorization server. Unit tests open a `/node` device
client over a temporary directory and a library over it. Only the
end-to-end suite, or using the app, establishes that it works in a browser.
