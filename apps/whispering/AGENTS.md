# Whispering App

Shared UI and workflows for Whispering bundled in Epicenter (ADR-0493,
ADR-0552) and for the browser build. Recordings, transcripts, and transformations
are files in one folder; those files are the data. Read `README.md` for current
behavior and delivery status, and `ARCHITECTURE.md` for structure.

## Constraints

- **Platform adapters own native capabilities.** Nothing under `src/`
  imports a Node or Bun module or `@epicenter/folder/next/bun`. The page names
  the folder contract through `@epicenter/folder/next`. The layout gives
  `<OpenFolder>` its sole inline opener. The build aliases
  `@epicenter/folder/next` to the browser or Tauri entry. Platform capabilities
  live in `src/lib/platform/` and never open another folder. Other native
  services use Epicenter's generated bindings
  (`src/lib/tauri/bindings.gen.ts`), imported only by the desktop adapter. The build
  picks platform capabilities through `#platform/services` (ADR-0391); no page code
  asks where it runs. `src/lib/page-boundary.test.ts` enforces
  these boundaries; keep it passing without granting native reach to components.
- **One folder, one opener.** Inside Epicenter the shell binds one folder to
  each Whispering window before it exists, `Whispering` by default, a listed
  folder opened with "Open with…", or one chosen in the native picker, and the
  page's folder mirror (`@epicenter/folder/next/tauri`) is the only thing that
  opens it. The page names no folder. Do not add a second path by which the
  page reads or writes folder files, and do not copy the plugins' bindings
  into this app.
- **Close waits for writes; it never asks.** A desktop window's close waits
  for the folder's writes in flight, which answer in milliseconds, then
  closes. A recording alone closes without a warning. Epicenter always
  confirms application Quit and mentions active capture. Cancel keeps the
  windows, edits, and recording; confirmation leaves without draining page
  workflows. Rust finalizes and keeps captured audio on departure (ADR-0663).
  A browser recording adds no unload warning; `<OpenFolder>` asks on unload
  only while a write is out. A run writes its result row before the request
  goes out.
- **A folder that cannot be opened is reported, not replaced.** Opening
  returns a `Result`, and `<OpenFolder>` shows a refusal as that refusal.
  Inside a desktop app, a shell that refuses the folder is shown as that
  refusal; browser storage is never opened there. The build Epicenter serves
  carries no browser storage (`src/lib/platform-selection.test.ts`).
- **One mounted app lifetime.** Route changes preserve the opened folder,
  recording, inference work, selections, and forms. Pages consume existing
  resources; they never open a folder or create product state. Keep that
  state out of module-level variables. Product teardown synchronously refuses
  new work and late replies and releases listeners; it never drains workflows
  or calls Stop. `<OpenFolder>` owns the folder's lifetime: it closes the
  folder when it unmounts, sending what waits, and owns unload protection.
  Internal navigation keeps the app. `src/lib/page-boundary.test.ts` enforces
  this ownership; the composition is documented in `ARCHITECTURE.md`.
- **Native services are Epicenter's.** Whispering has no desktop shell or
  host process of its own (ADR-0493). A native service it needs is an
  Epicenter command, granted to Whispering's windows in
  `apps/epicenter/src-tauri/capabilities/whispering.json` (ADR-0570), and
  exposed through platform adapters with a browser
  implementation or an explicit `undefined`. Load the `tauri` skill before
  changing a grant. No other native service opens the folder or initializes
  Git for the page; a failed desktop acquisition is visible and
  never selects browser storage.
- **A lost reply is not a refusal.** When Epicenter does not answer, the page
  does not know whether the endpoint was called. Report it as unknown, never
  as "not sent", and never send a provider request again without the person
  asking. A stopped Epicenter host does not stop saving: do not tell the
  person it does.
