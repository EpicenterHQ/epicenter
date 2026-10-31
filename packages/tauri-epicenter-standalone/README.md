# Standalone desktop apps

A standalone Epicenter app is its own small Tauri program over a folder it
owns (decisions 79 to 82). This crate is the Rust every such app shares, so
each app's `src-tauri/src/main.rs` stays a few dozen lines. Its TypeScript
counterparts are in `@epicenter/folder/tauri`: `appConfig`, `appFolders`,
`rememberFolder`, `syncWithEpicenter` and `syncedWithEpicenter`.

## Two roots per window

An app keeps two roots, and its window reaches exactly those:

- **Its configuration directory** (the operating system's, for the app) holds
  `settings.md`, the machine-local `appConfig` note: `folder`, where the app
  keeps the person's files, and any other machine settings. It is never
  synced. API keys stay in the keychain.
- **Its folder**, the person's data, which Epicenter syncs once asked.

Startup makes the configuration directory and reads `folder` from
`settings.md`; Rust never writes the note. The window is bound to the folder
with the configuration directory granted beside it, or to the configuration
directory alone when there is no folder yet, or the remembered one is
missing or refused. The folder plugin lets a page name a root only by its
exact path, and only a root Rust granted that window; grants are fixed for
the window's life, and only the folder is watched. Before the page's code
runs, Rust sets `window.__EPICENTER_APP_FOLDERS__`, which the page reads with
`appFolders()`:

```ts
const folders = appFolders(); // { config, folder | null, problem, places }
const config = openDevice(appConfig, { path: folders.config });
const device = folders.folder === null ? null : openDevice(contract, { path: folders.folder });
```

## Choosing the folder

With no folder, the page asks "Where should <App> keep its files?": the
Epicenter folder `~/Epicenter/<App>` (recommended; `~/Epicenter Dev/<App>` for
a `.dev` build, or under `EPICENTER_FOLDER_DIR`), the app data folder, or
"Choose folder…". It calls `commands::choose_folder` with `"epicenter"`,
`"app-data"`, or `"pick"` (a native picker). Rust admits the answer, creates
the folder or reuses it with its files, and replaces the window with one bound
to it; that page records the folder with `rememberFolder(config, folder)`.
"Choose folder…" later is the same command.

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
        epicenter_standalone::commands::choose_folder
    ])
    .run(tauri::generate_context!())
```

The app's capability grants `epicenter-folder:default` and
`allow-choose-folder`, which its `build.rs` declares with
`tauri_build::AppManifest::new().commands(&["choose_folder"])`. The folder and
dialog plugins must also be direct dependencies, so `tauri-build` finds their
permissions. The crate is a member of the root Cargo workspace
(`cargo test -p epicenter-standalone`).

## Making a web app's desktop variant

The desktop variant is the web app's own UI, built with different leaves.
The build chooses them, never a runtime check, and the routes stay the same
(do not swap SvelteKit's `kit.files.routes`). `apps/capture` is the worked
example.

1. **Seams.** In the app's `package.json`, map each thing the variants differ
   in to two leaves, the desktop one under `tauri`:

   ```json
   "imports": {
     "#platform/device": { "tauri": "./src/lib/device.tauri.ts", "default": "./src/lib/device.ts" }
   }
   ```

   Components import `#platform/device`, never a leaf. A shared
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
