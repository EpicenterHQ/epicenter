# Todos

Todos keeps Markdown files in one local [Folder](../../packages/folder/README.md). It opens without an account, a remote, or Git. The browser build uses this origin's IndexedDB folder. The host build (`build:host`) uses the directory its desktop shell binds to its window: Epicenter's, or Todos's own shell (`src-tauri/`). The native CLI opens an existing directory supplied on its command line. The same table schema interprets `todos/<id>.md` on both hosts.

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

This builds the host page into `apps/todos/dist` (`build:host`) and runs the Tauri shell in `src-tauri/`, which needs a Rust toolchain. The development identifier `so.epicenter.todos.dev` keeps its app-data Folder separate from the release app. The window opens without an account or network.

To build a local macOS app that you can quit and reopen from Finder, run `bun build:todos:desktop` from the repository root. The result is `apps/todos/src-tauri/target/release/bundle/macos/Todos.app`. This local build is not a signed distribution.

The standalone window's folder is the whole application data directory, `~/Library/Application Support/so.epicenter.todos` on macOS. Todos rows land at `todos/<id>.md` directly in it; there is no child directory and no marker file. The shell creates the directory at launch when it is missing. The save lock and scratch directory sit beside it, named `.so.epicenter.todos.epicenter-save-lock` and `.so.epicenter.todos.epicenter-scratch`.

Both shells call the folder plugin's `open_folder_window("todos", directory, url, configure)`. The plugin computes the window label from the app key and canonical directory, binds before construction, reuses an existing matching window, and cleans up on destruction. Todos's shell supplies its AppData directory; Epicenter supplies the folder chosen in its launcher. The page receives neither path.

Standalone Todos always edits this fixed default. It has one window and no folder picker, recent-folder list, or extra-folder windows. To use Todos on another existing folder, open Todos through Epicenter's launcher and choose the folder there. Both wrappers load the same static host build; its `openFolder({ tables })` call reaches the directory its native shell already bound to the invoking window.

The shell binds the window's directory to it in trusted Rust before the window exists ([ADR-0647](../../docs/adr/0647-a-native-window-edits-one-directory-bound-before-it-exists.md)). The page calls the same `openFolder({ tables })` as the browser build and never names a path. `capabilities/todos.json` selects `todos:*` and gives that window the folder plugin's commands and its change event, plus reading the app identifier and its own handoff command. The page receives no opener permission.

Standalone Todos also offers **Open in Epicenter**. Rust reads the calling window's bound directory and asks the operating system to open `epicenter://open?path=…`. The page passes no path. Epicenter shows the full path and asks the person to accept before opening a separate file editor. The handoff opens the standalone default in Epicenter; it does not copy or move files. The message confirms only that the computer was asked, since Epicenter may not be installed ([ADR-0646](../../docs/adr/0646-a-native-app-hands-epicenter-a-directory-path-and-the-person-accepts-it.md)).

On the tested macOS build, opening and saving left only `.git/` and `todos/` in the Folder root. The shell assigns WebView runtime storage to its cache directory, outside the Folder. Linux and Windows packaged builds have not been run.

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
bun run --cwd apps/todos build:host
cargo test --manifest-path apps/todos/src-tauri/Cargo.toml
bun build:todos:desktop
```

## Export the table schema

The app's TypeBox module owns both runtime validation and developer types.
To distribute a portable copy without opening a data folder:

```sh
bun run --cwd apps/todos schema:export > todos-schema.json
epicenter schema import FOLDER todos-schema.json
```

Replace `FOLDER` with an existing data directory. Importing writes only the
exported table definitions in `epicenter.json`; opening or updating Todos
publishes no schema. A conflicting definition requires `--replace`.
