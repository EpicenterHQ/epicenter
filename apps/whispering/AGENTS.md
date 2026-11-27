# Whispering

Whispering runs as a desktop app and in a browser tab from one page. These
rules keep that one page from asking where it runs. The
[README](README.md) explains the layout and the reasons.

- Only `src/lib/platform/` imports `@tauri-apps/*`, and only
  `src/lib/platform/index.ts` chooses between desktop and browser.
- A capability that differs is a folder under `platform/`: a contract file
  with the type, plus `native.ts` and `browser.ts` that implement it.
- `src/lib/data/` holds the rules about stored files. It reads and writes
  through `files` from `platform` and keeps nothing in memory.
- `src/lib/queries.ts` is the only cache. Screens read through its queries
  and write through its mutations; every write refreshes every query.
- `src/lib/dictation.svelte.ts` is the one place the record, save,
  transcribe, clean up and copy sequence is written; `src/lib/cleanup.ts`
  holds its pure rules.
- Screens read dictation through `getDictation()` (`DictationView` in
  `src/lib/dictation-view.ts`); only `+layout.svelte` imports
  `dictation.svelte.ts`.
