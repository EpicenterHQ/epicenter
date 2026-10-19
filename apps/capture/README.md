# Capture

Capture keeps dated captures, newest first. Each capture is one Markdown file:
its text, then its thoughts as a bullet list under `## Thoughts`. The files
are the saved data. There is no account and no sign-in. The file format and
its rules are in [`packages/capture`](../../packages/capture/README.md).

Capture opens one local folder with
`openFolder({ tables: captureTables })` from `@epicenter/folder`. The browser
build uses IndexedDB; the installed build uses a granted directory. The folder
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

Before opening anything, the page looks for those directories
through the Folder opener's read-only OPFS guard. While one exists, Capture opens nothing and
says where those captures are, rather than show an empty timeline as if they
were lost. When the check itself fails, Capture opens nothing either, and
offers Check again. The check only looks: it creates, moves, and deletes
nothing. Bringing those captures across is separate work.

## What you can do

- **New capture** saves the text exactly as written, with an empty Thoughts
  section. The file is named for the time, `captures/20261001-023000-ab12c.md`.
  Ctrl or ⌘ + Enter adds it, and the new capture opens with the cursor in
  Add a thought. Closing the form keeps its text.
- Open a capture from the timeline to edit its text, and to add, edit,
  reorder, copy, and delete thoughts. A thought can span lines and hold
  nested Markdown. Add a thought sits after the last thought, which is where
  a new one goes; Ctrl or ⌘ + Enter adds it. Each thought's Actions menu
  holds Edit, Move up, Move down, Copy text, and Delete.
- **Edit as text** opens the capture's file, frontmatter included, as
  Markdown to edit directly. Anything Markdown allows can go there. **Open as
  capture** goes back once the file reads as a capture.
- **More** holds Copy capture text, Download file, and **Delete capture**.
  Download saves the edit first and downloads the file as saved. Deleting
  asks first and says a deleted capture cannot be brought back: there is no
  history. It waits for your edits to be saved, then deletes the file as it
  is stored then; a file another tab changed in that moment is kept, and a
  notice says so.

One capture is open at a time. Moving a thought to another capture has no
control: cut it from one capture and paste it into the other.

The timeline lists only files that read as captures. A file that does not
(frontmatter that does not parse, a `capturedAt` that is not a date and
time, or an ambiguous layout: two "Thoughts" headings, text between the
heading and the list, two lists) is named below the timeline with its path
and why, and opens as text. Nothing is rewritten to make it fit. Files that
are not text are listed apart and not opened.

## Editing

- A capture's text and thoughts are its document, so an edit is the row's
  draft in the local folder's edit layer (`edits.row`): the row it started
  from, taken at your first change, and the body you typed. What the page
  reads from the folder never replaces it; another tab's change shows once
  your edit is saved. A thought you add, edit, delete, or move is saved at
  once. The capture text is saved a second after you stop typing, when you
  leave the text box, and when you open something else. Saves of one
  capture run one at a time, and what you typed while one ran goes in the
  next.
- The capture view edits text and thoughts; each change is checked to read
  back as written before it is saved. A change Markdown would not keep
  (text that opens a code fence and would absorb the Thoughts section, say)
  is not applied, the reason is shown, and the text returns to what it was.
  Edit as text to write unfinished Markdown.
- Each save sends the change from where the edit started, and the folder
  merges it with whatever was saved since: what only the other tab changed
  stays, and where you both changed the same field or line, your edit wins,
  with no notice. An edit to a capture another tab deleted brings the file
  back with your edit: an unseen delete never erases an edit.
- A save that fails keeps your edit on screen. The capture says **Your edit
  is not saved** with the reason, and offers Save again, Copy your text, and
  Discard edit. The header says Not saved, and the timeline names every
  capture with a failed save. Your next change saves it again too.
- A save writes the row with only its body replaced: frontmatter keys
  Capture does not declare, and their spelling, stay.
- Edit as text saves the whole text over the file it started from, a second
  after you stop typing, when you leave the text box, and when you open
  something else, valid or not, and keeps the file's line endings. It merges
  with a change another tab saved since, the same way. What keeps the file
  from reading as a capture is read from the file as saved, so it follows
  the text a moment after typing pauses. Open as capture saves the text
  first and opens the capture view only when the saved file reads as one.
- Thought commands name the list they were shown. A thought edit names the
  thought it started from. If that changed before you save (another tab's
  change, say), nothing is applied and the edit's text stays in the form to
  copy.
- Every view reads the one rows query of the captures table. Another tab of
  Capture that saves reaches this page on the folder's change channel, which
  marks those rows stale; returning to the window reads nothing.
- Opening and listing captures write nothing.

## Text not added yet

Text you typed and did not add lives only in the open page: the New capture
text, a thought typed in Add a thought, and a thought being edited. Any
typed character counts, spaces included, until you add it or clear it.

- Each capture keeps its own Add a thought text and thought edit while you
  open other captures. Leaving a capture never asks anything.
- The New capture text stays in its form while you open and leave captures.
- Reloading, closing the tab, or leaving the app asks first while any of it
  exists, a save is still running or waiting, or an edit could not be saved.
  The reload shortcut is refused with a message.

Nothing persists text not added across a reload you confirm.

## How it is wired

```text
+page.svelte
  findEarlierCaptures()            looks in OPFS, writes nothing
  <FolderApp title="Capture" tables={captureTables}>
    openFolder({ tables })         this origin's local folder, in IndexedDB
    createFolderContext       rows query, change channel, edit layer, close
    <CaptureApp>
      createCaptures(getFolder())
```

