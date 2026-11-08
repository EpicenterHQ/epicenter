# Independent cumulative review

Files read for this review and the acceptance investigation:

```text
repository/
|-- AGENTS.md
|-- README.md
|-- package.json
|-- apps/
|   |-- README.md
|   |-- honeycrisp/
|   |   |-- AGENTS.md
|   |   |-- README.md
|   |   |-- package.json
|   |   |-- svelte.config.js
|   |   |-- vite.config.ts
|   |   |-- host/
|   |   |   |-- main.ts
|   |   |   |-- serve.ts
|   |   |   |-- serve.test.ts
|   |   |   |-- faults.ts
|   |   |   |-- terminal.ts
|   |   |   `-- watch.ts
|   |   |-- scripts/
|   |   |   |-- build-host.ts
|   |   |   `-- module-graph.ts
|   |   |-- src-tauri/
|   |   |   |-- Cargo.toml
|   |   |   |-- tauri.conf.json
|   |   |   `-- src/lib.rs
|   |   `-- src/
|   |       |-- lib/
|   |       |   |-- data.ts
|   |       |   |-- draft.svelte.ts
|   |       |   |-- note-source.ts
|   |       |   |-- notes.svelte.ts
|   |       |   |-- terminal.svelte.ts
|   |       |   |-- bridge/
|   |       |   |   |-- codec.ts
|   |       |   |   |-- contract.ts
|   |       |   |   |-- folder-client.ts
|   |       |   |   `-- notes-host.ts
|   |       |   |-- platform/
|   |       |   |   |-- types.ts
|   |       |   |   |-- notes-host.browser.ts
|   |       |   |   `-- notes-host.tauri.ts
|   |       |   |-- platform-selection.test.ts
|   |       |   `-- editor/
|   |       |       |-- schema.ts
|   |       |       |-- markdown.ts
|   |       |       `-- rich-session.ts
|   |       `-- routes/
|   |           |-- +page.svelte
|   |           `-- components/
|   |               |-- NotesView.svelte
|   |               |-- RichEditor.svelte
|   |               |-- NoteDetail.svelte
|   |               |-- DraftStatus.svelte
|   |               |-- AppHeader.svelte
|   |               |-- FaultPanel.svelte
|   |               |-- FolderNav.svelte
|   |               |-- FileBrowser.svelte
|   |               |-- FileView.svelte
|   |               `-- NoteHistory.svelte
|   `-- whispering/src-tauri/src/lib.rs
`-- packages/app/src/product-startup.test.ts
```

The window owns editing drafts and ProseMirror history. The Bun host owns one opened native folder; current files own saved data. The Rust shell owns the child lifetime and explicit permission to close. The bridge isolates native storage and authenticated loopback requests from the frontend. The browser leaf selects a logical folder at build time.

Repaired findings:

- The initial rich editor recreated its view during typing and its serializer could drop boundary whitespace. Independent probes caught both before integration; the worker repaired the stable view lifetime and lossless whitespace spelling, with document and session regressions.
- Integration encountered the concurrently removed FieldsOf type. Honeycrisp now derives fields with the shared CreateRowOf API.
- The initial native shutdown killed the host immediately. The shell now closes stdin, waits for folder/Git shutdown, and kills only after its bounded shutdown timeout.
- Actual native Command-Q bypassed Tauri's preventable exit through Cocoa's predefined menu item. A custom Quit action now asks the page; native regression testing confirmed the draft remains and discard requires a choice.
- The shell's last reported draft count could lag behind typing. Every native close now needs explicit page acknowledgment. A stopped host does not approve closure, and the page has an explicit discard path when the host is unavailable.
- Close requests could be lost during stream disconnect or before the mounted page registered its listener. Both sides retain the request until the page receives it; two native-host integration regressions cover these cases.

Boundaries retained:

- The draft owns conditional save acknowledgment, external observations, and recovery. The rich session owns ProseMirror state, history, and semantic roundtrip validation. Its DOM-free boundary earns its place through real transaction and history tests.
- Platform leaves earn their boundary by preventing native and browser storage from entering the wrong runtime.
- The app-owned bridge remains separate from Whispering's while their close protocols converge. Extracting a shared transport is outside this milestone; duplication is cheaper than coupling their distinct app operations.
- Unsupported Markdown remains Source-only. Extending the schema is a product decision, not a fallback parser or compatibility layer.

Native retesting confirmed immediate Cmd+Q retention, host-loss Source recovery, and explicit discard quit. The obsolete build:epicenter script was removed. Acceptance evidence is recorded in this directory. No staging, commits, reset, branch deletion, or unrelated source edits were performed.
