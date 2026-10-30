# Honeycrisp on the repository engine, with CodeMirror 6

In-flight spec for ADR-0692. Builds on slice 2 (`packages/repository`: client API, browser host, WebSocket, Svelte adapter; Todos already moved). Moves Honeycrisp's data layer onto the engine and replaces its ProseMirror editor with CodeMirror 6 in a live-preview style, because CodeMirror edits the Markdown text itself: no conversion to and from a document tree, so every edit changes exactly the characters typed, and merges and agents' diffs stay exact.

## 1. Engine changes typing needs
- **Coalesce unsent writes to one path.** While a write to a path is still unsent, a later write to the same path replaces it in the outbox (same base, newer text) instead of adding a row; typing becomes one batch per send, not one per keystroke. A write already sent is never altered.
- **A frozen leader does not stall other tabs.** A call to the leader that gets no answer within a bound (for example 5 s) lets the follower take leadership (Web Locks `steal`) and resend by command id.

## 2. Data layer
Replace Honeycrisp's `@epicenter/folder` data layer (`src/lib/folder.ts`, `data.ts`, `notes.svelte.ts`, `files.ts` and their tests and support) with `defineApp` templates matching its current notes layout and the browser host, plus an optional server URL, as Todos does. Keep its UI.

## 3. The editor (`src/lib/editor/`, a new `NoteEditor.svelte`)
- CodeMirror 6 with `@codemirror/lang-markdown` and a live-preview extension written here: headings, emphasis, inline code, links and task checkboxes render in place; the Markdown syntax of the line holding the cursor is shown. Images and tables may render as plain Markdown in this pass.
- Frontmatter is not shown in the text; its fields are form controls bound to `note.set(...)`.
- Binding to an open note: local changes call `note.edit(body)`; changes from elsewhere are applied as the smallest text changes, annotated so they skip the edit listener and are excluded from undo history, with the selection mapped by CodeMirror.
- Conflict blocks (Git markers with a base section) render as a card widget with Keep this, Keep that and Keep both; resolving is one edit.

## 4. Remove ProseMirror, in one documented commit
After the CodeMirror editor and its tests pass, delete `src/lib/editor/schema.ts`, `markdown.ts`, `rich-text.ts` and their tests, `src/routes/components/RichEditor.svelte`, the `prosemirror-*` dependencies, and any test or bundle check that only exists for them. The commit message is the record for reinstalling it later: say why it was removed (CodeMirror edits the text directly, so no round trip is needed and edits stay exact), list every removed file and every removed package with its version, name the last commit that still contains it, and give the command to restore it (`git checkout <commit> -- <paths>` plus the `bun add` line). Nothing else goes in that commit.

## Tests that define done
- Unit: coalescing (a burst of edits to one path sends one batch with the latest text; a sent write is untouched); opening a note and saving with no edit leaves the file byte-for-byte unchanged.
- Playwright (Chromium and WebKit): headings, bold and a task checkbox render in place and the checkbox toggles in the file; two profiles typing in different paragraphs see each other's text through the local server while each one's cursor stays where it was; a change from the other profile is not undone by Undo; a conflict card appears for a true overlap and resolving it removes the markers; a frozen leader tab (simulated) does not stall another tab.
- Honeycrisp typecheck, tests and a build.

## Verify and report
Package and Honeycrisp checks, Playwright runs. Report deviations and open questions. Standalone commits on `claude/repository-engine`; stage specific files; no attribution; no push.
