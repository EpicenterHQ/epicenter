# 0601. Apps keep a route to source repair

- **Status:** Accepted
- **Date:** 2026-10-17
- **Relates:** [ADR-0586](0586-you-open-a-folder-never-an-app.md) (the generic editor is its own app, reached by "Show files"), [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md) (a row that does not fit reads as an invalid row, for repair).
- **Unbuilt:** source repair paths in clients migrating to the local-data API; the Epicenter desktop app is deferred under ADR-0635.

Retired source files below use their last tracked Git snapshot (`commit:path`);
inspect one with `git show commit:path`.

## Context

A row that does not fit its app's fields reads as an invalid row, "for
repair" (ADR-0585). The generic editor today shows an invalid row's text
read-only, in a `<pre>` beside its issues
(`a4fa6201aa89:apps/epicenter/src/folders/TableGrid.svelte`), and edits a valid
row only by field and body (`FieldEditor.svelte`, `RowBody.svelte`). Every
folder has a "Show files" action that opens it in the editor (ADR-0586).
A standalone browser app keeps its folder in its origin's storage
(ADR-0586), which no editor in another origin can open.

## Decision

**A record that cannot be interpreted remains available as file source.**
A parseable value outside an app's schema stays visible with its issue.
Malformed frontmatter can be repaired as text through file access.

**A desktop app can identify the file path for repair in an external editor.**
Its ordinary files remain accessible to the person and agents. Repair does
not require the deferred Epicenter desktop app or a custom repair screen
in every standalone app.

**A web app provides repair within its own web origin.**
An external desktop editor cannot reach its IndexedDB. Its source repair
uses the app's file access and preserves the edit's starting content.

## Consequences

- A schema mismatch is distinct from unparseable source or failed storage.
- The Epicenter desktop app may offer a text editor later. First-iteration
  apps cannot rely on that client to make their source accessible.
