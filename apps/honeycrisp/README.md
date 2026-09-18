# Honeycrisp

Honeycrisp is a local-first notes app. The whole database is one Yjs document:
folders and notes are rows in it, and each note's body is the node
nested on its note row, merging per character.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo. AGPL-3.0 licensed.

---

## How it works

### Layout

Single-SPA SvelteKit app with one destination, `/`. Three panes: sidebar
(folders) → note list → editor. SSR is disabled; the app runs entirely in the
browser as a static site.

### Data layer

`src/lib/application.ts` reads the plain auth client once and opens the notes
for that Account. The application route imports it after mounting, so an auth
callback or route preload opens nothing. Svelte adapts the opened App for UI
reads; it does not choose or replace the library.

```txt
authClient.state.account -> await openApp(definition, { account }) -> ready App
page departure -> editor cleanup -> app.close() -> auth change -> full navigation
```

The same page keeps its App across note selection and application navigation.
Changing account or server starts a fresh document, resetting transient UI.
Whole-library removal is unavailable.

The definition names the application, and `open` resolves which exact
generation of it to open: the newest copy this device holds, else the account's
newest, else a fresh one (ADR-0292, ADR-0339). Nobody chooses that number and
no URL carries it. The store lives at
`epicenter/so.epicenter.honeycrisp/accounts/<authority-id>/<principal-id>/data/so.epicenter.honeycrisp/<n>`:
the opening application, the principal whose copy it is, the data id, then the
number (ADR-0324, amended by ADR-0348).
The document shape is the shared `app`/`kv`/`tables:<name>` grammar in
[ADR-0257](../../docs/adr/0257-the-application-document-has-named-kv-and-table-roots.md).

Every build opens its own store, with no platform seam, and reaches one
authority per signed-in account (ADR-0225/0226). The desktop host serves
Honeycrisp's bundle and brokers its credential; it owns none of its data.

**Reads are synchronous after opening.** The route awaits the `openApp` promise before
mounting `StoreShell`. Opening failure renders the shared recovery screen;
signed-out startup renders connection controls without an App.

**Nothing polls and nothing refreshes.** `data.tables.notes.subscribe(...)`
reports which rows a commit touched, for a local write and for bytes that
arrived from another device alike (ADR-0221). It does NOT fire for an edit
inside a note's content node: that reaches the list only because this app hangs
its own `title`/`updatedAt` write on the node's own signal, and that write is a
row change like any other. The state modules re-read on the signal; there is no generation
counter and no manual refresh anywhere.

### Rich-text editing

A note's body is the `content` node on its note row, declared with a content
codec and minted with the row. `NoteBodyPane.svelte` reaches it through
`notes.openContent(noteId)` and hands the type straight to ProseMirror through
`@y/prosemirror`. Nothing is awaited and nothing is loaded: the type is in the
document the store already holds.

`openContent` also subscribes to that node's own edit signal and writes the
note's `title` and `updatedAt` back onto the row, coalesced to one write per
burst. The store writes no derived fields and no timestamps
(ADR-0297), so this is Honeycrisp's job; `close` stops it.

### Soft deletion

Normal deletion is soft deletion: the note row gets a `deletedAt` timestamp and appears in Recently Deleted. Permanent deletion removes the row, and its node goes with it: the whole nested subtree is reclaimed in the same removal.

### Auth and sync

Signing in comes before the notes, because an authority mints every generation
(ADR-0336): there is no signed-out notebook to fall back to. A signed-out
person meets the sign-in screen, which `routes/+page.svelte` mounts. Signing in
opens the store and attaches sync, and that is the whole of the sharing model.
Every device signed into one account dials one authority
(`principals/<id>/data/so.epicenter.honeycrisp`) and converges; there is
nothing to pair, invite, or approve.

A store's address carries the principal, so two accounts on one device hold two
replicas and neither can open the other's. Somebody else signing in here does
not meet a refusal; they get their own empty notebook, and the first person's
notes stay where they were. Erasing this device's copy is the account popover's
`Forget this device`, which a person invokes and confirms; nothing is deleted
as a step in a protocol (ADR-0281).

The boot screens come from `@epicenter/app-shell/boot-screens`, and
`routes/+page.svelte` lends them the two words that are Honeycrisp's: its name,
and `notes`. There are three sentences for a failed open: another window has
the notes open, this browser has no Web Locks, and everything else.

`src/lib/sync.ts` is Honeycrisp's entire share of the transport: a URL.
Reconnecting on close, reconnecting when the client is stuck behind a gap,
putting the cursor in the URL and watching for a submission nobody answers are
all the library's, because every one of them is correctness rather than
transport (ADR-0222).

---

## Workspace schema

**Data ID:** `so.epicenter.honeycrisp`

### Tables

**`folders`**
| Field | Type |
|---|---|
| `id` | `string` (runtime-minted) |
| `name` | `string` |
| `icon` | `string \| null` |

**`notes`**
| Field | Type |
|---|---|
| `id` | `string` (runtime-minted) |
| `folderId` | `string \| null` |
| `title` | `string` |
| `pinned` | `boolean` |
| `createdAt` | `string.date.iso` |
| `updatedAt` | `string.date.iso` |
| `deletedAt` | `string.date.iso \| null` (soft delete) |
| `content` | live `Y.Type` (Markdown codec) |

A data definition has no optional fields: a field has to be one type through the CRDT
attribute, the exported frontmatter value and the row alike, and "absent" is not a
type. So what would have been optional is nullable, and the application writes
or recovers `null` explicitly.

Each note's body lives at the reserved `content` key on its note row, nested in
the one application document. The table picks its format through a codec;
Epicenter mints the node with the row, collects it with the row, and never looks
inside.

Honeycrisp has no KV schema. View selection, sorting, and URL state live in the Svelte state layer.

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

This starts the browser UI on port 5175 alongside the local API on `localhost:8787`, which auth and sync expect. `bun dev:honeycrisp:ui` runs the UI alone, without the API.

To run Honeycrisp the way it ships, start the host: `bun dev:epicenter`. Honeycrisp has no desktop shell of its own.

### Checking it actually works

There is no browser evidence script here. An account is required (ADR-0336), so
a fresh Chromium meets the sign-in gate and never reaches a note. What proves
the durability claim is `packages/app/evidence/data/browser/durable-store/`, which
drives the store itself across a real reload.

### Manual two-client check

Open the Honeycrisp web UI in two isolated browser profiles and sign both into
the same account. Do not use two ordinary tabs in one profile: they share a
storage partition (ADR-0177), so they are one device rather than two.

---

## Tech stack

- [SvelteKit](https://kit.svelte.dev): UI framework (static adapter, SSR disabled)
- [ProseMirror](https://prosemirror.net) + `@y/prosemirror`: collaborative rich-text editing
- `@y/y` 14: row-owned note body documents
- [Tailwind CSS](https://tailwindcss.com): styling
- [Better Auth](https://better-auth.com): authentication
- `@epicenter/app/store`: the store, its transport, and the data-definition vocabulary
- `@epicenter/sync`: the bearer-in-subprotocol handshake the upgrade uses
- `@epicenter/svelte`: auth and browser lifecycle helpers
- `@epicenter/ui`: shadcn-svelte component library

---

## License

AGPL-3.0
