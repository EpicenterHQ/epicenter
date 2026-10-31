# Standalone desktop apps

A standalone Epicenter app is its own small Tauri program over a folder it
owns (decisions 79 to 82, 88 to 97). This crate is the Rust every such app
shares, so each app's `src-tauri/src/main.rs` stays a few dozen lines. Its
TypeScript counterparts are in `@epicenter/folder/tauri`:
`openAppData(settingsContract)` and `openDataFolder(contract, { appData })`,
which open the window's two roots, `chooseFolder` (the native picker),
`rememberFolder`, `syncWithEpicenter` and `syncedWithEpicenter`. The page's UI for them is in `@epicenter/svelte`:
`recovery` (the screen when a root does not open) and `folder-sync` with
`folder-sync-actions` (sync state, Sync with Epicenter, Choose data
folder…).

## Two roots per window

- **The AppData root** is fixed: the operating system's application data
  directory for the app, never synced and never chosen. Its settings notes
  sit at its top (`settings.md`, `shortcuts.md`), read through the app's own
  settings contract (an ordinary `defineContract` whose `settings.md` has
  `folder`). `settings.md` holds `folder` only when the person chose a data
  folder; any other key there, or in another note, overrides on this
  computer the same note's value in the data folder.
- **The data root** is the person's files: `~/Epicenter/<productName>` by
  default, or the folder `settings.md` names. `productName` is the merged
  Tauri configuration's: `Capture` for the shipped app, `Capture Dev` under
  `tauri.dev.conf.json`, which also gives development its own identifier and
  so its own AppData root. Only the data root is synced, by Epicenter, once
  asked.

Rust never reads or writes a settings note and names no path to the page.
Startup allows the app's own default folder in Tauri's runtime file-system
scope (`default_folder`, from `package_info().name`, what the page's
`getName()` answers), makes the AppData root, and opens the window bound to
it. The page finds both roots with Tauri's path API and opens them through
the folder plugin, which opens a folder only when that scope allows it:

| Folder | Allowed by |
| --- | --- |
| The default `~/Epicenter/<productName>` | Startup, each launch (`fs_scope().allow_directory(default, true)`) |
| A folder the person picked | The dialog plugin's `open`, which allows the picked folder recursively; `tauri-plugin-persisted-scope` keeps it across launches in the AppData root's `.persisted-scope` |
| A `folder` written by hand or by an agent | Nothing: it opens as `NotGranted` until the person picks it ("Allow access") |

No capability names a folder. A grant stays after the person switches
folders, so switching back is free. Folders dropped onto the window are not
allowed (`plugins.fs.scopeDroppedPaths: false`). Even an allowed folder is
refused when no app should keep its files there (the folder plugin's
`scope::Refusals`): the top of a disk, the home folder itself, anything
inside or around Epicenter's own records or settings, anything around the
app's own settings, anything inside a repository's `.git` folder, and a
relative path.

The page's startup awaits the two roots in order, under its layout's
`<svelte:boundary>`; a root that does not open shows the recovery screen,
whose actions write or clear `folder` and open the roots again:

```ts
const appData = await openAppData(captureSettings); // the app's own settings contract
if (appData.error !== null) return appData; // "could not open its own settings": Retry
const device = await openDataFolder(capture, { appData: appData.data }); // the default is made when missing
```

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

epicenter_standalone::builder(CAPTURE).run(tauri::generate_context!())
```

The builder registers `tauri-plugin-fs` (for its scope; no `fs:` command is
granted), `tauri-plugin-persisted-scope` after it, the folder plugin and the
dialog plugin. The app's capability grants `epicenter-folder:default`,
`dialog:allow-open`, `core:app:allow-name`, `core:path:allow-resolve-directory`
and `core:path:allow-join`, and each configuration lists it in
`app.security.capabilities`, so nothing in `capabilities/` is enabled
implicitly (Tauri replaces, not appends, the list a `--config` file gives).
The folder and dialog plugins must also be direct dependencies of the app, so
`tauri-build` finds their permissions. The crate is a member of the root
Cargo workspace (`cargo test -p epicenter-standalone`).

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
   differently (`export const Startup: Platform['Startup'] = OnlineRoot;`)
   and how the pages read the store (`store()`), so neither build carries
   the other's root. The desktop leaf's `Startup` awaits
   `openAppData(<app>Settings)` and `openDataFolder(...)` and renders the
   app's desktop root over them (which sets `setAppData(fromClient(appData))` and
   `setDevice(fromClient(device))`), or `@epicenter/svelte/recovery`; the
   app's layout wraps `Startup` in `<svelte:boundary>` with the UI kit's
   spinner as its `pending`, and `svelte.config.js` turns on
   `compilerOptions.experimental.async`. Components import
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
