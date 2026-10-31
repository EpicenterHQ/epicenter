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

Honeycrisp opens without an account. Signed out, notes and folders live in
this browser's private files (OPFS), at the same paths a folder holds.
Signing in with Epicenter opens the person's own repository,
`<handle>/honeycrisp`, beside them, one list per collection
(`oneList` from `@epicenter/svelte/client`):

- A note or folder made signed out or offline stays in the browser and
  uploads on its own once someone is signed in and online; the browser then
  lets go of its copy. Until then, signed in, a note is marked "not uploaded
  yet".
- One made while signed in and online goes straight to the repository.
- Edits, moves, pins and deletes go to the copy shown: the browser's while it
  holds one, else the repository's, which is online only. An open note stays
  open while it uploads.
- Signed in with the server unreachable, the header says "Offline: new notes
  wait to upload", and new notes do.
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

Honeycrisp has no desktop app. Its notes on a computer are a clone of the
repository (`epicenter clone <handle>/honeycrisp`), which Epicenter syncs and
any editor can change.

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
| `src/lib/honeycrisp.svelte.ts` | The orders (notes newest first, folders by name), what the list and detail show, and the actions over both collections. |
| `src/lib/editor/` | The CodeMirror note editor: the binding that writes local edits and follows changes from elsewhere, live preview, conflict cards. It knows nothing of the app's UI or storage. |
| `src/routes/+page.svelte` | Signed out, or the signed-in boundary (`src/lib/components/SignedIn.svelte`: the repository, `setRepo`, and the uploader, per account). `HoneycrispApp.svelte` composes the two lists. |
| `src/lib/components/` | The views, which read and write only through the state in context. |

## Tests

```sh
bun run --cwd apps/honeycrisp test        # contract, state over real devices, the editor over jsdom
bun run --cwd apps/honeycrisp typecheck
bun x playwright test -c apps/honeycrisp/playwright.config.ts                    # both engines
bun x playwright test -c apps/honeycrisp/playwright.config.ts --project=webkit   # one
```

The Playwright suite (`e2e/honeycrisp.spec.ts`) starts the same environment
as `demo`, built into a scratch directory (never `build/`), and walks one
person through six steps per engine: create, edit, move, pin and delete
notes and a folder signed out, typing the body into the editor; sign in, and
they upload and leave the browser, while a new note goes straight to the
repository; `epicenter clone` holds them as the browser wrote them and
`epicenter check` passes; a body edited on the desktop shows in the note open
on the web with no reload, and text typed on the web reaches the desktop; a
note the desktop wrote that does not read shows on the web with its text and
is repaired there; and signing out leaves the browser empty.
