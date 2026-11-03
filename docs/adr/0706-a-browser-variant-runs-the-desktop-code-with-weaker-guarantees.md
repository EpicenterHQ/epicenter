# 0706. A browser variant runs the desktop code with weaker guarantees

- **Status:** Proposed
- **Date:** 2026-11-03
- **Relates:** [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) (an app's variants and their stores), [ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md) (folder and document stores).
- **Unbuilt:** Whispering's export of every recording and its audio from the local web variant, and an import of that export into a desktop folder; the browser copy of a document.

## Context

ADR-0700 gives an app up to three variants, each with one store: desktop (a
folder on the computer), local web (this browser's files, OPFS), and online web
(the person's repository). The app code is shared. Only the variant's root picks
the store: `openDevice` from `@epicenter/folder/tauri` on desktop, `openDevice`
from `@epicenter/folder/browser` on the local web, and both return
`Client<Contract>` with the same `list`, `get`, `create`, `update`, and
`delete` (`apps/README.md`, "Svelte app root").

Whispering ships the local web variant. Its header shows `ON_THIS_BROWSER`
(`apps/whispering/src/lib/status.ts`), labeled "On this browser", and its
Settings shows `EVICTION_NOTE` in WebKit browsers
(`apps/whispering/src/lib/eviction-note.ts`). Nothing recorded which promises
the browser store keeps and which it drops, so the same code invited the
reading that the two variants are equivalent.

## Decision

**A browser variant runs the same app code as the desktop variant, and keeps
fewer promises.** The difference is the store's, never the app's:

| Promise | Desktop folder | Local web (browser folder) | Document app in a browser |
| --- | --- | --- | --- |
| Visible as files | Yes, in Finder and a terminal | No; OPFS is private to the site | No, until exported |
| Agents and tools read it | Yes | No | Through the `epicenter` CLI ([ADR-0716](0716-agents-edit-a-document-through-one-shot-cli-commands.md)), once synced |
| History and sync | Through Epicenter, when the person sets it up | None; it never uploads | Through the account |
| Survives the browser | Yes | No: clearing site data deletes it, and WebKit deletes it after days without a visit unless `navigator.storage.persisted()` is true, as for a site installed to the Home Screen | The account's copy survives; the browser's copy is rebuilt from it |

**A local web variant says where its data is.** Its page shows "On this
browser" (`ON_THIS_BROWSER`) wherever the desktop variant shows its folder, and
`EVICTION_NOTE` where WebKit may delete the data.

**A local web variant offers an export.** The person can download every note and
attached file as a folder of Markdown notes, the export format of [ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md), and
a desktop variant can import it into a folder after showing which paths
already exist.

**The local web variant stays.** Whispering records in a browser without
sign-in.

## Consequences

- A new variant is a new root over the same components; an app adds a browser
  variant without forking its code.
- The person reads the weaker promise on screen rather than discovering it when
  Safari deletes their recordings.
- The export and import are the only path from a browser to a desktop folder;
  nothing moves on its own when the person installs the desktop app.
- Each local web variant carries the status line, the eviction note, and the
  export as fixed costs.

## Considered alternatives

- **Drop the local web variant.** Variants fall from three to two, and
  Whispering stops working in a browser without sign-in.
- **Treat the browser folder as a replica that syncs.** ADR-0700 rejected
  browser sync; OPFS can be evicted and is not a safe authority.
- **Hide the difference.** The same code makes the variants look equal until the
  data is gone.
