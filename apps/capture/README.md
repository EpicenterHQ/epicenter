# Capture

Capture keeps dated captures, newest first. Each capture is one Markdown file in `captures/<stem>.md`: its text, then its thoughts as a bullet list under `## Thoughts`. The files are the saved data. There is no account, history, or sync. The file format and its rules are in [`packages/capture`](../../packages/capture/README.md).

Capture opens one folder with `openFolder({ tables: captureTables })` from `@epicenter/folder`. The browser build uses this origin's IndexedDB folder. Inside Epicenter, the desktop build uses the directory granted to its window.

Run the browser app with `bun dev:capture` from the repository root.

## What you can do

- **New capture** holds its text in the form until **Add capture** (or Ctrl or ⌘ + Enter). Add creates one finished file and opens it at Add a thought. Blank text is refused. A failed write leaves the text in the form and shows a toast with the reason.
- Open a capture to edit its text and add, reorder, copy, or delete thoughts. Add a thought is an explicit submission. Its input is cleared when you leave the capture. A thought's Actions menu can open its lines in Edit as text.
- **Edit as text** opens the file with frontmatter. It accepts unfinished Markdown. Needs repair responds to what is typed, and **Open as capture** becomes available when that text reads as a capture. Opening that structured view explicitly saves the text first.
- **More** holds Copy capture text, Download file, and Delete capture. Download explicitly saves the shown body before exporting the saved file text. Deletion asks first; deleted captures have no history to restore from.

One capture is open at a time. The timeline lists captures and files needing repair. A completed file with invalid frontmatter or an ambiguous Thoughts layout opens as text. Binary or temporarily unreadable files are listed separately; a read error offers Try again.

## Editing

The folder mirror shows only files that landed. Every keystroke enters its write queue at once, so later folder actions run after the typing. Each mounted editor shows what was typed until that write answers. The capture editor edits the whole body: capture text and thought commands compose over the same visible body. The text editor edits the whole file. The two editors do not share an edit. Edit as text switches immediately; whole-file edits replace the file at their turn, including earlier body changes only if the text editor includes them. Open as capture waits for the saved file to read as a capture. A failed save keeps its value visible while that editor remains open. The header shows **Saving…** during folder writes and **On this device** otherwise.

An edit save failure keeps the typed value visible in its editor. An inline **Not saved** message offers **Save again**, **Discard**, and **Copy**. Discard returns the editor to the saved file; leaving the editor drops its failed text. Command failures appear at their callers. New capture keeps its unsubmitted form text after a failed Add. A failed Add a thought leaves the thought in the body edit, with an empty Add a thought field, so retrying the body cannot append it twice.

Structured capture edits replace the body through `tables.captures.update`. The update applies over the file when it saves, keeps unknown frontmatter keys, and writes canonical YAML. Comments and original key spelling or order may change. Text editing replaces the whole file, preserving its CRLF line endings when present. Opening and listing write nothing.

Thoughts are identified by their position in the shown list. A move or delete refuses a list that changed beneath it. A thought's Edit as text explicitly saves the shown body, then finds that thought's lines in the saved source so its selection matches the new editor. Another tab's saved changes reach the mirror; when this editor has no pending typing, it follows those saved values.

## Quick Add

New capture and Add a thought are explicit submissions. Their text boxes belong to their components and write nothing before Add. Leaving the view or reloading clears unsubmitted text. [ADR-0658](../../docs/adr/0658-capture-compositions-are-durable-markdown-records.md) records why Capture writes no draft files.

## How it is wired

```text
+page.svelte
  <OpenFolder open={() => openFolder({ tables: captureTables })}>
    <CaptureApp {folder}>
      setFolder(folder)
      createCaptures(folder)
      Timeline or one keyed detail editor
```

`<OpenFolder>` opens, wraps, and closes the folder. It shows opening and refusal screens and refreshes on focus, visibility, and online events. Leaving asks once, only while a write is out; a desktop window close first waits for writes. Text whose save failed is discarded on leaving. Capture's store owns navigation and timeline classification. The folder owns saved rows, files, and the write queue. Each editor component shows its typed text until the save answers and owns inline save recovery. The full-file editor uses the shared `fileEdit` to show LF and save with the file's line endings. Commands present their own failures.

The Vite configuration resolves the `@epicenter/folder` opener to the browser or host adapter for its build.

## Layout

| Path | Role |
| --- | --- |
| `src/routes/+page.svelte` | Opens the folder and passes it to CaptureApp. |
| `src/lib/captures.svelte.ts` | Timeline, Add, deletion, and navigation. |
| `src/lib/capture-actions.svelte.ts` | Thought and text commands over one body edit; saved-source thought location. |
| `src/lib/components/CaptureDetail.svelte` | Structured capture editor with a body edit. |
| `src/lib/components/TextDetail.svelte` | Full-file editor. |
| `src/lib/components/Timeline.svelte` | Saved captures, repair entries, and New Capture. |

The package exports the file model and body codec; it opens no folder.

## Checks

| Command | What it checks |
| --- | --- |
| `bun test packages/capture` | The body codec and schema. |
| `bun run --cwd packages/capture typecheck` | Package types. |
| `bun run --cwd apps/capture typecheck` | App and script types. |
| `bun run --cwd apps/capture test` | Mirror store, bundle graph, and mounted components. |
| `bun run --cwd apps/capture build` | Portable website and offline service worker. |
| `bun run --cwd apps/capture build:host` | Host build. |
| `bun run --cwd apps/capture smoke:browser` | Chromium flow over a shared browser profile. |
| `bun scripts/check-ui-boundary.ts` | UI import boundary. |

The portable build writes `build/`; the host build writes `dist/`. They share SvelteKit's output directory, so run them in sequence. The browser smoke needs a free local port and Chromium installed through `bun x playwright install chromium`.

## Changed promises

This folder-mirror version drops these behaviors from the earlier document engine:

- Shared editable documents between the capture and text views.
- The old document engine's per-file save status, timeline failure list, and Saved to path line. Failed edits show inline recovery controls.
- Folder close fences, loading or Missing states inside an opened detail, and TanStack folder queries.
- Preserving frontmatter comments, key order, or spelling after a structured update. Unknown keys remain.
- Downloading unsaved input. Download now writes the shown body and exports the saved file only after that write lands.
- Edit as text replaces the whole file and reports a deleted file for inline recovery.

The earlier move to the local folder also removed Save version, Git history, sync, and automatic access to captures stored in OPFS.
