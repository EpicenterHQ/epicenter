# Honeycrisp

Honeycrisp is a Markdown notes app. Every note is one Markdown file,
`notes/<stem>.md`, in a repository
([`@epicenter/repository`](../../packages/repository)). The page opens one of
this browser's repositories from the repository chooser
(`RepositoryChooser` from `@epicenter/svelte`): each is a replica in this
origin's private storage (OPFS), owned by one tab's worker, kept only on this
device or synced with a server. The first visit makes one; later visits open
the last one again; the repository's name in the header goes back to the
list. A second tab offers Use here, which moves the repository to it; the
first tab keeps showing its notes under a bar that says so. It opens without
an account.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo.
Licensed under AGPL-3.0-or-later.

## Run it

From the repository root:

| Command | What it does |
| --- | --- |
| `bun dev:honeycrisp` | Starts the browser build on port 5175. |
| `bun build:honeycrisp:ui` | Builds one portable SPA and offline service worker into `apps/honeycrisp/build`. |

To sync, serve a repository on this machine:

```sh
bun packages/repository/scripts/serve.ts /tmp/notes.git --origin http://127.0.0.1:5175
```

In the repository chooser, make a repository with the server
`http://127.0.0.1:8787/`, the repository `notes`, and a name to sync as. Use a
second browser profile, with another name, as a second person. The header
says **Sending…** while edits wait for the server, **Not sent** while a
note's text is held on this device, and **Synced** once the server has
everything. The server commits to `/tmp/notes.git` a minute after a change, so
`git clone /tmp/notes.git` shows the notes as files.

Checks, from `apps/honeycrisp`:

| Command | What it checks |
| --- | --- |
| `bun run typecheck` | The page, the tests, and the browser tests. |
| `bun run test` | The bundle contents, then `test:dom`. |
| `bun run test:dom` | The editor and the whole page, mounted over the repository API on a replica in this process. |
| `bun run test:browser` | The built site in Chromium and WebKit with persistent profiles, each person making their replica in the chooser and syncing through the development server. |

## Where notes live

```text
notes/
└── <stem>.md
folders/
└── <stem>.md
```

`src/lib/data.ts` is the app's lens, `defineApp({ notes, folders })`, with each
file's schema. A note's file stem is its identity. Its frontmatter holds
`title`, `folderId`, `pinned`, `createdAt`, and `deletedAt`; its body is the
note. The list shows the newest notes first, by `createdAt`, grouped under
labels such as "Today" and "Yesterday"; a save moves no timestamp. Folders are
logical: a note belongs to one through `folderId`, so moving a note between
folders changes one field and never moves its file.

The schemas only interpret. A field control sets only its field (`patch`),
and the body is written through the note's editor, so keys Honeycrisp does
not name, their order, and their comments stay as their writer left them. A note file that does not read as a note is listed
under **Needs repair** with why, and opens straight into its source. A folder
file that does not read as one is listed apart. Files deletes them.

**Edit source** on every note opens its whole text, frontmatter included, in
the source editor (`<SourceEditor>` from `@epicenter/svelte`), which saves as
you type. The body and the source are two views of one editor, so switching
between them loses nothing. Its status line says whether the frontmatter
parses, with the line where YAML found the break, and whether the note
matches Honeycrisp's schema, with each issue. Every note on the server
parses: text whose frontmatter does not parse is saved on this device and
held, not sent, until it parses again, and the status says so. Each step of
a repair that parses is sent, and the note lists as a note once it reads as
one, on every device. Any other Markdown file in the repository shows as its
text, read-only.

Earlier Honeycrisp builds kept notes in a local folder in IndexedDB, and
before that in OPFS, and the build before this one opened a fixed repository
named `honeycrisp` with an engine since removed. This build lists only this
browser's replicas and does not read or migrate any of those; their bytes
stay where they are.

## Editing

Notes and folders are held in page memory whole, so the lists, the title
fallback (a note without a title shows its first line) and the search read
them at once, and every edit shows at once. Nothing waits for the server, and
there is no close guard: an edit reaches the tab's worker and its SQLite file
a moment after it is typed, and the tab lets its worker finish those writes
when the page is hidden or frozen, so only a keystroke made in the same
instant as closing the tab can be lost. Edits made offline are sent when the
server is reachable, and edits from elsewhere merge with them. An edit
resolves once it is saved on this device; if it cannot be saved, Honeycrisp
says so in a toast and the controls show the stored note again. A new note
takes typing as soon as its create is stored, a moment after **New note**.

A note's fields are controls above its body: title, folder, and pin. The
body is edited in CodeMirror 6 as the Markdown text itself, in a live-preview
style: headings, bold, italic, strikethrough, inline code, links, and task
checkboxes render in place, and the line holding the cursor shows its
Markdown. Clicking a task's checkbox toggles the one character between its
brackets. Images and tables show as plain Markdown. Frontmatter is never in
the text. Because the editor edits the text and not a document converted from
it, every edit changes exactly the characters typed: opening a note writes
nothing, and the file keeps its spacing. Notes are LF-only, as every note in
a repository is.

A change from elsewhere is applied to the editor in place. The cursor stays
where it was, and Undo takes back only what was typed here. Typing while such
a change arrives keeps it: the editor sends its text over the text it was
typed on, and the repository merges the two once.

When two people's edits overlap, the server writes a labelled conflict block
with a base section into the note. Honeycrisp shows each block as a card with
**Keep this**, **Keep that**, and **Keep both**; choosing is one edit that
removes the markers, and Undo brings them back.

Deleting a logical folder moves its notes out (`folderId: null`) and removes
the folder file in one transaction, which lands all or nothing. It refuses while a
note cannot say which folder it is in.

## Header controls

| Control | What it does |
| --- | --- |
| Repository name | Back to this browser's repositories, to open, make or remove another. |
| Status | Where notes are kept, and whether edits are waiting for the server. |
| Files (Ctrl+B) | The files this device holds: open any as its source, and delete a note or folder file. |

## Layout

| Path | Role |
| --- | --- |
| `src/lib/data.ts` | The lens: `notes` and `folders`, with each file's schema. |
| `src/lib/notes.svelte.ts` | The notes over the repository: the lists from memory, what the detail shows, and every action. |
| `src/lib/editor/` | The CodeMirror editor: `note-editor.ts` composes it from `live-preview.ts`, `conflicts.ts` and `editorBinding` from `@epicenter/svelte/repository`, and `NoteEditor.svelte` mounts it over a note's editor. It knows nothing of Honeycrisp's UI. |
| `src/lib/note-source.ts` | A note's list preview and the name a person sees. |
| `src/routes/+page.svelte` | The repository chooser over `honeycrispApp`, with `HoneycrispApp` inside it. |
| `src/routes/components/` | Header, folder list, note list, the note view, files. |
| `browser-tests/` | Playwright tests of the built site. |

## Changed promises

This version moves Honeycrisp to the repository API. It drops these
promises of the versions before it:

- Notes saved by earlier browser builds are not shown.
- Files cannot be created from the file browser, and only note and folder
  files can be deleted. Markdown files that are neither notes nor folders
  show read-only.
- There are no notices: a change the server refuses stays on this device,
  held with its reason, and a lost delete is not reported.
- The host build keeps notes in the WebView's storage, as a browser does, not
  in the directory the desktop shell grants.
