# Honeycrisp

Honeycrisp is a local-first notes app. Folder and note metadata live as canonical SQLite rows. Each note body is a Yjs document that can sync and merge independently.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo. AGPL-3.0 licensed.

---

## How it works

### Layout

Single-route SvelteKit app with a three-pane layout: sidebar (folders) → note list → editor. SSR is disabled; the app runs entirely in the browser as a static site.

### Data layer

Honeycrisp defines one inert Lens and binds it through a page-owned runtime:

```txt
honeycrispLens
  pure definition: namespace and release-local table interpretations

openHoneycrispBrowserEpicenter()
  browser runtime: device or account SQLite ownership and sync
```

The browser opens one origin-owned replica at boot. Signed out, it remains local. Signing in attaches whole-replica synchronization to the existing data after any required keep-or-discard choice. Row changes invalidate app-owned reactive arrays; the state layer refreshes them through the async table API.

This was a clean break from the legacy root-Yjs and IndexedDB model. Honeycrisp does not probe, import, restore, or delete legacy data. The old database is untouched and unreachable from the new app.

### Rich-text editing

Each note row owns one document. `NoteBodyPane.svelte` opens it through `honeycrisp.openNoteDocument(noteId)`, reads the application-owned `body` root, and disposes the handle when the pane unmounts. ProseMirror binds to that Yjs 14 type through `@y/prosemirror`.

User edits extract the title, preview, and word count and write them back to the note row with an explicit `updatedAt`. Binding-origin transactions do not update metadata, so opening or remotely hydrating a note does not make it look newly edited.

### Soft deletion

Normal deletion is soft deletion: the note row gets a `deletedAt` timestamp and appears in Recently Deleted. Permanent deletion removes the canonical row and revokes its document lease.

### Auth

Google sign-in is optional. The app opens immediately against device storage. A principal change reloads the page so the next boot can choose the account or device runtime. There is no legacy sign-in migration or restore prompt.

---

## Data Lens

**Namespace:** `so.epicenter.honeycrisp`

### Tables

**`folders`**
| Field | Type |
|---|---|
| `id` | `string` (runtime-minted) |
| `name` | `string` |
| `icon` | `string` (optional) |
| `sortOrder` | `number` |

**`notes`**
| Field | Type |
|---|---|
| `id` | `string` (runtime-minted) |
| `folderId` | `FolderId` (optional) |
| `title` | `string` |
| `preview` | `string` |
| `pinned` | `boolean` |
| `createdAt` | `InstantString` |
| `updatedAt` | `InstantString` |
| `deletedAt` | `InstantString` (optional, soft delete) |
| `wordCount` | `number` (optional) |

Each note's body lives in a row-owned document opened by `honeycrisp.openNoteDocument(noteId)`. The editor owns the `body` root name and the handle's lifecycle.

Honeycrisp has no values collection. View selection, sorting, and URL state live in the Svelte state layer.

---

## Other features

- **Pin/unpin**: pinned notes sort to the top of the list.
- **Folder deletion**: re-parents all notes in the folder to unfiled, keeping data intact.
- **Sorting**: by date edited, date created, or title.
- **Search**: filters by title and preview content.
- **Keyboard shortcuts**: `Cmd+N` (new note), `Cmd+Shift+N` (new folder).
- **Context menus**: per-note actions: pin, move to folder, delete, restore.

---

## Development

Prerequisites: [Bun](https://bun.sh).

```bash
git clone https://github.com/EpicenterHQ/epicenter.git
cd epicenter
bun install
bun dev:honeycrisp
```

This starts the desktop app on port 5175 alongside the local API on `localhost:8787`, which auth and sync expect. `bun dev:honeycrisp:ui` runs the browser UI without the API or Tauri shell.

---

## Tech stack

- [SvelteKit](https://kit.svelte.dev): UI framework (static adapter, SSR disabled)
- [ProseMirror](https://prosemirror.net) + `@y/prosemirror`: collaborative rich-text editing
- `@y/y` 14: row-owned note body documents
- [Tailwind CSS](https://tailwindcss.com): styling
- [Better Auth](https://better-auth.com): authentication
- `@epicenter/data`: canonical SQLite rows, values, and local row documents
- `@epicenter/document-sync`: network synchronization for open row documents
- `@epicenter/svelte`: auth and browser lifecycle helpers
- `@epicenter/ui`: shadcn-svelte component library

---

## License

AGPL-3.0
