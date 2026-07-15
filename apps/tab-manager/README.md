# Tab Manager

Live tabs and saved tabs are fundamentally different things. Live tabs mirror Chrome's reality. They're ephemeral, they vanish on restart, and they're not yours to own. Saved tabs and bookmarks are workspace data: they persist, sync across devices, and survive browser restarts. Tab Manager is a browser extension that keeps these two layers separate and bridges them with an AI chat drawer that can act on your workspace.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo. AGPL-3.0 licensed.

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│  WXT Side Panel (Svelte app)                     │
├──────────────────────────────────────────────────┤
│  Chrome APIs (tabs, windows, identity)           │
├──────────────┬───────────────────────────────────┤
│  Browser     │  Workspace state (saved tabs,     │
│  state       │  bookmarks, chat, tool trust)     │
│  (ephemeral) │  @epicenter/workspace + sync      │
├──────────────┴───────────────────────────────────┤
│  @epicenter/workspace/agent tool catalog         │
└──────────────────────────────────────────────────┘
```

The extension never fights Chrome for ownership of tab state. Ephemeral state seeds from `chrome.windows.getAll` and stays current via event listeners. Workspace state persists to IndexedDB, syncs over WebSocket, and replicates to every device you sign into.

---

## How it works

### Browser state

On load, `browser-state.svelte.ts` seeds a reactive map of every open window and tab. Chrome's tab and window event listeners keep it current. This layer exposes actions: close, activate, pin, mute, reload, and duplicate. They are all backed by Chrome APIs. Nothing here persists; it's a mirror.

### Workspace state

Saved tabs and bookmarks live in Epicenter workspace tables and sync across devices over WebSocket. The UI reads from these tables via `fromTable` and writes through workspace actions. Save a tab on your laptop and it shows up on your desktop.

### Side panel

A Svelte app mounted into `#app`. There's no popup and no content scripts. Everything runs in the side panel, which opens when you click the extension action button. The background service worker is minimal; its only job is to open the side panel on click.

### UI

The main UI has a search bar with case-sensitive, regex, and exact-match toggles; a unified tab list that shows open tabs grouped by window alongside saved tabs and bookmarks in a single virtualized list; per-tab actions; a command palette for bulk operations (dedupe, group by domain, sort, close by domain, save all); and a sync status indicator.

---

## Workspace schema

Workspace ID: `epicenter-tab-manager`. Four root tables:

| Table | Key | Notable fields |
|---|---|---|
| `savedTabs` | `SavedTabId` | `url`, `title`, `favIconUrl?`, `pinned`, `savedAt` |
| `bookmarks` | `BookmarkId` | `url`, `title`, `favIconUrl?`, `description?`, `createdAt` |
| `conversations` | `ConversationId` | `title`, `model`, `createdAt`, `updatedAt` |
| `toolTrust` | tool name | presence row for "always allow" |

Conversation messages live in the per-row `conversations.messages` child doc, not a root `chatMessages` table.

---

## AI chat

The `AiDrawer` component supports multiple conversations. Chat inference needs a signed-in remote connection, but the drawer and its local conversation metadata do not gate the extension shell. Workspace actions are exposed to AI through `createLocalToolCatalog` from `@epicenter/workspace/agent`, so the AI can read and write workspace data directly.

Destructive tool calls require inline approval before they execute. Each tool can also be set to "always allow," and that preference is stored in the `toolTrust` table, so it syncs across all your devices like any other workspace data.

---

## Development

Prerequisites: [Bun](https://bun.sh).

```bash
git clone https://github.com/EpicenterHQ/epicenter.git
cd epicenter
bun install
bun dev:tab-manager
```

From the repo root, `bun dev:tab-manager` starts the local API and the WXT extension dev server. Bare `bun dev` currently aliases this default workflow. To work on only the extension UI, run:

```bash
bun dev:tab-manager:ui
```

To load the extension in Chrome: open `chrome://extensions`, enable Developer Mode, click "Load unpacked," and select the `apps/tab-manager/.output/chrome-mv3-dev` directory.

The package-local `bun dev` still starts WXT only, but the root commands are the preferred dev entrypoints.


Firefox:

```bash
bun run dev:firefox
```

To build for distribution:

```bash
bun run build          # Chrome
bun run zip            # Package for Chrome Web Store
bun run zip:firefox    # Package for Firefox Add-ons
```

Auth uses Google OAuth via `browser.identity`. The workspace always mounts: signed out uses bare local IndexedDB storage, and signed in uses principal-scoped storage plus relay sync.

---

## Tech stack

- [WXT](https://wxt.dev): browser extension framework
- [Svelte 5](https://svelte.dev): UI (side panel)
- [Yjs](https://yjs.dev): CRDT engine
- [virtua](https://github.com/inokawa/virtua): virtualized tab list
- [Tailwind CSS](https://tailwindcss.com): styling
- `@epicenter/workspace`: CRDT-backed tables, sync, persistence
- `@epicenter/workspace/agent` `createLocalToolCatalog` - workspace-to-agent tool bridge
- `@epicenter/svelte`: auth integration
- `@epicenter/ui`: shadcn-svelte component library

---

## License

AGPL-3.0
