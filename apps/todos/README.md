# Todos

Todos keeps Markdown files in one local [Folder](../../packages/folder/README.md). It opens without an account, a remote, or Git. The browser build uses this origin's IndexedDB folder. The installed build uses the directory its desktop shell grants its window: Epicenter's, or Todos's own window (`src-tauri/`). The native CLI opens an existing directory supplied on its command line. The same table schema interprets `todos/<id>.md` on both hosts.

The current UI can add, edit, complete, and delete todos. A todo's title and `done` flag live in frontmatter; its notes live in the Markdown body. Fields the schema does not name remain in the source when a row is edited. A file that does not read as a todo remains visible with its source for repair.
Deleting a todo removes its Markdown row; adjacent files stay in the Folder.

## Run the browser app

From the repository root:

```sh
bun dev:todos:ui
```

Open the URL Vite prints. Use a fresh browser profile or origin for a fresh workspace. The header says **Saved on this device** after IndexedDB confirms each save and no draft or failure remains. Open a second tab at the same URL to see saved changes propagate. Once the page has loaded, editing needs no network connection. A cold offline launch requires an offline app shell and is separate work.

For an isolated automated walkthrough, from the repository root run:

```sh
bun run --cwd apps/todos demo:local
```

The demo uses a fresh browser profile. It exercises editing, reopening, two tabs, offline edits after load, source preservation, and a controlled failed save that retains the draft. It also checks the browser's IndexedDB storage, so an unchanged looking screen cannot conceal the former OPFS engine.

## Run the desktop app

From the repository root:

```sh
bun dev:todos:desktop
```

This builds the installed page into `apps/todos/dist` and runs the Tauri shell in `src-tauri/` with `cargo`, which needs a Rust toolchain. The window opens without an account or network. Each launch rebuilds the page.

To build a local macOS app that you can quit and reopen from Finder, run `bun build:todos:desktop` from the repository root. The result is `apps/todos/src-tauri/target/release/bundle/macos/Todos.app`. This local build is not a signed distribution.

The folder is the whole application data directory, `~/Library/Application Support/so.epicenter.todos` on macOS. Todos rows land at `todos/<id>.md` directly in it; there is no child directory and no marker file. The shell creates the directory at the first open when it is missing. The save lock is `.so.epicenter.todos.epicenter-save-lock` beside it. The first save also creates `.git/epicenter/scratch` inside it to stage files; that is not a repository until something commits.

The shell registers that directory for the `todos` window in trusted Rust code and hands the window its scope. The page calls the same `openFolder({ tables })` as the browser build and never names a path. `capabilities/todos.json` gives the window the folder plugin's commands and its change event, and nothing else.

On the tested macOS build, opening and saving left only `.git/` and `todos/` in the Folder root. Linux and Windows have not been run; their WebView data locations must be checked before treating the whole app-data root as a supported default there.

## Native directory example

```sh
mkdir -p /tmp/todos-example
bun apps/todos/scripts/native.ts /tmp/todos-example create "Buy milk"
bun apps/todos/scripts/native.ts /tmp/todos-example list
bun apps/todos/scripts/native.ts /tmp/todos-example complete <id>
```

The CLI opens `openFolder({ directory, tables: todosTables })`. It saves ordinary files and never makes a commit or contacts a remote. It leaves other files and unknown row fields intact.

## Earlier browser data

Earlier Todos builds kept named folders in OPFS. This build opens its IndexedDB folder independently and does not read or migrate those older files. It does not change or remove the OPFS bytes. A profile with only older OPFS data shows an empty current list.

## Boundaries and checks

`src/routes/+page.svelte` mounts one `FolderApp` with `todosTables`. The root owns the Folder handle, query cache, drafts, status, and close. `src/routes/local/` contains the UI; it reads the handle through the Svelte context. `scripts/native.ts` uses the same public Folder operations over a directory. Todos has no account, inference, or sync action.

From the repository root:

```sh
bun run --cwd apps/todos test
bun run --cwd apps/todos typecheck
bun run --cwd apps/todos build
bun run --cwd apps/todos build:installed
cargo test --manifest-path apps/todos/src-tauri/Cargo.toml
bun build:todos:desktop
```
