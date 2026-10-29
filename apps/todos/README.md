# Todos

Todos keeps each todo as a Markdown file, `todos/<id>.md`, in a repository ([`@epicenter/repository`](../../packages/repository)). The page opens one of this browser's repositories from the repository chooser (`RepositoryChooser` from `@epicenter/svelte`): each is a replica in this origin's private storage (OPFS), owned by one tab's worker, kept only on this device or synced with a server. The first visit makes one; later visits open the last one again; the repository's name in the header goes back to the list, to open, make or remove another. A second tab offers Use here, which moves the repository to it; the first tab keeps showing its todos under a bar that says so. Todos opens without an account.

A todo's title and `done` flag live in frontmatter; its notes live in the Markdown body. The checkbox and the title each set their one field, so fields the schema does not name, and a change made elsewhere to the rest of the todo, stay. The notes are a view of the todo's editor; **Edit source** opens the same editor on the todo's whole file, frontmatter included (`<SourceEditor>` from `@epicenter/svelte`), whose status says whether the frontmatter parses and whether the todo matches the schema, with each issue. A file that does not read as a todo is listed under **Needs repair** and opens straight into its source. Text whose frontmatter does not parse is saved on this device and held, not sent, until it parses again; the status says so, and the header counts it as **Not sent**.

The todos are held in page memory, so the list and the open todo read them at once, and every edit shows at once. An edit resolves once it is saved on this device; if it cannot be saved, Todos says so in a toast and the controls show the stored todo again. Edits made offline are sent when the server is reachable, and edits from elsewhere merge with them: where two people changed the same words, the todo keeps both, as a labelled conflict block in its text.

## Run the browser app

From the repository root:

```sh
bun dev:todos:ui
```

Open the URL Vite prints and make a repository kept on this device: the header says **On this device**. Open a second tab at the same URL: it offers Use here, and the first tab then says Todos is open in another tab.

To sync, serve a repository on this machine:

```sh
bun packages/repository/scripts/serve.ts /tmp/todos.git --origin http://127.0.0.1:5186
```

In the repository chooser, make a repository with the server `http://127.0.0.1:8787/`, the repository `todos`, and a name to sync as. Use a second browser profile, with another name, as a second person. The header says **Sending…** while edits wait for the server, **Not sent** while a todo's text is held on this device, and **Synced** once the server has everything. The server commits to `/tmp/todos.git` a minute after a change, so `git clone /tmp/todos.git` shows the todos as files.

The Playwright tests build the site and drive it in Chromium and WebKit with persistent profiles, alone and as two people syncing through the development server:

```sh
bun run --cwd apps/todos test:browser
```

## Run the desktop app

From the repository root:

```sh
bun dev:todos:desktop
```

This builds the host page into `apps/todos/dist` (`build:host`) and runs the Tauri shell in `src-tauri/`, which needs a Rust toolchain.

The page now opens its repository with the browser host in the WebView's own storage, as in a browser; it no longer reads or writes the directory the shell binds, and the bound-directory behavior below describes the shell, not where todos are stored. A native SQLite driver for desktop is later work. This path has not been run since the change. The development identifier `so.epicenter.todos.dev` opens `~/Epicenter Dev/so.epicenter.todos`; release builds open `~/Epicenter/so.epicenter.todos`. The window opens without an account or network.

<!-- doc-path-check: ignore-next-line (generated Tauri bundle output, not a tracked source file) -->
To build a local macOS app that you can quit and reopen from Finder, run `bun build:todos:desktop` from the repository root. The result is `apps/todos/src-tauri/target/release/bundle/macos/Todos.app`. This local build is not a signed distribution.

Standalone and hosted Todos open one fixed default, `<library>/so.epicenter.todos`, where the library is `~/Epicenter`, `~/Epicenter Dev` in development, or `EPICENTER_FOLDER_DIR`. An ordinary launch creates it when missing and otherwise reuses it as it is; nothing is saved, so a default that was moved or deleted is made again empty by the next launch, and no other folder is searched for. Todos rows land at `todos/<id>.md` inside the bound folder. The save lock and scratch directory sit beside it.

Startup reads no configuration and never looks for, reads, or moves data in an earlier location such as `~/Epicenter/Todos` or a saved home in `folders.json`. Such a folder still opens explicitly in Epicenter's launcher.

