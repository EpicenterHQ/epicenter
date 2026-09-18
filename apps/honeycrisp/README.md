# Honeycrisp

Honeycrisp is a local-first notes app with two destinations: Personal and Local.
Both display the same notes UI over separate data with the same schema.
Each scope uses one Yjs document; each note's body is nested on its note row.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo.
Licensed under AGPL-3.0-or-later.

## How it works

`/` redirects to `/personal`. `/local` displays device notes and works signed
out. `/personal` displays account notes or offers sign-in. Both URLs use one
page component, whose mounted AppBoot captures one Account and opens one App. Switching views keeps that App alive.

```text
notes page: AppBoot auth + definition -> ready App
  /local:    Notes data={app.device}
  /personal: Notes data={app.account.personal}
```

The page passes the actual nested handle directly. Notes uses `fromData` for
reactive table reads and passes data through props. Explicit functions own
note operations; there is no second application controller or App context.
The URL chooses the view, with no saved preference or data copy. Shared has
no Honeycrisp view.

Imports, preloading, `/connect`, and `/auth/callback` acquire no App. The browser
build fixes its authentication service; the desktop build receives its Account
from the host, which retains credentials. Account changes finish editor writes,
close the App, and navigate to a fresh document. Retirement closes locally
without replacement. Failed cleanup requires page teardown; unmounting while
opening closes the eventual App.

Each note body is a live content node on its row. The editor subscribes to its
changes to derive title and update time, and finishes pending writes on unmount.
Normal deletion moves a note to Recently Deleted; permanent deletion removes
its row and nested content.

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
- **Sorting**: newest edits first.
- **Search**: filters by title.
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

Run the browser acceptance harness from the repository root:

```bash
bun apps/honeycrisp/scripts/app.browser.ts
```

It starts a temporary local Worker and exercises the Honeycrisp UI in Chromium,
including Local and Personal navigation and Account retirement.

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
- `@epicenter/svelte`: reactive store projections and browser lifecycle helpers
- `@epicenter/ui`: shadcn-svelte component library

---

## License

AGPL-3.0
