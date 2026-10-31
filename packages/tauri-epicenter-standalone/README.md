# Standalone desktop apps

A standalone Epicenter app is its own small Tauri program over a folder it
owns (decisions 79 to 82). This crate is the Rust every such app shares, so
each app's `src-tauri/src/main.rs` stays a few dozen lines. Its TypeScript
counterparts are in `@epicenter/folder/tauri`: `desktopFolder({ contract })`,
the window's roots and the requests that open its data folder, built on
`appFolders`, `appConfig` (or the app's own `defineAppConfig({ … })`),
`rememberFolder`, `syncWithEpicenter` and `syncedWithEpicenter`. The page's
UI for them is in `@epicenter/svelte`: `data-folder` (opens the data folder
as the window starts, or the recovery screen) and `folder-sync` with
`folder-sync-actions` (sync state, Sync with Epicenter, Choose data
folder…).

## Two roots per window (decisions 88 and 89)

- **The AppData root** is fixed: the operating system's application data
  directory for the app, never synced and never chosen. Its settings notes
  sit at its top (`settings.md`, `shortcuts.md`). `settings.md` holds
  `folder` only when the person chose a data folder.
- **The data root** is the person's files: `~/Epicenter/<App>` by default
  (`~/Epicenter Dev/<App>` for a `.dev` build, or under
  `EPICENTER_FOLDER_DIR`), or the folder `settings.md` names. Only it is
  synced, by Epicenter, once asked.

Rust never reads or writes a settings note. Startup makes the AppData root
and opens the window bound to it alone, telling the page its path and the
default folder (`window.__EPICENTER_APP_FOLDERS__`, `appFolders()`). The
page reads `folder` through its client and calls
`commands::open_data_folder(folder | null)`: Rust admits it
(`Places::data_root`: the default is created when missing; a chosen folder
is opened as it is, never created or moved), makes it the window's watched
root with the AppData root granted beside it (`Folders::rebind`), and
answers its path, or a typed refusal (`refused`, `missing`,
`unavailable`). There is no first-run question and no silent fallback: a
refusal shows the recovery screen (Retry, Choose folder…, Use the default
folder). "Choose data folder…" is `commands::choose_data_folder` (the native
picker) followed by the same command; the page writes `folder`.

```ts
const desktop = desktopFolder({ contract: CONTRACT_URL }); // null outside the window
const answer = await desktop.open();
if (answer.ok) setRepo(openDevice(contract, { path: answer.folder.path }));
```

These are refused, each with one line saying why (`Places::refusal`): the top
of a disk, the home folder itself, anything inside or around Epicenter's own
records or settings, anything around the app's own settings, anything inside
a repository's `.git` folder, and a relative path.

## Window and Quit

On macOS, Quit and Cmd-Q ask the primary window to close, so the page's leave
guard waits for its saves. Destroying the primary destroys any auxiliary
windows the app made, never another primary. WebView files live in the app's
cache directory, outside both roots. A startup failure shows one dialog with
only Quit.

```rust
const CAPTURE: StandaloneApp = StandaloneApp {
    page: "capture",
    title: "Capture",
    size: (760.0, 720.0),
};

epicenter_standalone::builder(CAPTURE)
    .invoke_handler(tauri::generate_handler![
        epicenter_standalone::commands::open_data_folder,
        epicenter_standalone::commands::choose_data_folder,
    ])
    .run(tauri::generate_context!())
```

The app's capability grants `epicenter-folder:default` and
`allow-open-data-folder` and `allow-choose-data-folder`, which its `build.rs`
declares with `tauri_build::AppManifest::new().commands(COMMANDS)`. The folder and
dialog plugins must also be direct dependencies, so `tauri-build` finds their
permissions. The crate is a member of the root Cargo workspace
(`cargo test -p epicenter-standalone`).

## Making a web app's desktop variant

The desktop variant is the web app's own UI, built with different leaves.
The build chooses them, never a runtime check, and the routes stay the same
(do not swap SvelteKit's `kit.files.routes`). `apps/capture` is the worked
example.

1. **Seams.** In the app's `package.json`, map each thing the variants differ
   in to two leaves, the desktop one under `tauri`. The one thing every
   variant differs in is its root, which chooses the store (decision 78):

   ```json
   "imports": {
     "#platform/root": { "tauri": "./src/lib/root.tauri.ts", "default": "./src/lib/root.ts" }
   }
   ```

   A leaf is TypeScript, exporting components where the variants render
   differently (`export const Root: Platform['Root'] = DesktopRoot;`), so
   neither build carries the other's root. The desktop root is
   `<DataFolder app contract desktop>` from `@epicenter/svelte/data-folder`,
   which opens the data folder and sets its client for the app (the same
   client type as the web's), or shows the recovery screen. Components import
   `#platform/root`, never a leaf, and leaves import with relative paths
   (no `$lib`), so the bundle test can resolve them. A shared
   `src/lib/platform.ts` holds the types both leaves annotate against.
2. **Build.** Merge `desktopVariant()` from `@epicenter/vite-config` into
   `vite.config.ts`, and add `"build:native": "EPICENTER_DESKTOP=1
   <APP>_BUILD_DIR=build-desktop NODE_ENV=production vite build"`, plus
   `dev:desktop` and `build:desktop` that run it before `tauri dev` or
   `tauri build`. `src-tauri/tauri.conf.json` loads `../build-desktop`.
3. **Typecheck.** `tsconfig.tauri.json` extends `tsconfig.json` with
   `"customConditions": ["tauri"]`; run `svelte-check` with both.
4. **Guard.** A bundle test (`apps/capture/src/lib/platform.test.ts`) bundles
   the seams with `bundledModules` both ways and names any desktop leaf that
   went missing, since a dropped `tauri` key silently ships the browser leaf.
