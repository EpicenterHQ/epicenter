# Whispering App

Whispering has two variants (decision 77), the same pages over the
`whispering` contract's files (`src/lib/contract.ts`): the web build, which
keeps them in this browser's storage for good, and the desktop app
(`src-tauri/`), which keeps them in a data folder on the computer that
Epicenter may sync. Nothing syncs, uploads, or moves between stores
([ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)).
Signing in with Epicenter is optional and grants capabilities only. Read
`README.md` for behavior and `ARCHITECTURE.md` for structure.

## Constraints

- **One store, chosen in one place.** `src/lib/app.ts` opens it,
  `openFolder(whispering, home({ site }))`, whose place the build picks (this browser's
  storage on the web, the data folder on the desktop, memory under `test`),
  and `src/routes/(app)/+layout.svelte` renders the app over it and this
  computer's settings with `<WhenOpen>`, so every read inside is
  synchronous; do not add a ready, loading, or start gate. Components read
  through the library (`getLibrary`) and edit
  a note through the folder (`folder.recordings.edit({ id })`), never a
  store of their own.
- **The build chooses the variant.** Everything that differs is a
  `#platform/*` leaf (`account`, `computer`, `components`, `variant`; `*.tauri.ts`
  and `components/Desktop*.svelte` for the desktop). No runtime
  `isTauri()` branching. Leaves and what they import use relative imports,
  not `$lib`, so `src/lib/platform/platform.test.ts` can bundle them.
- **Sign-in grants capabilities, never storage.** It asks for the API
  audience and `ai` only (`src/lib/platform/account.ts`), and `app.ts`
  gives `home` no account. Do not add a Git
  audience, a `folders:*` scope, an uploader, a cache of uploaded audio, a
  repository view, or a switcher.
  Nothing a sign-in or sign-out does touches the files.
  `src/lib/page-boundary.test.ts` enforces this; keep it passing.
- **The folder keeps writes until they land; Whispering holds none.** A
  write (`set`, `delete`, an editor's save) answers once it has landed and
  never fails while the folder lives (ADR-0775): while the store is out of
  reach the folder keeps it, in order, and `<WhenOpen>` says so; when the
  folder fails or closes it rejects with `FolderClosed`. Await a write where order
  matters (a recording's audio, then its note). Do not add an outbox, a
  failed-write state, or anything else that keeps a note, an answer, or a
  recording in the page to save again.
- **No migration or compatibility code** (decision 72). Nothing reads an
  earlier build's IndexedDB folder or Yjs store. Do not add a second store
  or a cache of notes.
- **Capabilities through the seam.** What differs by build in capture, the
  models on this computer and the shortcut comes from `#platform/computer`,
  the sign-in from `#platform/account` (`src/lib/platform/`), and `app.ts`
  alone makes the capabilities from them. Nothing under `src/` imports Node
  or Bun, and only the desktop leaves import Tauri.
- **Capabilities are module values; product state is the app's own.**
  `src/lib/app.ts` exports the capabilities (`folder`, `account`, `ai`,
  `choices`, `settings`, `speech`, `recorder`, `shortcut`) as module values opened once
  per page, with no `await` and no hot-reload lines, and code imports them
  rather than receiving them through context
  ([ADR-0766](../../docs/adr/0766-an-apps-capabilities-are-module-values-opened-synchronously.md)).
  Product state lives in Whispering's own objects, created
  once: `WhisperingApp` makes Whispering and its library over those
  capabilities, and route changes and sign-in keep them. Keep other product state out of module-level
  variables. `dispose` refuses new work and late replies and waits for
  nothing; a recording under way ends with the page.
- **A recording's note is written once, after Stop, when its audio is at
  its path** (on the desktop, once the shell has encoded it), so a note
  never names audio that is not there and the library never lists a take in
  progress. A browser keeps a take in memory until Stop, so a crash or a
  closed tab loses it; do not add streaming writes, locks, or recovery to
  the web build (ADR-0780). On the desktop, audio a quit or a crash left
  without a note gets one on the next launch, in the background
  (`finishCutOffRecordings` in `folder-recordings.ts`); do not add another
  path that writes a recording's note. Its note holds facts only:
  never add a status, pending, or interrupted field. Store no audio path in
  a note: the audio is `recordings/<id>.<ext>`; refuse ambiguous matches.
- **A result is written when its answer arrives,** under an id fixed when
  the run starts, so its write never calls the endpoint again or makes a
  second note. A transformation never writes its transcript. A result on
  pasted text names no recording and never takes part in deleting one.
- **A lost reply is not a refusal.** When an answer never arrives, report the
  outcome as unknown, never as "not sent", and never send a provider request
  again without the person asking.
- **Provider requests are explicit.** Nothing is sent at launch or after a
  recording without the person asking; post-processing is a button.
- **A key never reaches the files.** The model choices, connections and
  microphone are this computer's settings (`@epicenter/local`: AppData on
  the desktop, `localStorage` on the web). A key is never in
  `connections.md`: on the web it is in `connection-keys.json`, on the
  desktop in the app's `credentials.json`, which only the shell reads. A key is never logged
  or written, including inside an error message. A request goes only to the
  endpoint it was prepared for, and only while it is still at the address it
  had then; nothing falls back to another.
- **Recordings keep their names.** A note's name is its file name
  (ADR-0776), and Whispering names every note by a `timeId()` stem (the
  `id` placeholder). Results point at a recording by that name, so never
  rename a recording's files; change its title.
- **Every recording is a microphone take.** Tests fake the microphone in
  their own support code (the e2e suite's `fakeMicrophone`, the unit tests'
  fixture device); the product has no stand-in for it.
- Use wellcrafted `Result` types instead of try-catch for expected failures.

## Checks

From `apps/whispering`: `bun run typecheck` (both builds' leaves),
`bun run test` (Svelte's browser runtime; the lists notify nothing on the
server runtime), `bun run build`, `cargo test -p whispering` (after
`bun run build:native`),
and `bun run test:e2e` (Playwright in Chromium and WebKit over the local
stack; port 1420 must be free). `bun run test:postgres` checks the sign-in
against a real authorization server. Unit tests run under the `test`
condition, where `app.ts`'s folder and this computer's settings are memory;
Whispering's own tests open a place in memory (`memory()` from
`@epicenter/folder/memory`) and a folder and library over it. Only the
end-to-end suite, or using the app, establishes that it works in a browser.