Both native shells use `defaults::DesktopPaths::open_default(library::TODOS)`
from the folder plugin, one row of its shared default table; app-specific
runtime state remains in each shell's AppData.

Both shells call the folder plugin's `open_folder_window("todos", directory, url, configure)`. The plugin computes the window label from the app key and canonical directory, binds before construction, reuses an existing matching window, and cleans up on destruction. Todos's shell supplies its fixed default; Epicenter supplies its default or the folder chosen in its launcher. The page receives neither path.

Standalone Todos has one window and no folder picker, recent-folder list, or extra-folder windows. When its default cannot be opened, for example because a file or a link is at that path, a native dialog names the failure and offers only Quit. Epicenter need not be installed. For any other folder, use Epicenter's launcher. Both wrappers load the same static host build, which, since the move to the repository engine, keeps its todos in the WebView's storage rather than in the bound directory (see above).

Folder selection is a shell capability, not a requirement of the app. Hosted
Todos can open a directory chosen by Epicenter without adding a picker to its
web interface. Standalone Todos keeps the smaller fixed-default experience.
Opening arbitrary folders without Epicenter would justify an optional native
Open Folder action, but it would also require multiple-window presentation
and Quit behavior; that capability is not part of this standalone product.

On macOS, the app menu's Quit and Cmd-Q request that window's ordinary close.
The page waits for writes in flight before closing. A saved window closes
silently. A failed save leaves the attempted value in the editor with Save
again, Discard, and Copy while the page stays open; leaving discards it.

The shell binds the window's directory to it in trusted Rust before the window exists ([ADR-0647](../../docs/adr/0647-a-native-window-edits-one-directory-bound-before-it-exists.md)). The page opens the same browser repository as the browser build and never names a path. `capabilities/todos.json` selects `todos:*` and gives that window the Folder plugin's private observation and close protocol, plus reading the app identifier and its own handoff command. The page receives no opener permission.

Standalone Todos also offers **Open in Epicenter**. Rust reads the calling window's bound directory and asks the operating system to open `epicenter://open?path=…`. The page passes no path. Epicenter shows the full path and asks the person to accept before opening a separate file editor. The handoff opens the currently bound directory in Epicenter; it does not copy or move files. The message confirms only that the computer was asked, since Epicenter may not be installed ([ADR-0646](../../docs/adr/0646-a-native-app-hands-epicenter-a-directory-path-and-the-person-accepts-it.md)).

On the earlier tested macOS build, opening and saving left only `.git/` and `todos/` in the Folder root. The shell assigns WebView runtime storage to its cache directory, outside the Folder. A packaged macOS launch verified the fixed default and displayed the relocated todo without a startup choice. Linux and Windows packaged builds have not been run.

## Native directory example

```sh
mkdir -p /tmp/todos-example
bun apps/todos/scripts/native.ts /tmp/todos-example create "Buy milk"
bun apps/todos/scripts/native.ts /tmp/todos-example list
bun apps/todos/scripts/native.ts /tmp/todos-example complete <id>
```

The CLI opens `openFolder({ directory, tables: todosTables })`. It saves ordinary files and never makes a commit or contacts a remote. It leaves other files and unknown row fields intact.

## Earlier browser data

Earlier Todos builds kept their folder in IndexedDB, and before that in OPFS, and the build before this one opened a fixed repository named `todos` with an engine since removed. This build lists only this browser's replicas and does not read or migrate any of those; their bytes stay where they are. A profile with only older data shows the chooser.

## Boundaries and checks

`src/routes/+page.svelte` mounts the repository chooser over `todosApp`, with `TodosApp` inside it. `src/routes/local/` reads the repository through Svelte context (`reactive` from `@epicenter/svelte/repository`), writes with `create`, `patch` and `delete`, edits a todo's notes and source through its editor (`openEditor`), and reports writes it could not save. `apps/todos/scripts/native.ts` still uses `@epicenter/folder` over a directory, with the same schema; it does not read the repository. Todos has no account, inference, or sync action.

From the repository root:

```sh
bun run --cwd apps/todos test
bun run --cwd apps/todos test:browser
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
