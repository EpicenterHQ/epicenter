# Honeycrisp

Honeycrisp is a Markdown notes app. Each note is a Markdown note at
`notes/<id>.md`: its `title`, `folderId`, `pinned` and `createdAt` in front
matter, its text in the body. Each folder is a note of its own at
`folders/<id>.md` with a `name` (and an optional emoji `icon`). That layout
is Honeycrisp's contract, `src/lib/contract.ts`, published unchanged as
`static/contract.json` (`bun run contract` rewrites it after a change), the
file `epicenter check <url>/contract.json <dir>` checks a folder against. Any
program that writes the layout is a valid writer.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo.
Licensed under AGPL-3.0-or-later.

## The layout

```text
notes/<id>.md     title?, folderId?, pinned?, createdAt; the body is the note
folders/<id>.md   name, icon?
```

Only `createdAt` (an RFC 3339 time) is required of a note, so another
program can write one with just a time and a body. A note with no `title`
shows its first line; one with no `folderId` is in no folder; `pinned` is
false when absent. Honeycrisp names new files with `timeId()`, so ids sort by
when they were made.

A note names its folder by id, so moving a note changes one key and never
moves its file. Deleting a folder deletes its file alone: notes that name it
keep their `folderId`, show in All Notes, and say "A deleted folder" until
moved. That is one write, so it cannot half happen, and it needs no note to
be readable. Deleting a note deletes its file; there is no trash. Signed in,
the repository's history keeps what a delete removed.

Honeycrisp has no settings, so it has no settings note, and keeps no other
files.

## The web app

Honeycrisp opens without an account and has two views (decision 76):

- **On this device** (`/`): the notes and folders in this browser's private
  files (OPFS), at the same paths a folder holds. It works signed out and
  offline.
- **Synced** (`/synced`): signed in with Epicenter, the notes and folders in
  the person's own repository, `<handle>/honeycrisp`. Signed out, it asks
  for a sign-in.

Each view creates, edits, moves, pins, deletes and repairs its own notes and
folders. Signed in, the uploader moves every note and folder on this device
into the repository in the background: it leaves "On this device" and
appears in "Synced", whichever view made it and whenever it was made.
Nothing keeps it on screen across the move. The two views are not merged;
one merged list may come back later.

