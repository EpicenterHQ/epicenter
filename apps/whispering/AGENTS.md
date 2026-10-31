# Whispering App

Whispering runs as a browser build; Epicenter no longer hosts it, and it has
no desktop shell of its own yet
([ADR-0701](../../docs/adr/0701-apps-run-as-separate-programs.md)).
Recordings, transcripts, and transformations
are files in one folder; those files are the data. Read `README.md` for current
behavior and delivery status, and `ARCHITECTURE.md` for structure.

## Constraints

- **Platform adapters own native capabilities.** Nothing under `src/`
  imports a Node or Bun module or `@epicenter/folder/bun`. The page names
  the folder contract through `@epicenter/folder`. The layout gives
  `<OpenFolder>` its sole inline opener. Platform capabilities live in
  `src/lib/platform/` and never open another folder. The page reaches them
  through `#platform/services` and `#platform/auth`, which package.json
  "imports" maps to the browser leaves; no page code asks where it runs. `src/lib/page-boundary.test.ts` enforces
  these boundaries; keep it passing without granting native reach to components.
- **One folder, one opener.** The page's folder mirror, opened by
  `<OpenFolder>`, is the only thing that opens the folder. Do not add a
  second path by which the page reads or writes folder files.
- **Unload waits for writes.** A recording adds no unload warning;
  `<OpenFolder>` asks on unload only while a write is out. A run writes its
  result row before the request goes out.
- **A folder that cannot be opened is reported, not replaced.** Opening
  returns a `Result`, and `<OpenFolder>` shows a refusal as that refusal.
  The browser folder refuses to open inside a Tauri window
  (`src/lib/platform-selection.test.ts`).
- **One mounted app lifetime.** Route changes preserve the opened folder,
  recording, inference work, selections, and forms. Pages consume existing
  resources; they never open a folder or create product state. Keep that
  state out of module-level variables. Product teardown synchronously refuses
  new work and late replies and releases listeners; it never drains workflows
  or calls Stop. `<OpenFolder>` owns the folder's lifetime: it closes the
  folder when it unmounts, sending what waits, and owns unload protection.
  Internal navigation keeps the app. `src/lib/page-boundary.test.ts` enforces
  this ownership; the composition is documented in `ARCHITECTURE.md`.
- **No native services yet.** Whispering has no desktop shell, and Epicenter
  grants it nothing (ADR-0701). The optional desktop-shaped members of
  `src/lib/platform/types.ts`, such as `localTranscription`, are `undefined`
  in the browser leaf and stay unused until Whispering has a desktop shell.
  A future shell would reuse `@epicenter/recorder/tauri`,
  `tauri-plugin-epicenter-recorder`, and the CLI's
  `epicenter whispering-connection` command; the hosted design is archived at
  the tag `archive/app-hosting`.
- **A lost reply is not a refusal.** When a request's answer never arrives,
  the page does not know whether the endpoint was called. Report it as
  unknown, never as "not sent", and never send a provider request again
  without the person asking.
- **Files are authoritative.** The folder mirror shows what landed on disk,
  and edits (`edit` from `@epicenter/svelte/folder`) are the only state
  ahead of it: every typed value enters the folder queue immediately, so a
  later file action runs after it. Switching between writable views of the
  same file is immediate. Whole-file edits replace the file at their turn;
  earlier field changes survive only if the editor includes them.
  Every text input bound to folder data uses one edit, one per editor
  component. Derive lists from the mirror's rows and files; do not add
  another save queue, cache, mirror, or second store of recordings, and keep
  no typed text in product state. Do not add Yjs, the `@epicenter/app` store,
  or accounts to this workflow.
- **Recording audio is a supported same-stem sibling of its Markdown file.**
  Store no audio path in recording metadata. Refuse ambiguous matches. Do not
  add alternate path readers or migrations. Deleting a row keeps its audio.
- **The header reports folder activity.** It says Saving… from
  `folder.saving` and On this device while idle, beside the count of answers
  not written. The caller holding a command's `Saved` presents its failure
  once. A failed edit keeps the typed value and shows Save again,
  Discard, and Copy beside its input. The app has no per-file save line.
- **A recording is in the folder from its start, and its row holds facts
  only** (ADR-0543). The row is created when recording starts; explicit Stop
  writes its length while the page lives. Never add a status, pending, or
  interrupted field. Recorder commands never delete captured audio. Start
  creates the row with `folder.tables.recordings.create(id, { fields, body: '' })`;
  Stop awaits that create, then sets the length with
  `folder.tables.recordings.update(id, { fields: { durationMs } })`, which
  sets only what it names over the file as it is then. Never serialize row
  text by hand in the app.
- **Fixture audio is debug-only, and failure injection is test-only.** Fixture
  audio is a development browser build's, and the UI says so while it is
  active. No build offers failure injection; a test that fails a recording
  write makes storage refuse it below the folder (the memory host's control
  in `@epicenter/folder/testing`), so the folder fails it.
- **A transformation never writes its transcript.** A result has its own file
  with a stem fixed before the request is sent. Saving a received result again
  must not call the endpoint or create a second file. A result on pasted text
  names no recording and must never participate in recording deletion.
- **A key never reaches the folder.** The browser keeps its two connections,
  keys included, in this origin's storage, never in the folder. A key is never
  logged or written to the folder, including inside an error message.
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
mounted views under the browser runtime after the rest), and `bun run build`.
Tests establish logic and what reaches disk. The TypeScript tests open a
directory with the Bun opener (`@epicenter/folder/bun`) or a folder over
memory (`@epicenter/folder/testing`) to hold or refuse a save. Only opening
Whispering with `bun dev:whispering` and using it establishes that the app
works.
