# Whispering App

Shared UI and workflows for standalone desktop, Epicenter desktop, and browser
deployments. Recordings, transcripts, and settings are files in one
Git-versioned folder; those files are the data. Read `README.md` for current
behavior and delivery status, and `ARCHITECTURE.md` for structure.

## Constraints

- **The workspace owns native acquisition.** Nothing under `src/`
  imports a Node or Bun module or `@epicenter/folder/bun`. The page names the
  folder contract through `@epicenter/folder` and reaches a folder only
  through `src/lib/workspace/`: `@epicenter/folder/browser` is imported by the
  browser workspace alone, and `@epicenter/folder/tauri` by the desktop
  workspace alone. Other native services use shared typed invoke bindings
  imported only by the desktop workspace. The only direct Tauri import is
  `isTauri` in the workspace opener. `src/lib/page-boundary.test.ts` enforces
  these boundaries; keep it passing without granting native reach to components.
- **One folder, one opener.** On the desktop the shell's
  `tauri-plugin-epicenter-folder` grants the data folder to the main window
  and holds its lock, and the page's folder engine (`@epicenter/folder/tauri`)
  is the only thing that opens it. The page names only the folder's ID. Do
  not open the folder from the Bun host, do not add a second path by which
  the page reads or writes folder files, and do not copy the plugins'
  bindings into this app.
- **Quitting is immediate** (ADR-0542). Closing the window or quitting asks
  nothing and waits for nothing: a recording streams into the folder from its
  start (ADR-0543), and a run writes its result row before the request goes
  out. Do not add a close handshake, a quit prompt, or a wait on exit; keep
  long-running work in the folder from its start instead. A save still
  running when the process ends is lost, which is a dropped keystroke, not
  lost work.
- **A folder that cannot be opened is reported, not replaced.** Opening
  returns a `Result`. Inside a desktop app, a missing or unreachable native
  service and a shell that refuses the folder are each shown as that refusal; browser
  storage is never opened there. Whether the page is inside a desktop app is
  asked of the runtime, never inferred from the host's token.
- **One session per mounted layout.** `src/routes/+layout.svelte` holds the
  one opening (`mountSession`) and `AppShell` puts its session in context. A page or component takes it with
  `getSession()`; it never opens a workspace, builds a library, or keeps
  product state in a module-level variable. State that must survive a page
  change belongs to the session. Only a browser tab's unload is guarded,
  while a write is running, never a navigation between routes. `src/lib/page-boundary.test.ts` enforces the
  ownership.
- **Native services are shared by both desktop shells.** New native services
  use reusable Rust implementations compiled by standalone Whispering and
  Epicenter, exposed through the workspace with a browser implementation or
  an explicit `undefined`. Migrate existing `native/` operations as their
  replacements become usable, and remove the replaced routes and consumers.
  Neither those services nor the remaining Bun host may open the folder, take
  its lock, initialize Git, or become a second implementation of folder writes.
  The terminal runs explicit user commands as an outside program.
- **Only the shell decides where the folder is and who reaches it.** Neither
  the page nor the host supplies or chooses a path. Load the `tauri` skill
  before changing commands, capabilities, or `src-tauri/`. Grant only the
  named service commands to the intended window and served origin. Validate
  inputs and protocol compatibility in Rust; a failed desktop acquisition is
  visible and never selects browser storage. `ARCHITECTURE.md` describes the
  current startup order; ADR-0493 records the shared-service migration.
- **A lost reply is not a refusal.** When a native service does not answer, the page
  does not know whether the endpoint was called. Report it as unknown, never
  as "not sent", and never send a provider request again without the person
  asking. A stopped Bun host does not stop saving: do not tell the person it does.
- **Files are authoritative.** The TanStack Query cache holds only the folder
  as last read and edits on their way to it (ADR-0528); do not add another
  cache, mirror, or second store of recordings. Do not add Yjs, the
  `@epicenter/app` store, accounts, or sync to this workflow.
- **A recording's audio is the file its row names.** `audioPath` is the only
  link. Do not infer audio from a file that shares the row's stem, do not
  fill in a missing `audioPath`, and do not delete audio because its row was
  deleted: a table owns one Markdown file per row.
- **A save is never reported by its commit.** Keep saved-file state and history
  state separate in code and in copy.
- **A recording is in the folder from its start, and its row holds facts
  only** (ADR-0543). The row is created when the recording starts, naming its
  audio; its length is written when it stops. Never add a status, pending, or
  interrupted field, and never hold a recording's audio in the page to save
  later on the desktop: the shell writes it as it captures. Only `cancel`
  deletes a recording. Never use `overwrite` for a recording's row or audio,
  and never serialize a row by hand.
- **Fixture audio and failure injection are debug-only.** They are enabled by
  the shell's build, never by an environment variable alone, and the UI says so
  while they are active. An injected recording-write failure obstructs the
  real save so the folder fails it; it never answers for the folder.
- **A transformation never writes its transcript.** A result has its own file
  with a stem fixed before the request is sent. Saving a received result again
  must not call the endpoint or create a second file. A result on pasted text
  names no recording and must never participate in recording deletion.
- **The desktop API key stays in native code.** It is never returned over IPC,
  logged, or written to the folder, including inside an error message.
- **Nothing is sent or seeded on its own.** No request leaves at launch or
  after a recording without the person asking, and no file is created in the
  folder that they did not create. Missing settings stay in memory until an
  explicit settings save.
- Do not rename a recording's or a transformation's files from the app: other
  rows refer to the stem.
- Use wellcrafted `Result` types instead of try-catch for expected failures.

## Checks

From `apps/whispering`: `bun run typecheck`, `bun run test` (which runs the
mounted views under the browser runtime after the rest), `bun run build`. For
shell changes also
`cargo test --manifest-path src-tauri/Cargo.toml`. Tests establish logic and
what reaches disk. The TypeScript tests grant a real directory through a
scripted shell (`src/lib/workspace/granted-folder.test-support.ts`) or open
it with the Bun opener; they never run the Rust shell. Only running
`bun dev:whispering` establishes that the desktop app works.

`src/lib/tauri/bindings.gen.ts` is written by the Epicenter host's build and
read by its Rust tests. Do not edit, import, or delete it from here.
