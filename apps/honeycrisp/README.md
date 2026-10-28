# Honeycrisp

Honeycrisp is a Markdown notes app. Every note is one Markdown file,
`notes/<stem>.md`, in a repository on this device
([`@epicenter/repository`](../../packages/repository)). The page opens it
with the repository's browser host: one SQLite file in this origin's private
storage (OPFS), owned by one leader tab's worker, which every tab of the
origin calls. It opens without an account. When the build names a server,
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
header says **Sending…** while edits wait for the server and **Synced** once it
has them. The server commits to `/tmp/notes.git` a minute after a change, so
`git clone /tmp/notes.git` shows the notes as files.

Checks, from `apps/honeycrisp`:

| Command | What it checks |
| --- | --- |
| `bun run typecheck` | The page, the tests, and the browser tests. |
| `bun run test` | The editor, the bundle contents, then `test:dom`. |
| `bun run test:dom` | The whole page, mounted over the repository engine in this process. |
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
under **Needs repair** with why, and opens as its text, read-only. A folder
file that does not read as one is listed apart. Files deletes them.

Earlier Honeycrisp builds kept notes in a local folder in IndexedDB, and
before that in OPFS. This build opens its repository independently and does
not read or migrate either; their bytes stay where they are.

## Editing

Every edit applies on this device at once and shows at once: the lists are
live queries, and the open note is held open, so its controls read the note
synchronously and write through it. Nothing waits for a save, and nothing is
left unsaved when the page closes. Edits made offline wait in the
repository's outbox and are sent when the server is reachable; while an edit
to a note is unsent, later ones replace it, so typing sends one batch per send.
Edits from elsewhere merge with them. If the engine refuses a write, Honeycrisp
says so in a toast and the controls show the stored note again.

Deleting a logical folder moves its notes out (`folderId: null`) and removes
the folder file in one batch, which lands all or nothing. It refuses while a
note cannot say which folder it is in.

## Header controls

| Control | What it does |
| --- | --- |
| Status | Where notes are kept, and whether edits are waiting for the server. |
| Files (Ctrl+B) | The files this device holds: open any as text, and delete a note or folder file. |

## Layout

| Path | Role |
| --- | --- |
| `src/lib/data.ts` | The lens: `notes` and `folders`, with each file's schema. |
| `src/lib/notes.svelte.ts` | The notes over the repository: live lists, what the detail shows, and every action. |
| `src/lib/note-source.ts` | A note's list preview and the name a person sees. |
| `src/routes/+page.svelte` | `OpenHoneycrisp` over `openBrowserRepository`, with `HoneycrispApp` inside it. |
| `src/routes/components/` | Header, folder list, note list, the note view, files. |
| `browser-tests/` | Playwright tests of the built site. |

## Changed promises

This version moves Honeycrisp to the repository engine. It drops these
promises of the version before it:

- Notes saved by earlier browser builds are not shown.
- **Edit as file** is gone: the repository writes a note only through its
  fields and body, so a file's whole text cannot be replaced, and a note whose
  frontmatter does not parse cannot be repaired here. Its text is shown
  read-only, and it can be deleted.
- Files cannot be created from the file browser, and only note and folder
  files can be deleted; the repository writes no path an app does not name.
- The host build keeps notes in the WebView's storage, as a browser does, not
  in the directory the desktop shell grants.
