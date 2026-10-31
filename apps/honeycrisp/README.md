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
be readable. Deleting a note deletes its file; there is no trash. The
repository's Git history keeps what a delete removed.

Honeycrisp has no settings, so it has no settings note, and keeps no other
files.

Honeycrisp is a web app for now; a desktop app comes later. Until then, a
folder of notes on a computer is a clone of the person's repository
(`epicenter clone <handle>/honeycrisp`), kept with `epicenter sync`, and any
editor can change it.

## The web app

Honeycrisp in a browser is its online variant only: the person's own
repository, `<handle>/honeycrisp`, through Epicenter, at `/`. Signed out it
asks for a sign-in; signed in, every create, edit, move, pin and delete is a
commit there, and nothing is kept in the browser. It needs the network;
there is no browser copy to fall back on
([ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)).

The header says where the notes are and whether the repository answers:
Online, Offline when it does not, or Sign in again when the session needs
renewing; Sign out is beside it.

- Changes made elsewhere (another tab, or a desktop's `epicenter sync`) show
  without a reload, in the open note too.
- A file at a note's or folder's path that does not read as one is listed
  under "Needs repair" with why. It opens as its text; saving fixed text
  replaces the file, written in house style, and text that still does not
  fit is refused with why.

Honeycrisp signs in as `so.epicenter.honeycrisp` for the server's Git
audience only (`src/lib/auth.ts`, made on first use). The server is
`VITE_EPICENTER_SERVER` at build time, else Epicenter's. The hosted API does
not serve web writes yet, so signing in works against a local or self-hosted
API.

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
```

The build is static: any host that answers unknown paths with `index.html`
(for `/auth/callback`) serves it, at an origin the API registers.

`demo` boots a disposable Postgres, the local API with temporary Git and LFS
stores, the built app on `http://localhost:5175`, a demo person, and a
desktop sandbox for the `epicenter` CLI, then prints a sign-in helper URL and
the `epicenter clone`, `check` and `sync` commands for the person's
`honeycrisp` repository. It needs `initdb`, `pg_ctl`, `git` and `git-lfs` on
`PATH`, and port 5175 free. Ctrl-C deletes everything.

## How it is wired

```text
routes/+layout.svelte          every page: the chrome and the leave guard
routes/(app)/+layout.svelte    the root that decides the store, the signed-in layout:
                               signed out, a sign-in; signed in,
  Online.svelte                {#key account}: setRepo(openRemote(honeycrisp, { account }))
routes/(app)/+page.svelte      HoneycrispApp over fromClient(getRepo<Honeycrisp>())
  HoneycrispApp.svelte         header (where, status, account), folders, notes, the open note
routes/auth/callback           finishes sign-in, outside (app), then returns to /
```

Components read and write only through the client they are given
(`createHoneycrisp`, in context), never a client of their own; only the
`(app)` layout chooses the store. Another variant, such as the desktop app
to come, needs only a new root that passes `HoneycrispApp` its own store's
client.

| Path | Role |
| --- | --- |
| `src/lib/contract.ts` | The contract. |
| `src/routes/+layout.svelte` | Every page, the sign-in callback included: the chrome and the leave guard. |
| `src/routes/(app)/+layout.svelte` | The signed-in layout: asks for a sign-in, or opens the repository per account. |
| `src/lib/components/Online.svelte` | The repository (`setRepo`), per account. |
| `src/routes/(app)/+page.svelte` | `HoneycrispApp` over `fromClient(getRepo())`. |
| `src/lib/honeycrisp.svelte.ts` | The orders (notes newest first, folders by name), what the list and detail show, and the actions over both collections, over the client it is given. |
| `src/lib/editor/` | The CodeMirror note editor: the binding that writes local edits and follows changes from elsewhere, live preview, conflict cards. It knows nothing of the app's UI or storage. |
| `src/lib/components/` | Honeycrisp's UI, which reads and writes only through the state in context. |

## Tests

```sh
bun run --cwd apps/honeycrisp test        # contract, state over a stand-in client, the editor over jsdom
bun run --cwd apps/honeycrisp typecheck
bun x playwright test -c apps/honeycrisp/playwright.config.ts                    # both engines
bun x playwright test -c apps/honeycrisp/playwright.config.ts --project=webkit   # one
```

The unit tests run the state and the editor over a stand-in client: a
folder client (`@epicenter/folder/node`) in a temporary directory, the same
contract at the same paths, in place of the repository.

The Playwright suite (`e2e/honeycrisp.spec.ts`) starts the same environment
as `demo`, built into a scratch directory (never `build/`), and walks one
person through five steps per engine: Honeycrisp asks for a sign-in, and
signed in shows an empty repository where notes and folders are created,
edited, moved, pinned and deleted, the body typed into the editor, never in
the browser's files, and survive a reload; `epicenter clone` holds them and
`epicenter check` passes; a body edited on the desktop shows in the open
note with no reload, and text typed in the browser reaches the desktop in
house style; a note the desktop wrote that does not read is repaired; and
signing out asks for a sign-in again. It needs port 5175 free.
