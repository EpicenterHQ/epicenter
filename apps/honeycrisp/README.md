# Honeycrisp

Honeycrisp is a Markdown notes app. Every note is one Markdown file,
`notes/<stem>.md`, in a repository on this device
([`@epicenter/repository`](../../packages/repository)). The page opens it
with the repository's browser host: one SQLite file in this origin's private
storage (OPFS), owned by one tab's worker. A second tab offers Use here,
which moves the repository to it; the first tab then says it moved. It opens
without an account. When the build names a server,
the repository syncs through it; without one, Honeycrisp keeps everything on
this device.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo.
Licensed under AGPL-3.0-or-later.

## Run it

From the repository root:

| Command | What it does |
| --- | --- |
| `bun dev:honeycrisp` | Starts the browser build on port 5175, keeping notes on this device. |
| `bun build:honeycrisp:ui` | Builds one portable SPA and offline service worker into `apps/honeycrisp/build`. |

To sync, serve a repository on this machine and build Honeycrisp against it:

```sh
bun packages/repository/scripts/serve.ts /tmp/notes.git
VITE_HONEYCRISP_SERVER='ws://127.0.0.1:8787/?user=me' bun dev:honeycrisp
```

Use a second browser profile, with another `user`, as a second person. The
header says **Sending…** while edits wait for the server, **Not sent** while a
note's text is held on this device until its frontmatter parses, and **Synced**
once the server has everything. The server commits to `/tmp/notes.git` a minute after a change, so
`git clone /tmp/notes.git` shows the notes as files.

Checks, from `apps/honeycrisp`:

| Command | What it checks |
| --- | --- |
| `bun run typecheck` | The page, the tests, and the browser tests. |
| `bun run test` | The bundle contents, then `test:dom`. |
| `bun run test:dom` | The editor and the whole page, mounted over the repository engine in this process. |
| `bun run test:browser` | The built site in Chromium and WebKit with persistent profiles, syncing through a local server. |

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

The schemas only interpret. A write changes only the fields and body it
names, so keys Honeycrisp does not name, their order, and their comments stay
as their writer left them. A note file that does not read as a note is listed
under **Needs repair** with why, and opens straight into its source. A folder
file that does not read as one is listed apart. Files deletes them.

**Edit source** on every note opens its whole text, frontmatter included, in
the source editor (`<SourceEditor>` from `@epicenter/svelte`), which saves as
you type. Its status line says whether the frontmatter parses, with the line
where it breaks, and whether the note matches Honeycrisp's schema, with each
issue. A note whose frontmatter parses never syncs text that does not: that
text is saved on this device and held, not sent, until it parses again. A note whose frontmatter does
not parse saves every step of its repair, and lists as a note once it reads
as one, on every device.

Earlier Honeycrisp builds kept notes in a local folder in IndexedDB, and
before that in OPFS. This build opens its repository independently and does
not read or migrate either; their bytes stay where they are.

## Editing

Every edit applies on this device at once and shows at once: the lists are
live queries, and the open note is held open, so its controls read the note
synchronously and write through it. Nothing waits for a save, and there is no
close guard: an edit reaches the tab's worker and its SQLite file a moment
after it is typed, and the tab lets its worker finish those writes when the
page is hidden or frozen, so only a keystroke made in the same instant as
closing the tab can be lost. Edits made offline wait in the
repository's outbox and are sent when the server is reachable; while an edit
to a note is unsent, later ones replace it, so typing sends one batch per send.
Edits from elsewhere merge with them. An edit resolves once it is saved on this
device; if the engine cannot save it, Honeycrisp says so in a toast and the
controls show the stored note again. What the server later does with a saved
edit that the person should know, such as a rename onto a name another note
took, or an edit saved as a copy because its note was deleted and its name
reused, appears under the header as a notice until dismissed. A change the
server could not take keeps the text this device showed, to copy.

A note's fields are controls above its body: title, folder, and pin. The
body is edited in CodeMirror 6 as the Markdown text itself, in a live-preview
style: headings, bold, italic, strikethrough, inline code, links, and task
checkboxes render in place, and the line holding the cursor shows its
Markdown. Clicking a task's checkbox toggles the one character between its
brackets. Images and tables show as plain Markdown. Frontmatter is never in
the text. Because the editor edits the text and not a document converted from
it, every edit changes exactly the characters typed: opening a note writes
nothing, and the file keeps its spacing and line endings (a CRLF body stays
CRLF).

A change from elsewhere is applied to the editor as the smallest text
changes. The cursor stays where it was, and Undo takes back only what was
typed here. Typing while such a change arrives keeps it: each edit is sent as
an edit of the body the editor last showed (`note.edit`), and the repository
merges it onto what it holds.

When two people's edits overlap, the server writes Git conflict markers with
a base section into the note. Honeycrisp shows each block as a card with
**Keep this**, **Keep that**, and **Keep both**; choosing is one edit that
removes the markers, and Undo brings them back.

Deleting a logical folder moves its notes out (`folderId: null`) and removes
the folder file in one batch, which lands all or nothing. It refuses while a
note cannot say which folder it is in.

## Header controls

| Control | What it does |
| --- | --- |
| Status | Where notes are kept, and whether edits are waiting for the server. |
| Files (Ctrl+B) | The files this device holds: open any as its source, and delete a note or folder file. |

## Layout

| Path | Role |
| --- | --- |
| `src/lib/data.ts` | The lens: `notes` and `folders`, with each file's schema. |
| `src/lib/notes.svelte.ts` | The notes over the repository: live lists, what the detail shows, and every action. |
| `src/lib/editor/` | The CodeMirror editor: `note-editor.ts` composes it from `live-preview.ts`, `conflicts.ts` and the binding in `@epicenter/svelte/codemirror`, and `NoteEditor.svelte` mounts it over a body source. It knows nothing of Honeycrisp's UI. |
| `src/lib/note-source.ts` | A note's list preview and the name a person sees. |
| `src/routes/+page.svelte` | `OpenHoneycrisp` over `openBrowserRepository`, with `HoneycrispApp` inside it. |
| `src/routes/components/` | Header, folder list, note list, the note view, files. |
| `browser-tests/` | Playwright tests of the built site. |

## Changed promises

This version moves Honeycrisp to the repository engine. It drops these
promises of the version before it:

- Notes saved by earlier browser builds are not shown.
- Files cannot be created from the file browser, and only note and folder
  files can be deleted.
- The host build keeps notes in the WebView's storage, as a browser does, not
  in the directory the desktop shell grants.
