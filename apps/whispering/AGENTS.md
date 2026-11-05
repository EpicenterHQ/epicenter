# Whispering App

Whispering has two variants (decision 77), the same pages from one build
over the `whispering` contract's files (`src/lib/contract.ts`): in a browser
the signed-in person's `whispering` repository, which the page keeps none
of
([ADR-0786](../../docs/adr/0786-every-web-app-is-online-and-browser-storage-leaves-the-platform.md)),
and in the desktop app (`src-tauri/`) a data folder on the computer that
Epicenter may sync. Whispering itself moves nothing between stores
([ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)).
On the web the sign-in holds the recordings; in the desktop app it is
optional and adds Epicenter's models. Read `README.md` for behavior and
`ARCHITECTURE.md` for structure.

## Constraints

- **One store, chosen in one place.** `src/lib/app.ts` opens it,
  `openFolder(whispering, home({ site, account }))`, whose place `home`
  picks where the page runs (the account's repository in a browser, the
  data folder in a Tauri window, memory under `test`),
  and `src/routes/(app)/+layout.svelte` renders the app over it and this
  computer's settings with `<WhenOpen>`, or `SignIn` over a signed-out
  repository, so every read inside is
  synchronous; do not add a ready, loading, or start gate. Components read
  through the library (`getLibrary`) and edit
  a note through the folder (`folder.recordings.edit({ id })`), never a
  store of their own.
- **Branch on what a capability offers, never on the platform**
  ([ADR-0781](../../docs/adr/0781-apps-branch-on-what-a-capability-offers-and-one-build-serves-every-surface.md)).
  One build serves the browser and the Tauri window. A capability a
  surface cannot give is `null` there (`speech`, `shortcut`), and a view
  shows it only where it is (`{#if shortcut}`); where the store matters, a
  view reads `folder.reveal` (`FolderChrome` or `RepositoryChrome`,
  `FolderSettings`). Only `src/lib/shortcut.ts` calls `isTauri()` or
  imports Tauri, and it loads the shell's event code when it listens; a
  static import of a desktop module from shared code puts it in the web's
  first load, which `scripts/first-load.test.ts` refuses.
- **The browser keeps nothing.** No service worker, no browser store of
  notes or audio, no uploader of its own, and no cache of uploaded audio: a
  take goes to the repository through the folder at Stop. Sign-in and
  sign-out never touch the files. `src/lib/page-boundary.test.ts` enforces
  the page's boundaries; keep it passing.
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
- **Capabilities come from their packages.** The recorder, the models on
  this computer and the sign-in come from `@epicenter/recorder`,
  `@epicenter/ai`, `@epicenter/transcription` and `@epicenter/account`,
  each of which decides where the page runs, and `app.ts` alone makes the
  capabilities from them. Nothing under `src/` imports Node or Bun.
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
  closed tab loses it; do not add streaming writes, locks, or recovery in
  a browser (ADR-0779, ADR-0780). On the desktop, audio a quit or a crash left
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

From `apps/whispering`: `bun run typecheck`,
`bun run test` (Svelte's browser runtime; the lists notify nothing on the
server runtime), `bun run build`, `cargo test -p whispering` (after
`bun run build`),
and `bun run test:e2e` (Playwright in Chromium and WebKit over the local
stack; port 1420 must be free). `bun run test:postgres` checks the sign-in
against a real authorization server. Unit tests run under the `test`
condition, where `app.ts`'s folder and this computer's settings are memory;
Whispering's own tests open a place in memory (`memory()` from
`@epicenter/folder/memory`) and a folder and library over it. Only the
end-to-end suite, or using the app, establishes that it works in a browser.
