# Standalone desktop startup

A standalone Epicenter app is its own small Tauri program over one folder it
owns (decision 81). This crate is the part every such app shares, so each
app's `src-tauri/src/main.rs` stays a few dozen lines.

- **First run** asks "Where should <App> keep its files?" in a native alert:
  the Epicenter folder `~/Epicenter/<App>` (recommended, visible;
  `~/Epicenter Dev/<App>` for a `.dev` build, or under `EPICENTER_FOLDER_DIR`),
  the app's data folder (hidden), or "Choose folder…" (a native picker). The
  folder is created, or reused with its files when it already exists; a file
  or a link at the path is refused and the question asked again.
- **The choice** is `folder` in `settings.md`, the app's machine-local
  configuration note in its configuration directory (`appConfig` from
  `@epicenter/folder`, decision 82), written as that contract's writer writes
  it; other settings in the note are kept. It is never in the folder and
  never synced. Later launches open the folder without asking; one that has
  gone missing is asked about again. The folder stays when the app is
  removed.
- **The window** is bound to the folder before its WebView exists. The page
  opens it with `openDevice(contract)` from `@epicenter/folder/tauri` and
  never names a path. WebView files live in the app's cache directory.
- **Choose folder… later**: `commands::choose_folder` picks a folder, adopts
  it, opens a window bound to it, and closes the calling one. The page waits
  for its saves first.
- **Quit** (Cmd-Q on macOS) asks the primary window to close, so the page's
  leave guard waits for its saves. Destroying the primary destroys any
  auxiliary windows the app made, never another primary.
- **The folder's path** reaches the page through `commands::folder_path`, for
  `syncWithEpicenter({ path, contract })` in `@epicenter/folder/tauri`, which
  opens `epicenter://init?path=…&contract=…`. Syncing is Epicenter's; apps
  never commit.

```rust
const CAPTURE: StandaloneApp = StandaloneApp {
    page: "capture",
    title: "Capture",
    size: (760.0, 720.0),
};

epicenter_standalone::builder(CAPTURE)
    .invoke_handler(tauri::generate_handler![
        epicenter_standalone::commands::choose_folder,
        epicenter_standalone::commands::folder_path,
    ])
    .run(tauri::generate_context!())
```

Each app keeps its own identifier, icon, and capability: `epicenter-folder:default`,
`allow-choose-folder` and `allow-folder-path`, which the app's `build.rs`
declares with `tauri_build::AppManifest::new().commands(&["choose_folder", "folder_path"])`. The folder and
dialog plugins must also be direct dependencies of the app, so `tauri-build`
finds their permissions.

On macOS the first-run alert is a system alert (rfd's CoreFoundation user
notification), so it belongs to `UserNotificationCenter`, not the app.

The crate is a member of the root Cargo workspace (`Cargo.toml`):
`cargo test -p epicenter-standalone`.
