# Capture

Capture keeps dated captures, newest first. Each capture is one Markdown file:
its text, then its thoughts as a bullet list under `## Thoughts`. The files
are the saved data. There is no account and no sign-in. The file format and
its rules are in [`packages/capture`](../../packages/capture/README.md).

Capture opens one local folder with
`openFolder({ tables: captureTables })` from `@epicenter/folder`. The browser
build uses IndexedDB; the host build Epicenter bundles uses a granted directory. The folder
keeps no history and syncs nowhere yet: there is no
Save version, Sync, or Connect.

| Build | Folder |
| --- | --- |
| Browser | This origin's local folder, in IndexedDB. A fresh profile starts empty. |
| Desktop, inside Epicenter | The directory the shell grants this window, opened through the native Folder adapter. |

Run the browser build with `bun dev:capture` (or `bun dev:capture:ui`) from
the repository root. It starts the app and nothing else.

## Captures from an earlier version

Earlier browser builds kept captures in the origin private file system
(OPFS): the build before this one in `so.epicenter.capture` at its root, and
older ones in `Epicenter/local/so.epicenter.capture` or
`Epicenter Dev/local/so.epicenter.capture`. This build reads none of them.

The current Folder opens its IndexedDB data independently. It does not read,
inspect, change, or remove the earlier OPFS files. An origin with only older
OPFS captures shows an empty current timeline.

## What you can do

- **New capture**, at the top of the timeline, is a text box. Nothing is
  saved until **Add capture** (or Ctrl or ⌘ + Enter), which writes one
  finished capture file and opens it at Add a thought. Blank text is refused.
  A failed Add keeps the text and says why. Leaving the timeline, reloading,
  or closing clears text not added yet, without asking.
- Open a capture from the timeline to edit its text, and to add, reorder,
  copy, and delete thoughts. A thought can span lines and hold nested
  Markdown. Add a thought sits after the last thought, which is where a new
  one goes; Ctrl or ⌘ + Enter adds it. Like New capture, its text is not
  saved until added, and leaving the capture clears it. Each thought's Actions
  menu holds Edit as text, Move up, Move down, Copy text, and Delete.
- **Drafts** lists `draft: true` files an earlier version saved before Add.
  A draft opens in the full-file Markdown editor, frontmatter included,
  and saves like any edit. **Add capture** finishes that same file, appending
  the Thoughts section and
  setting `capturedAt` to the time of Add. **Discard draft…** asks before
  deleting it. Deletion does not require pending input to save first; a
  failed deletion keeps the file and reports the failure.
- **Edit as text** opens the capture's file, frontmatter included, as
  Markdown to edit directly. Anything Markdown allows can go there,
  unfinished or not. A thought's Edit as text opens the same file with that
  thought's lines selected. **Open as capture** goes back once the file reads
  as a capture.
- **More** holds Copy capture text, Download file, and **Delete capture**.
  Download exports the current acquired text, including unsaved input,
  without writing to the folder. Deleting
  asks first and says a deleted capture cannot be brought back: there is no
  history. Deletion enters the same publication lane as saves without
  flushing input first. New input remains accepted and may recreate it.

One capture is open at a time. Moving a thought to another capture has no
control: cut it from one capture and paste it into the other.

The timeline lists completed captures and, separately, unfinished drafts.
Draft bodies are raw writing and do not need a valid Thoughts layout.
A completed file that does not read as a capture
(frontmatter that does not parse, a `capturedAt` that is not a date and
time, or an ambiguous layout: two "Thoughts" headings, text between the
heading and the list, two lists) is named below the timeline with its path
and why, and opens as text. Nothing is rewritten to make it fit. Files that
are not text are listed apart and not opened.

## Editing

- A capture's text and thoughts are its document, so an edit is the body
  you typed, held by the folder's shared row document
  (`folder.tables.captures.document(stem)`) over the capture as stored. What
  the page reads from the folder never replaces it, and a failed reread never
  hides acquired text after a failed refresh. Every save replaces the whole
  file; the last whole-file publication wins. A thought you add, delete, or move is saved at
  once. The capture text is saved a second after you stop typing, even after you
  open something else. Saves of one
  capture run one at a time, and what you typed while one ran goes in the
  next.
- The capture view edits text and thoughts; each change is checked to read
  back as written before it is saved. A change Markdown would not keep
  (text that opens a code fence and would absorb the Thoughts section, say)
  is not applied, the reason is shown, and the text returns to what it was.
  Edit as text to write unfinished Markdown.
- Accepted input remains editable if another writer changes, deletes, or
  replaces the file with binary content. New input or Save again can recreate
  it. There is no merge or conflict-resolution mode.
- A save that fails keeps your edit on screen. The capture says **Your edit
  is not saved** with the reason, and offers Save again, Copy your text, and
  Discard edit. The header says Not saved, and the timeline names every
  capture with a failed save. Your next change saves it again too.