- Changes made elsewhere (another tab, or a desktop's `epicenter sync`) show
  without a reload, in the open note too.
- A file at a note's or folder's path that does not read as one is listed
  under "Needs repair" with why. It opens as its text; saving fixed text
  replaces the file, written in house style, and text that still does not
  fit is refused with why.

Signing out leaves the browser with only what it never uploaded.

The app signs in as `so.epicenter.honeycrisp` for the server's Git audience
only (`src/lib/auth.ts`, made on first use). The server is
`VITE_EPICENTER_SERVER` at build time, else Epicenter's. The hosted API does
not serve web writes yet, so signing in works against a local or
self-hosted API.

## The desktop app

Honeycrisp's desktop app (`src-tauri/`, identifier `so.epicenter.honeycrisp`)
is the same app in its own window, over a folder on the computer instead of
the browser's files. It never signs in.

- **Its folder is its own** (decisions 81 and 82). On first run a native
  alert asks "Where should Honeycrisp keep its files?": the Epicenter folder
  `~/Epicenter/Honeycrisp` (recommended; `~/Epicenter Dev/Honeycrisp` for the
  dev build, or under `EPICENTER_FOLDER_DIR`), the app's data folder (hidden),
  or "Choose folder…". It makes the folder, or uses one already there with its
  files, and remembers the choice as `folder` in `settings.md`, Honeycrisp's
  machine-local configuration note (`appConfig` from `@epicenter/folder`) in
  its configuration directory, never in the folder. The status popover shows
  the folder and offers "Choose folder…" again, which moves the app to the new
  folder once the old window's saves land. A remembered folder that is gone is
  asked about again. The notes stay when the app is removed. The shell is
  `epicenter-standalone` (`packages/tauri-epicenter-standalone`).
- **Sync is Epicenter's.** "Sync with Epicenter" asks the computer to open
  `epicenter://init?path=<the folder>&contract=https://honeycrisp.epicenter.so/contract.json`
  (`syncWithEpicenter` from `@epicenter/folder/tauri`); Epicenter asks the
  person where to sync and runs `epicenter init`. Until then the folder has no
  history. Once Epicenter adopted it, the header says "Synced by Epicenter"
  (read from the folder's Git configuration, each time the window gains
  focus) and the button goes.
- **Closing waits for saves.** Quit, Cmd-Q and the close button go through
  the leave guard: the window closes once every save, a body still being
  typed included, has landed.

The desktop page is its own build of the same app: `HONEYCRISP_DESKTOP=1`
makes `src/desktop/` the route tree (in `svelte.config.js`) and writes
`build-desktop/`, which the shell loads. Its root opens the window's folder
with `openDevice(honeycrisp)` from `@epicenter/folder/tauri` and renders
`HoneycrispApp` with `view="desktop"`. The web build never contains it, and
nothing checks at run time which build is running. `src-tauri/src/main.rs`
only names Honeycrisp to `epicenter-standalone`.

A clone of the person's repository (`epicenter clone <handle>/honeycrisp`)
is another folder any editor, or the desktop app via "Choose folder…", can
change.

## Editing

The title saves as you type. The body is edited in CodeMirror as the
Markdown text itself, and also saves as you type: every edit changes exactly
the characters typed, so merges and other programs' diffs stay exact. Live
preview renders headings, bold, italic, strikethrough, inline code and links
in place, and a task's `[ ]` as a checkbox that toggles the one character
inside it; the line holding the cursor shows its syntax. Images and tables
show as plain Markdown.

Saves go through `fieldEdit` (`@epicenter/svelte/client`): one at a time,
each made over what the person saw when they began typing. Another writer's
change to other keys is carried over; their change to the same key (the
title, or the body) is a conflict: the editor keeps what was typed and shows
**Not saved** with Save again (which saves over theirs), Discard and Copy. A
change from elsewhere to the body while nothing is waiting is applied to the
open editor as the smallest edits, outside Undo, so the cursor stays.

When two writers' edits of a body overlap in the repository, the merge writes
a conflict block into the note. The editor shows each block as a card with
Keep this, Keep that and Keep both; choosing is one edit, and Undo brings the
block back.

The folder and pin are commands: each saves at once and says so if it could
not.

## Run it

From the repository root:

```sh
bun dev:honeycrisp                         # Vite dev server on http://localhost:5175
bun run --cwd apps/honeycrisp build        # static files in apps/honeycrisp/build/
bun run --cwd apps/honeycrisp demo         # the whole stack, to try it by hand
bun dev:honeycrisp:desktop                 # the desktop app (dev identity, ~/Epicenter Dev)
bun build:honeycrisp:desktop               # Honeycrisp.app, from build-desktop/
```

The desktop scripts build the desktop page (`bun run build:desktop-page`)
first. The native crates share one Cargo workspace and `target/` at the
repository root.

The build is static: any host that answers unknown paths with `index.html`
(for `/auth/callback`) serves it, at an origin the API registers. It also
writes a service worker so a loaded app reopens offline.

`demo` boots a disposable Postgres, the local API with temporary Git and LFS
stores, the built app on `http://localhost:5175`, a demo person, and a
desktop sandbox for the `epicenter` CLI, then prints a sign-in helper URL and
the `epicenter clone`, `check` and `sync` commands for the person's
`honeycrisp` repository. It needs `initdb`, `pg_ctl`, `git` and `git-lfs` on
`PATH`, and port 5175 free. Ctrl-C deletes everything.

## Layout

| Path | Role |
| --- | --- |
| `src/lib/contract.ts` | The contract. |
| `src/lib/device.ts` | The device, a module singleton: this browser's files. |
| `src/lib/honeycrisp.svelte.ts` | The orders (notes newest first, folders by name), what the list and detail show, and the actions over both collections, over one view's client. |
| `src/lib/editor/` | The CodeMirror note editor: the binding that writes local edits and follows changes from elsewhere, live preview, conflict cards. It knows nothing of the app's UI or storage. |
| `src/routes/+layout.svelte` | Every page, the sign-in callback included: the chrome only. |
| `src/routes/(app)/+layout.svelte` | Both views: the leave guard and, signed in, the signed-in boundary (`src/lib/components/SignedIn.svelte`: the repository, `setRepo`, and the uploader, per account). |
| `src/routes/(app)/+page.svelte` | "On this device": `HoneycrispApp` over `fromClient(device)`. |
| `src/routes/(app)/synced/` | "Synced": `HoneycrispApp` over `fromClient(getRepo())`, behind a layout that asks for a sign-in. |
| `src/lib/components/` | The views, which read and write only through the state in context. |
| `src/desktop/` | The desktop page's route tree (`HONEYCRISP_DESKTOP=1`): the chrome, the leave guard, and `HoneycrispApp` over the window's folder. |
| `src/lib/desktop-context.ts`, `desktop-folder.svelte.ts`, `sync-request.ts` | What the desktop header shows of its folder (where it is, whether Epicenter syncs it) and its two actions, set only by the desktop root. |
| `src-tauri/` | The desktop container: `main.rs` names Honeycrisp to `epicenter-standalone`; `capabilities/honeycrisp.json` grants the folder plugin (its folder, and Epicenter's sync request and status) and the shell's `choose_folder` and `folder_path`. |

## Tests

```sh
bun run --cwd apps/honeycrisp test        # contract, state over real devices, the editor over jsdom
bun run --cwd apps/honeycrisp typecheck
cargo test -p honeycrisp               # the container's capability and identity
cargo test -p epicenter-standalone     # first run, the folder setting, Choose folder…, Quit
bun x playwright test -c apps/honeycrisp/playwright.config.ts                    # both engines
bun x playwright test -c apps/honeycrisp/playwright.config.ts --project=webkit   # one
```

The Playwright suite (`e2e/honeycrisp.spec.ts`) starts the same environment
as `demo`, built into a scratch directory (never `build/`), and walks one
person through six steps per engine: create, edit, move, pin and delete
notes and a folder on "On this device" signed out, typing the body into the
editor, while "Synced" asks for a sign-in; sign in, and they upload, leaving
"On this device" and the browser's files and appearing in "Synced", with a
note made on this device signed in following them and one made in "Synced"
going to the repository; `epicenter clone` holds them as the browser wrote
them and `epicenter check` passes; a body edited on the desktop shows in the
note open in "Synced" with no reload, and text typed there reaches the
desktop; a note the desktop wrote that does not read shows in "Synced" with
its text and is repaired there; and signing out leaves the browser empty.