`<FolderApp>` (from `@epicenter/svelte/folder-app`) opens the
folder, shows one loading screen and one refusal screen, provides the
folder's context, sends the edits held when the page is hidden, and closes
the folder when the page goes away: the edit layer refuses input, sends
every draft once, and waits for the saves, then the folder closes.

The edit layer drafts a row's fields and body. Edit as text changes the
whole file, so its drafts are Capture's own (`src/lib/text-drafts.ts`),
saved through the folder's files. The context's close does not know them,
so `CaptureApp` sends them when the page hides and when it goes away.

`installedAppViteConfig` (from `@epicenter/vite-config`) points the bare
`@epicenter/folder` specifier at one entry per build, so each build emits
one adapter.

## Desktop

The installed build opens the directory Epicenter's shell grants its window.
It uses the same Folder row and merge rules as the browser, with guarded
directory writes. A missing grant is shown as a refusal. Git and remote
actions remain absent.

## Layout

| Path | Role |
| --- | --- |
| `src/routes/+page.svelte` | `<FolderApp>` over `captureTables`, with `CaptureApp` inside it. The Folder opener checks earlier OPFS data before opening IndexedDB. |
| `src/lib/captures.svelte.ts` | The store over the context `getFolder()` answers: the timeline from the rows query, each capture's form (`formOf`), the text drafts (`texts`), create, delete, which capture is open, and what the header says about saving. |
| `src/lib/capture-form.svelte.ts` | One capture's edit over its row draft (`edits.row`), its input not added yet (a new thought, a thought edit), and the commands that turn a change of text or thoughts into a new body. |
| `src/lib/text-drafts.ts` | Edit as text: whole-file drafts saved through the folder's files, one save at a time. |
| `src/lib/item-actions.ts` | Deleting a capture with its confirmation. |
| `src/lib/components/` | `CaptureApp.svelte` builds the store and shows the timeline or the open capture under the save status; `CaptureDetail.svelte` and `TextDetail.svelte` are the open capture as text and thoughts or as Markdown, each showing the edit not saved yet over the cache. Each is keyed by the open capture. |

The package exports nothing. No host imports a part of this app.

## Checks

```sh
bun test packages/capture
bun run --cwd apps/capture test             # unit tests, then the mounted components
bun run --cwd packages/capture typecheck
bun run --cwd apps/capture typecheck        # the app and the scripts
bun run --cwd apps/capture build            # browser
bun run --cwd apps/capture build:installed  # the build Epicenter installs
bun scripts/check-ui-boundary.ts
```

The browser build writes `build/` and serves a fallback page. The installed
build writes `dist/` here and prerenders each page with relative asset paths,
so it runs below whatever path the host serves it at. The two builds share
SvelteKit's output directory, so run them one after the other. The mounted
tests run with `--conditions=browser --conditions=svelte` (`test:mounted`),
so Svelte and the UI kit resolve as a page build resolves them. Tests run
the real local folder over `fake-indexeddb`; a second handle of the same
profile stands in for another tab.

| Test | What it checks |
| --- | --- |
| `src/lib/captures.test.ts` | The store over a real local folder: creating and listing, blank text refused, timeline order and repairs, an edit saved keeping undeclared frontmatter, another tab's change merged with a held save, a failed save kept and saved again, thought commands and stale ones, thought text kept per capture, Edit as text saved exactly and merged with another tab, repair as text, a failed text save, delete after the edits land, and close. |
| `src/lib/bundle.test.ts` | Which folder adapter each build bundles: the installed bundle has the desktop adapter and no browser adapter, local folder engine, OPFS store, or Node module; the browser bundle has the browser adapter and the local folder engine; neither has the older `FolderApp`. |
| `src/lib/components/*.mounted.test.ts` | The real views and page mounted in jsdom: text and thoughts saved, another tab's change merged with typing held here, a failed save with Save again, a thought not added kept to copy, repair as text and Open as capture, CRLF kept, input refused while closing, the New capture text box and Add capture, the failed-save list, an earlier OPFS folder opening nothing and touching nothing, a failed check, a fresh browser with no Save version, and edits sent when the page closes. jsdom has no layout, focus, selection, or IME. |

| Script | What it checks |
| --- | --- |
| `bun run --cwd apps/capture smoke:browser` | The browser build in Chromium, with two pages sharing one profile's local folder: exact saved Markdown, thought edits, keyboard submit, Edit as text, a save merged with another page's change, no Save version, leave warnings, deletion, and a profile with an earlier OPFS folder opening nothing. Needs a free local port and `bun x playwright install chromium`. |

## Changed promises

This version moves Capture to the local folder (`openFolder({ tables })`)
and drops these promises of the version before it:

- There is no Save version and no Git history. A deleted capture cannot be
  brought back, and the delete dialog no longer says whether the latest
  changes are in a saved version.
- The desktop build uses the native Folder over its granted directory.
- Captures an earlier browser build kept in OPFS are not shown; Capture
  opens nothing while they exist.
- An edit beats a delete it has not seen: an edit to a capture another tab
  deleted brings it back (the folder's merge rule), where before the edit
  wrote nothing and offered its text.
- Edit as text merges with a change saved since, where before it wrote
  nothing and offered the text to copy.
- What keeps a file edited as text from reading as a capture is read from
  the file as saved, a moment after typing pauses, not live from the text.
- A failed save is shown in the capture and listed on the timeline, not as a
  toast.
- A capture's frontmatter keeps its own spelling on a body save, where
  before it took the standard form.
