# Standalone desktop apps

A standalone Epicenter app is its own small Tauri program over a folder it
owns (decisions 79 to 82, 88 to 97). This crate is the Rust every such app
shares, so each app's `src-tauri/src/main.rs` stays a few dozen lines.
On the page, `openFolder(contract, home({ site }))` from `@epicenter/folder`
opens the data folder in the desktop build, `settings` from
`@epicenter/local` is this computer's settings in AppData, and
`syncWithEpicenter` and `syncedWithEpicenter` from `@epicenter/folder/tauri`
manage Epicenter enrollment. The page's recovery and sync UI is in
`@epicenter/svelte`.

## Two named roots

Startup names two roots, which the page opens by name through the folder
plugin; nothing is granted or stored
([ADR-0725](../../docs/adr/0725-an-app-reaches-named-roots-through-one-command-per-storage-operation.md)).

- **AppData** is the operating system's application data directory, used by
  apps with machine-local settings such as shortcuts or connections. The
  page's first open makes it. An app that signs in keeps its secrets there
  too: [`epicenter-account`](../tauri-epicenter-account/README.md) writes
  `credentials.json`, which no page reaches, and `account.json`, who is
  signed in, which the page reads like any setting.
- **Data** is `<library root>/<name>`. The name comes from the app's bundle
  identifier, the reversed host of its site (`so.epicenter.whispering` is
  `~/Epicenter/whispering`). The library root is `~/Epicenter`, or
  `~/Epicenter Dev` in development.

The environment is stated, never guessed from the identifier. Only the
development configuration (`tauri.dev.conf.json`, used by
`bun dev:<app>:desktop`) states one:

```json
"plugins": { "epicenter-standalone": { "environment": "development" } }
```

Its identifier is the production one with `.dev` appended, and the shell
removes that suffix in development alone, so a production site whose first
label is `dev` keeps it. A configuration that states something else, or a
development identifier without `.dev`, fails startup
(`StartupError::Environment`, `StartupError::Identity`).

Startup names both roots before the window opens. The page then opens Data
off the window thread. Whatever is at its path is the app's
([ADR-0726](../../docs/adr/0726-an-apps-path-is-its-claim.md)): the folder is
made when nothing is there, and a link there is followed. A link whose target
is gone makes nothing and answers `Disconnected`. A data root that resolves to
the person's home folder, a folder holding it, or the library root itself
answers `Refused` (`refusal`, the one refusal). The page shows either failure
in Recovery with Retry. `open_root` also answers the named path the page shows.

## Window and Quit

Startup opens one plain window, `<page>:main`, which the app's capability
selects (`<page>:*`). Quit quits (on macOS, the default menu's Quit and
Cmd-Q), and a window closes at once: nothing waits for the page. Every
plugin still hears the window's `Destroyed` and the app's `Exit`, where the
recorder finishes a recording in progress. WebView files live in the app's
cache directory, outside both roots. A configuration or window failure
(`StartupError`) shows one dialog saying why, with only Quit.

```rust
const CAPTURE: StandaloneApp = StandaloneApp {
    page: "capture",
    title: "Capture",
    size: (760.0, 720.0),
};

epicenter_standalone::builder(CAPTURE).run(tauri::generate_context!())
```

The builder registers the folder plugin and the dialog plugin, whose only
use is the startup failure dialog. The app's capability grants
`epicenter-folder:default` and nothing for a folder, and each configuration
lists it in `app.security.capabilities`, so nothing in `capabilities/` is
enabled implicitly (Tauri replaces, not appends, the list a `--config` file
gives). The folder plugin must also be a direct dependency of the app, so
`tauri-build` finds its permissions. The crate is a member of the root
Cargo workspace (`cargo test -p epicenter-standalone`).

## Making a web app's desktop variant

The desktop variant is the web app's own UI, built with different leaves.
The build chooses them, never a runtime check, and the routes stay the same
(do not swap SvelteKit's `kit.files.routes`).

1. **Seams.** The store needs none: `src/lib/app.ts` calls
   `openFolder(contract, home({ site, account }))`, and the `tauri` build of
   `@epicenter/folder` makes `home` the data folder. In the app's `package.json`,
   map each thing the variants do differ in to two leaves, the desktop one
   under `tauri`, usually the account and the chrome that shows where the
   files are:

   ```json
   "imports": {
     "#platform/account": { "tauri": "./src/lib/account.tauri.ts", "default": "./src/lib/account.ts" },
     "#platform/chrome": { "tauri": "./src/lib/components/DesktopChrome.svelte", "default": "./src/lib/components/OnlineChrome.svelte" }
   }
   ```

   Components import `#platform/*`, never a leaf, and leaves import with
   relative paths (no `$lib`), so the bundle test can resolve them.
   `apps/todos` is the smallest worked example.
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
