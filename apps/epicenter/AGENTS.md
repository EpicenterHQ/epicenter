# Epicenter app constraints

Read [the app README](README.md) for the current desktop surface.

- The Folders window composes `@epicenter/folder/platform` in its page, as the `epicenter` CLI does, and never runs the CLI (ADR-0817). Keep sync, sharing, and history in that package; Rust gives the page only what needs the operating system or a secret (ADR-0793).
- Serve Epicenter's pages through `src-tauri/src/scheme.rs` from `dist/<page>/` at `/<page>/`. Keep its path containment and Content-Security-Policy when adding a page.
- Grant native commands by window label. `folders.json` grants the Folders window `open_home`; `home.json` grants Settings' account and model actions. Check the target window's capability when adding a native call.
- Resolve `DesktopPaths` once before opening windows. Pass its data directory and environment to every shell-run `epicenter` command so the CLI uses the same locations.