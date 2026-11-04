# Epicenter app constraints

Read [the app README](README.md) for the current desktop surface.

- Keep Git history and folder sync in the `epicenter` CLI. The Folders window calls fixed CLI commands through `src-tauri/src/synced_folders.rs`; the shell owns the `sync --watch` process. Do not implement Git or sync in the page or native host.
- Serve Epicenter's pages through `src-tauri/src/scheme.rs` from `dist/<page>/` at `/<page>/`. Keep its path containment and Content-Security-Policy when adding a page.
- Grant native commands by window label. `folders.json` grants the Folders window's CLI actions; `home.json` grants Settings' account and model actions. Check the target window's capability when adding a native call.
- Resolve `DesktopPaths` once before opening windows. Pass its data directory and environment to every shell-run `epicenter` command so the CLI uses the same locations.