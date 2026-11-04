# 0724. A browser extension keeps its data in a document

- **Status:** Superseded
- **Date:** 2026-11-03
- **Superseded by:** [ADR-0743](0743-tabs-keeps-saved-tabs-as-items-in-a-collection.md): saved tabs are items in a collection, and the extension writes them through the local engine ([ADR-0745](0745-a-browser-extension-writes-through-the-local-epicenter-engine.md)).
- **Amends:** [ADR-0227](0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md) at "The Chrome extension runtime is refused": a browser extension may run when its data is a document, and Tabs is the first.
- **Unbuilt:** all of it: `apps/tabs` and its WXT build; the document sync service it reaches ([ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md)); connecting a local document to the account on sign-in; the extension's grant on its origin.

## Context

ADR-0227 refused the Chrome extension runtime: "An extension has its own
storage model and no WebView host, so keeping it would mean keeping a second
data path for one consumer." Commit `a09f21bae5` ("delete(tab-manager): the
extension runtime is refused", 2026-08-08) removed `apps/tab-manager`, a WXT
extension (`wxt`, `wxt build`, `wxt build -b firefox`) built from one source
for Chrome and Firefox.

[ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md) adds a second
store, the document: a Yjs document synced through the person's account, with
a local copy on each device that opens it. A browser extension can hold that
local copy in its own browser storage and sync it exactly as a web page does.
The second data path 0227 refused is the document path every document app
uses.

## Decision

**A browser extension may keep its data in a document.** The extension
holds the document's local copy in its own browser storage and syncs it
through the account like any document app.

**Tabs is the first document app.** It is built with WXT, Chrome first, with
Firefox built later from the same code.

```txt
open tabs     read live from the browser's tabs API across windows; never synced
              search, close
saved tabs    items in the Tabs document: url, title, savedAt
              saving a tab closes it and adds an item; search, delete
```

**Saving works signed out.** Before sign-in, the extension keeps a local
document in its browser storage, and every save lands there.

**Signing in connects the local document to the account.** The document
becomes `<account>/tabs` (its name per [ADR-0722](0722-an-apps-names-derive-from-its-sites-host.md)) and syncs at once; later
edits sync live to every browser where the extension is signed in. When
`<account>/tabs` already exists, as when a second browser signs in with saved
tabs of its own, the local items merge into the account's document: each item
is keyed by its id, and the CRDT merge keeps both sets.

**The extension signs in with its own grant.** It runs in the browser, not on
the machine, so it uses a grant tied to its site's origin
([ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md)), never the
machine sign-in ([ADR-0720](0720-you-sign-in-a-machine-not-an-app.md)).

**Tabs reaches the rest of Epicenter through its document.** The Epicenter
desktop app lists it beside the person's folders
([ADR-0715](0715-the-epicenter-app-browses-every-folder-and-document-a-person-has.md));
agents read and edit it with `epicenter get` and `epicenter set`
([ADR-0716](0716-agents-edit-a-document-through-one-shot-cli-commands.md));
export writes one `saved/<id>.md` note per item ([ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md)).

## Consequences

- An extension needs no data path of its own: the document's local copy,
  sync, and export are the ones every document app uses.
- A first save needs no account. Signing in later uploads every saved tab.
- Saved tabs from two browsers that were used signed out end up in one
  document after both sign in; a tab saved in both appears twice, under two
  ids.
- Open tabs stay local to each browser: the panel shows only the browser it
  runs in.
- The browser can clear the extension's storage. Saved tabs survive once the
  extension has synced them to the account; signed-out saves do not, and the
  panel says so ([ADR-0706](0706-a-browser-variant-runs-the-desktop-code-with-weaker-guarantees.md)).

## Considered alternatives

- **Saved tabs as a folder written through the hosted repository.** Each save
  is a commit, and nothing saves offline.
- **Requiring sign-in before the first save.** A person installing the
  extension cannot use it until they make an account.
- **The old extension's own storage model.** A second data path for one
  consumer, the reason ADR-0227 refused the extension.
