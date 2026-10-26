# Todos

Todos keeps Markdown files in one local [Folder](../../packages/folder/README.md). It opens without an account, a remote, or Git. The browser build uses this origin's IndexedDB folder. The host build (`build:host`) uses the directory its desktop shell binds to its window: Epicenter's, or Todos's own shell (`src-tauri/`). The native CLI opens an existing directory supplied on its command line. The same table schema interprets `todos/<id>.md` on both hosts.

The current UI can add, edit, complete, and delete todos. A todo's title and `done` flag live in frontmatter; its notes live in the Markdown body. Fields the schema does not name remain in the source when a row is edited. A file that does not read as a todo remains visible with its source for repair.
Deleting a todo removes its Markdown row; adjacent files stay in the Folder.

Add creates a complete row with `folder.tables.todos.create`; a failed Add leaves
the title in the form and reports the error. Existing todo controls read the
folder mirror. Each text editor keeps its own draft while its write is pending.
Title and notes save after a short pause and send their latest text when the
editor closes. Done writes directly. Each update changes only the fields it
names over the file as it is when the save runs. After a successful write, the
mirror already shows the saved row. A failed text write leaves the mirror at
the disk value and keeps the attempted value visible in that editor. The editor
offers Save again, Discard, and Copy. Failed commands report their errors.

## Run the browser app

From the repository root:

```sh
bun dev:todos:ui
```

Open the URL Vite prints. Use a fresh browser profile or origin for a fresh workspace. The header says **Saving…** while a folder write is pending and **On this device** otherwise. A text draft may still be waiting to send when the header shows the neutral line. Open a second tab at the same URL to see saved changes propagate. Once the page has loaded, editing needs no network connection. A cold offline launch requires an offline app shell and is separate work.

A clean todo follows saved changes from another tab. Pending text remains in
its editor until its write answers. Writes take turns, and the last write to a
field wins. If a text save fails, the attempted value remains visible until the
person retries, discards it, or edits again. A deleted row shows "This todo is
no longer here." Files that do not read as todos stay visible for repair. Saving
a row keeps unnamed fields and body but writes canonical frontmatter, dropping
YAML comments and ordering declared keys first.

For an isolated automated walkthrough, from the repository root run:

```sh
bun run --cwd apps/todos demo:local
```

The demo uses a fresh browser profile. It exercises editing, reopening, two tabs, offline edits after load, canonical frontmatter, and a controlled failed save. It also checks the browser's IndexedDB storage.

## Run the desktop app

From the repository root:

```sh
bun dev:todos:desktop
```

This builds the host page into `apps/todos/dist` (`build:host`) and runs the Tauri shell in `src-tauri/`, which needs a Rust toolchain. The development identifier `so.epicenter.todos.dev` opens `~/Epicenter Dev/so.epicenter.todos`; release builds open `~/Epicenter/so.epicenter.todos`. The window opens without an account or network.

<!-- doc-path-check: ignore-next-line (generated Tauri bundle output, not a tracked source file) -->
To build a local macOS app that you can quit and reopen from Finder, run `bun build:todos:desktop` from the repository root. The result is `apps/todos/src-tauri/target/release/bundle/macos/Todos.app`. This local build is not a signed distribution.

Standalone and hosted Todos open one fixed default, `<library>/so.epicenter.todos`, where the library is `~/Epicenter`, `~/Epicenter Dev` in development, or `EPICENTER_FOLDER_DIR`. An ordinary launch creates it when missing and otherwise reuses it as it is; nothing is saved, so a default that was moved or deleted is made again empty by the next launch, and no other folder is searched for. Todos rows land at `todos/<id>.md` inside the bound folder. The save lock and scratch directory sit beside it.

Startup reads no configuration and never looks for, reads, or moves data in an earlier location such as `~/Epicenter/Todos` or a saved home in `folders.json`. Such a folder still opens explicitly in Epicenter's launcher.

Both native shells use `defaults::DesktopPaths::open_default(library::TODOS)`
from the folder plugin, one row of its shared default table; app-specific
runtime state remains in each shell's AppData.

Both shells call the folder plugin's `open_folder_window("todos", directory, url, configure)`. The plugin computes the window label from the app key and canonical directory, binds before construction, reuses an existing matching window, and cleans up on destruction. Todos's shell supplies its fixed default; Epicenter supplies its default or the folder chosen in its launcher. The page receives neither path.

Standalone Todos has one window and no folder picker, recent-folder list, or extra-folder windows. When its default cannot be opened, for example because a file or a link is at that path, a native dialog names the failure and offers only Quit. Epicenter need not be installed. For any other folder, use Epicenter's launcher. Both wrappers load the same static host build; its `openFolder({ tables })` call reaches the directory its native shell already bound to the invoking window.

Folder selection is a shell capability, not a requirement of the app. Hosted
Todos can open a directory chosen by Epicenter without adding a picker to its
web interface. Standalone Todos keeps the smaller fixed-default experience.
Opening arbitrary folders without Epicenter would justify an optional native
Open Folder action, but it would also require multiple-window presentation
and Quit behavior; that capability is not part of this standalone product.

On macOS, the app menu's Quit and Cmd-Q request that window's ordinary close.
The page waits for writes in flight before closing. A saved window closes
silently. A browser unload asks only while a write is still saving. A failed
write has already answered and leaves the attempted value in the editor with
Save again, Discard, and Copy available while the page remains open.

The shell binds the window's directory to it in trusted Rust before the window exists ([ADR-0647](../../docs/adr/0647-a-native-window-edits-one-directory-bound-before-it-exists.md)). The page calls the same `openFolder({ tables })` as the browser build and never names a path. `capabilities/todos.json` selects `todos:*` and gives that window the folder plugin's commands and its change event, plus reading the app identifier and its own handoff command. The page receives no opener permission.

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

Earlier Todos builds kept named folders in OPFS. This build opens its IndexedDB folder independently and does not read or migrate those older files. It does not change or remove the OPFS bytes. A profile with only older OPFS data shows an empty current list.

## Boundaries and checks

`src/routes/+page.svelte` mounts one `OpenFolder` with `open={() => openFolder({ tables: todosTables })}`. It owns opening, refreshing on return, and close. `src/routes/local/` reads the reactive folder through Svelte context, owns each text input's draft, and reports command failures. `apps/todos/scripts/native.ts` uses the same public folder operations over a directory. Todos has no account, inference, or sync action.

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
