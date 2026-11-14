# 0815. The platform gives a window its folder, and every app the same home

- **Status:** Superseded
- **Date:** 2026-11-06
- **Superseded by:** [ADR-0899](0899-the-folder-sync-product-is-retired.md): the folder sync product is retired, and this record is its history.
- **Amends:** [ADR-0773](0773-a-folder-opens-at-a-place-every-place-is-a-store-and-the-server-never-merges.md) at `openFolder(contract, home({ site, account }))`: an app opens its window's folder with `openFolder(view)`, and `home` goes; [ADR-0792](0792-an-account-asks-for-what-the-capabilities-that-take-it-need.md) at `home` declaring the repository as an account's need: an app's account serves only hosted features, and syncing a folder is the platform's; [ADR-0790](0790-the-epicenter-app-is-a-library-over-every-folder-and-the-cli-answers-its-queries.md) at the library as an app of its own: it is the platform's home with a lens that shows any folder; [ADR-0804](0804-a-computer-keeps-a-plain-folder-and-every-surface-syncs-with-one-typescript-function.md) at the sync package's moments being wired per app: the window's runtime runs them.
- **Relates:** [ADR-0813](0813-epicenter-is-your-folders-and-apps-are-lenses.md) (folders and lenses), [ADR-0814](0814-one-window-shows-one-folder.md) (one window, one folder), [ADR-0772](0772-a-folder-says-what-it-is-in-agents-md-and-this-computer-keeps-the-rest.md) (discovery follows links).
- **Amended by:** [ADR-0816](0816-the-epicenter-app-is-where-a-person-sees-and-manages-every-folder.md) at "the library": the app is called Epicenter.
- **Amended by:** [ADR-0825](0825-the-epicenter-folder-contains-its-folders.md) at discovery following links: Epicenter syncs the real directories in the Epicenter folder and shows a link as outside it.
- **Unbuilt:** all of it: `openFolder(view)`; history in every window; the window's runtime opening, connecting, and syncing its folder; the home screen every app shows; the library as the home with a lens over any folder; discovery listing `~/Epicenter` and following links; removing `home` and an app's account from its folder.

## Context

An app chose its place with `home({ site, account })`, passed an account so a
folder could sync, and was to wire the sync moments itself. Under ADR-0814 a
window shows one folder that the platform chooses, so an app no longer chooses
a place, and every app needs the same first screen: the folders it can open,
and a way to make one. The library (ADR-0790) was to show every folder and a
generic table for any of them.

## Decision

**An app opens its window's folder through its view.**

```ts
export const folder = openFolder(todosView); // the folder this window was opened on, already connected
export const ai = openAi({ account });        // an account only for hosted features
```

Each window is its own page, so a module belongs to one window, and the folder
is the one the window was opened on: from the home, the library, File, Open,
or on the web the id in its address. A window opened on no folder shows the
home. The window's runtime (the shell on the desktop, the page on the web)
opens the folder, connects it, and syncs it at its moments; an app's code
chooses no place, passes no account for its data, and wires no sync.

**History is the platform's, in every window.** Any app's window offers an
item's versions and the folder's timeline, and restores either, from the
folder's history on the server, one Git repository per folder; the library
shows the same across folders, and agents use `epicenter log`, `diff`, and
`restore`. No app builds history.

**Every app's home is the platform's.** It lists the folders an app can open
(those whose contract fits its view), their state (never synced, synced,
shared), and offers to make a folder, to open one in a window, and to share
it. An app writes only its window.

**The library is Epicenter's Finder: the home with a lens that shows any
folder.** Its home lists every folder; its window shows a folder's collections
as tables, or its files when it has no contract; and it holds the views across
folders, search and queries over everything.

**This is the document architecture of desktop systems, with a folder as the
document.** The platform gives what a system gives a document-based app (a
start screen and Open, one window per document, autosave, versions, sharing,
sync), and an app gives a view and a window.

**Discovery lists `~/Epicenter` and follows links.** A folder that lives
elsewhere joins by a symbolic link there; nothing is registered.

## Consequences

- An app is a view and a window.
- Every app starts on the same home screen.
- The library is not designed apart from the platform.
- No program keeps a list of folders.
