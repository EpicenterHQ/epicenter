# 0601. The generic editor edits a file's text, so a row is repaired there

- **Status:** Accepted
- **Date:** 2026-10-17
- **Relates:** [ADR-0586](0586-you-open-a-folder-never-an-app.md) (the generic editor is its own app, reached by "Show files"), [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md) (a row that does not fit reads as an invalid row, for repair).
- **Unbuilt:** text editing of a file in the generic editor, and an in-app text repair in Todos, which lists invalid rows and says to fix them in a text editor (`apps/todos/src/routes/components/TodoList.svelte:95-100`), and in Whispering. Capture has one (`apps/capture/src/lib/components/TextDetail.svelte`).

## Context

A row that does not fit its app's fields reads as an invalid row, "for
repair" (ADR-0585). The generic editor today shows an invalid row's text
read-only, in a `<pre>` beside its issues
(`apps/epicenter/src/folders/TableGrid.svelte:182-193`), and edits a valid
row only by field and body (`FieldEditor.svelte`, `RowBody.svelte`). Every
folder has a "Show files" action that opens it in the editor (ADR-0586).
A standalone browser app keeps its folder in its origin's storage
(ADR-0586), which no editor in another origin can open.

## Decision

**The generic editor edits the text of any file in the folder it was
handed, an invalid row included.** On the desktop, repairing a row is
"Show files", then editing that file's text; an app needs no repair screen
of its own.

**An app that runs in a browser keeps an in-app repair for its invalid
rows,** because no editor reaches its storage.

## Consequences

- A desktop app can show an invalid row as invalid and point at "Show
  files", with no editor of its own.
- With one build per app (ADR-0598), the in-app repair ships in every
  build; a desktop window may show "Show files" in its place.
- The editor writes a whole file's text through the folder's one write,
  which merges it as any save does (ADR-0576).