- **Files are authoritative.** The folder mirror shows what landed on disk,
  and drafts (`draft` from `@epicenter/svelte/folder-next`) are the only state
  ahead of it: every text input bound to folder data uses one, one per editor
  component. Derive lists from the mirror's rows and files; do not add
  another save queue, cache, mirror, or second store of recordings, and keep
  no typed text in product state. Do not add Yjs, the `@epicenter/app` store,
  or accounts to this workflow.
- **Recording audio is a supported same-stem sibling of its Markdown file.**
  Store no audio path in recording metadata. Refuse ambiguous matches. Do not
  add alternate path readers or migrations. Deleting a row keeps its audio.
- **A saved status follows the folder.** The header says Saving… from
  `folder.saving` and Saved once nothing waits, beside the count of answers
  not written. A write that does not land is `<OpenFolder>`'s toast, with
  the text to copy; each failed editor draft also shows Save again, Discard,
  and Copy beside its input. The app adds no second toast and no per-file
  save line.
- **A recording is in the folder from its start, and its row holds facts
  only** (ADR-0543). The row is created when recording starts; explicit Stop
  writes its length while the page lives. Native departure preserves the WAV
  without promising length metadata. Never add a status, pending, or interrupted
  field, and never hold desktop audio in the page to save later: Rust writes it
  as it captures. Recorder commands never delete captured audio. Start
  creates the row with `folder.tables.recordings.create(id, { fields, body: '' })`;
  Stop awaits that create, then sets the length with
  `folder.tables.recordings.update(id, { fields: { durationMs } })`, which
  sets only what it names over the file as it is then. Never serialize row
  text by hand in the app.
- **Fixture audio is debug-only, and failure injection is test-only.** Fixture
  audio is a development browser build's, and the UI says so while it is
  active. No build offers failure injection; a test that fails a recording
  write makes storage refuse it below the folder (the memory host's control
  in `@epicenter/folder/next/testing`), so the folder fails it.
- **A transformation never writes its transcript.** A result has its own file
  with a stem fixed before the request is sent. Saving a received result again
  must not call the endpoint or create a second file. A result on pasted text
  names no recording and must never participate in recording deletion.
- **Inside Epicenter, a key stays in the keychain.** The connections are rows
  of Epicenter's selected records folder, which the page reads and saves only
  through `whispering_connection_read` and `whispering_connection_set`, by
  operation; it never opens the records directory as a second folder. Endpoints and
  keys are in this computer's keychain; requests go through the `epicenter` CLI (`ai_send`),
  which adds the key. A key is never returned to
  the page, logged, or written to the folder, including inside an error
  message.
- **Provider requests and settings saves are explicit.** No provider request
  leaves at launch or after a recording without the person asking. Missing
  settings stay in memory until an explicit settings save. App-maintained
  exclusions use the folder's ordinary read and write, preserving unrelated source; they
  do not initialize Git or send files. Create other folder files only for
  the person's actions.
- Do not rename a recording's or a transformation's files from the app: other
  rows refer to the stem.
- Use wellcrafted `Result` types instead of try-catch for expected failures.

## Checks

From `apps/whispering`: `bun run typecheck`, `bun run test` (which runs the
mounted views under the browser runtime after the rest), `bun run build`, and
`bun run build:host`. For a change to what Epicenter grants Whispering,
also `cargo test --manifest-path ../epicenter/src-tauri/Cargo.toml`. Tests
establish logic and what reaches disk. The TypeScript tests grant a real
directory through a scripted shell
(`packages/folder/src/granted-shell.test-support.ts`), open it with the Bun
opener (`@epicenter/folder/next/bun`), or open a folder over memory
(`@epicenter/folder/next/testing`) to hold or refuse a save; they never run
the Rust shell. Only opening Whispering in
`bun dev:epicenter` and using it establishes that the desktop app works.

`src/lib/tauri/bindings.gen.ts` is written by Epicenter's Rust tests. Do not
edit it here; the desktop adapter alone imports it.