- A save writes the row with only its body replaced: frontmatter keys
  Capture does not declare, and their spelling, stay.
- Edit as text publishes its complete current text, a second
  after you stop typing, even after you open something else, valid or not, and keeps the file's line endings. What keeps the file
  from reading as a capture is checked against the current edit as you type.
  Open as capture switches views when that edit reads as a capture, without
  waiting for a save. Both views show the same Folder-owned input.
- Thought commands (delete, move, and opening one as text) name the list they
  were shown. If it changed since (another tab's change, say), nothing is
  applied and the reason is shown.
- The timeline reads the one rows query of the captures table; the open
  capture is the folder's edit of its file, which those reads keep current.
  Another tab of Capture that saves reaches this page on the folder's change
  channel: the open capture reads its file again, and the rows are marked
  stale; returning to the window reads nothing.
- Opening and listing captures write nothing.

## Quick Add and drafts

New capture and Add a thought are explicit submissions: each text box's
component owns its text (`$state`) until Add. Typing writes nothing, is not
registered anywhere, and never prompts on reload or close. Add writes it once:
`captures.create(text)` uses `folder.tables.captures.write` to publish a new `captures/<stem>.md` to `capturedAt` and
`composeBody(text).body`; `actions.addThought(text)` changes the open capture's
row edit, which saves at once. The text box clears only when Add is taken.
[ADR-0658](../../docs/adr/0658-capture-compositions-are-durable-markdown-records.md)
records why this text is not kept as draft files.

A draft is an ordinary `captures/<stem>.md` file with optional boolean
`draft: true` frontmatter, which an earlier version wrote before Add. Its body
is the exact raw writing, including spaces, trailing newlines, open fences,
and the writer's own Thoughts headings. It opens in `TextDetail.svelte`
through the same full-file edit used for repair and thought editing, with
**Add capture** and **Discard draft…** beside it. Editing frontmatter does not
replace the mounted editor; invalid frontmatter shows its repair issues and
hides Add. Manually removing `draft: true` makes the file a completed capture
without composing its body or updating its date. Use Add to finish it instead.
Capture writes no new drafts. A nonboolean `draft` value needs repair as text.

`captures.finishDraft(stem)` refuses once closing starts. Promotion composes the editor's current content, including unsaved writing,
removes `draft`, and sets `capturedAt` in the shared working document before
saving. A failed promotion keeps that finalized document and its save error.
**Save again** publishes it without appending another Thoughts section; the
original draft remains on disk until publication succeeds. Input accepted
while promotion is saving stays current and is published afterward.

Creation is a one-shot publication: failure leaves the form's text in the form,
with no pending document that a later flush can create. Existing captures use
one working document per path for typing, thoughts, and programmatic field
changes. `document.patch({ fields, body })` accepts the change synchronously;
`await document.save()` publishes the text captured at that call and reports
success or failure. A failed publication keeps the accepted change for retry.
List and raw reads do not acquire editable text; the mounted document
subscription or explicit `refresh()` does.

## How it is wired

```text
+page.svelte
  <FolderApp open={() => openFolder({ tables: captureTables })}>
    call the app's opener     this origin's local folder, in IndexedDB
    createFolderContext       rows query, change channel, edit layer, close
    <CaptureApp {context}>
      setFolder(context)
      setQueryClientContext(context.queryClient)
      createCaptures(context)
```

`<FolderApp>` (from `@epicenter/svelte/folder-app`) opens the
folder, shows one loading screen and one refusal screen, provides the
folder's context, calls best-effort `flush()` when hidden, and releases the folder
synchronously when the page goes away. Close submits no input and waits for no
writes. Confirmed departure accepts losing unfinished work; callers needing
durable bytes await the write or save they started.

The folder owns one working source per capture path. Both the capture view and Edit as
text use `liveSnapshot(folder.tables.captures.document(stem))` from
`@epicenter/svelte/snapshot`. The view's `.current.text` provides exact text;
`folder.tables.captures.parse(text)` interprets fields, body, and issues when needed. Structured controls
call `patch({ fields, body })`; Edit as text calls `replace(text)`.
Switching between valid views saves and refreshes nothing: both show the same
unsaved input and any save failure. The current editable document determines
whether it can be shown as a capture.

The document's `getSnapshot()` is a pure cached read. Its Svelte
view exposes a tracked `.current` snapshot with `text`, `loadError`,
`isDirty`, `isSaving`, and `saveError`. Commands stay on the handle. Observation activates initial reading; there is no editor
query or mirrored component state. Dirty publication intent and admitted
saving operations are independent. Acquired content survives view unmount,
clean deletion, binary replacement, and failed refresh for the folder lifetime.
Folder-wide save indicators observe aggregate status without opening files.

`hostAppViteConfig` (from `@epicenter/vite-config`) points the bare
`@epicenter/folder` specifier at one entry per build, so each build emits
one adapter.

## Desktop

The host build opens the directory Epicenter's shell grants its window.
It uses the same Folder row interpretation and whole-file publications as
the browser, with ordered directory writes. A missing grant is shown as a refusal. Git and remote
actions remain absent.

## Layout

| Path | Role |
| --- | --- |
| `src/routes/+page.svelte` | `<FolderApp>` over `captureTables`, with `CaptureApp` inside it. The Folder opener uses IndexedDB. |
| `src/lib/captures.svelte.ts` | The store over the context `getFolder()` answers: the timeline from the rows query, `create(text)`, `finishDraft(stem)`, delete, which capture is open and where focus goes, and what the header says about saving. |
| `src/lib/capture-actions.svelte.ts` | Capture-specific commands over the folder's edit of its row: each turns a change of text or thoughts into a new body, and `locateThought` finds a thought's lines for Edit as text. |
| `src/lib/item-actions.ts` | Deleting a capture with its confirmation. |
| `src/lib/components/` | `CaptureApp.svelte` builds the store and shows the timeline or the open capture under the save status; `Timeline.svelte` holds `NewCapture.svelte`; `CaptureDetail.svelte` and `TextDetail.svelte` are the open capture as text and thoughts or as Markdown, each showing the folder's edit of it, what is typed over the file as stored, and `TextDetail.svelte` also edits existing saved drafts with finish and discard actions. Each detail is keyed by the open capture. |

The package exports nothing. No host imports a part of this app.

## Checks

```sh
bun test packages/capture
bun run --cwd apps/capture test             # unit tests, then the mounted components
bun run --cwd packages/capture typecheck
bun run --cwd apps/capture typecheck        # the app and the scripts
bun run --cwd apps/capture build            # browser
bun run --cwd apps/capture build:host       # the build Epicenter bundles
bun scripts/check-ui-boundary.ts
```

The browser build writes `build/` and serves a fallback page. The host
build writes `dist/` here and prerenders each page with relative asset paths,
so it runs below whatever path the host serves it at. The two builds share
SvelteKit's output directory, so run them one after the other. The mounted
tests run with `--conditions=browser --conditions=svelte` (`test:mounted`),
so Svelte and the UI kit resolve as a page build resolves them. Tests run
the real local folder over `fake-indexeddb`; a second handle of the same
profile stands in for another tab.

| Test | What it checks |
| --- | --- |
| `src/lib/captures.test.ts` | The store over a real local folder: Add writing one finished capture, blank and failed Add writing nothing, timeline order and repairs, undeclared frontmatter, outside writes, failed saves and retries, thought commands, CRLF text, unfinished Markdown, repair as text, deletion, and close. |
| `src/lib/compositions.test.ts` | Drafts an earlier version saved: listed apart and read back exactly, finished as the same file with `composeBody`, blank finish refused, failed autosave/finish/discard kept, retry without duplicate Thoughts, close during finish, and another tab finishing while input is held. |
| `src/lib/bundle.test.ts` | Which folder adapter each build bundles: the installed bundle has the desktop adapter and no browser adapter, local folder engine, OPFS store, or Node module; the browser bundle has the browser adapter and the local folder engine; neither has the older `FolderApp`. |
| `src/lib/components/*.mounted.test.ts` | The real views and page mounted in jsdom: New capture writing nothing before Add, thought input and source editing, an outside change preserving accepted input until publication, failed saves and retries, draft repair, CRLF, close, and the failure list. jsdom has no layout, selection, or IME. |

| Script | What it checks |
| --- | --- |
| `bun run --cwd apps/capture smoke:browser` | The browser build in Chromium, with two pages sharing one profile's local folder: unfinished text, exact saved Markdown, Edit as text, another page's write, failed saves, draft repair, deletion, and an earlier OPFS folder. Needs a free local port and `bun x playwright install chromium`. |

## Changed promises

This version moves Capture to the local folder (`openFolder({ tables })`)
and drops these promises of the version before it:

- There is no Save version and no Git history. A deleted capture cannot be
  brought back, and the delete dialog no longer says whether the latest
  changes are in a saved version.
- The desktop build uses the native Folder over its granted directory.
- Captures an earlier browser build kept in OPFS are not shown; the current
  IndexedDB timeline opens independently.
- A deleted capture with a dirty draft remains recoverable. New input or Save again can
  recreate the file.
- Edit as text keeps acquired content available after refresh failures.
- What keeps a file edited as text from reading as a capture is checked
  against current content while typing.
- A failed save is shown in the capture and listed on the timeline, not as a
  toast.
- A capture's frontmatter keeps its own spelling on a body save, where
  before it took the standard form.
- Text typed into New capture or Add a thought and not added is not kept when
  the view goes away, and a thought is edited as text rather than in its own
  Save/Cancel form.
