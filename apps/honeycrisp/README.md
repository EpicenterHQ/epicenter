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

Honeycrisp has two variants, one store each and nothing moving between them
(decisions 77 to 79): the online web app over the signed-in person's
repository, and a desktop app over a folder of notes it keeps on the
computer (below). A folder of notes on a computer, the desktop app's or a
clone of the person's repository (`epicenter clone <handle>/honeycrisp`), is
synced by Epicenter (`epicenter sync`), never by Honeycrisp, and any editor
can change it.

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
audience only (`connectAccount()` in `src/lib/account.ts`, made once in
`src/lib/app.ts`, and only by the web build). The server is
`VITE_EPICENTER_SERVER` at build time, else Epicenter's. The hosted API does
not serve web writes yet, so signing in works against a local or self-hosted
API.

## The desktop app

```sh
bun dev:honeycrisp:desktop     # from the repository root; needs a Rust toolchain
bun build:honeycrisp:desktop   # a local, unsigned macOS app bundle
```

Its Tauri shell derives the data folder from the app's site and names it
the Data root, which the page opens by name. The page opens `~/Epicenter/honeycrisp` (`~/Epicenter Dev/honeycrisp`
in development), making it when missing for now. A failed open shows the
shared recovery screen with Retry. The files remain when the app is removed.

The page is the same UI as the web, built as the desktop variant
(`bun run build:native`, into `build-desktop/`), over the folder
(`openFolder(honeycrisp, home({ site, account }))`, whose desktop `home` is the
Data root)
with no sign-in: Honeycrisp
makes no inference calls, and Epicenter can keep the folder's local history.
Its header says "On this computer" or "Kept by Epicenter" once the folder is
enrolled (asked again each time the window gains focus), offers **Set up in
Epicenter** until then (`syncWithEpicenter({ contract })`, the
contract at `APPS.HONEYCRISP.url`'s `contract.json`), and shows the shell's folder path in the status details. Closing the window or quitting does not wait.

The build picks the folder: `home` from `@epicenter/folder` resolves
to its desktop leaf under the `tauri` condition that `desktopVariant()` in
`vite.config.ts` turns on, and to the web leaf otherwise. Two things are
Honeycrisp's own and differ by build, through `#platform/*` seams
([the shared pattern](../../packages/tauri-epicenter-standalone/README.md#making-a-web-apps-desktop-variant));
`tsconfig.tauri.json` typechecks the desktop leaves, and
`src/lib/platform.test.ts` names a seam or capability whose desktop leaf
went missing and checks that the desktop build carries no sign-in.

| Seam | Web leaf | Desktop leaf |
| --- | --- | --- |
| `#platform/account` | `account.ts`: `connectAccount()`, the browser sign-in | `account.tauri.ts`: none, `null` |
| `#platform/chrome` | `OnlineChrome.svelte`: the repository's status and the account | `DesktopChrome.svelte`: the folder's local history status and Set up in Epicenter |

The sign-in callback page is the same in both builds: with an account it
finishes sign-in, and without one (the desktop) it says Honeycrisp does not
sign in there.

## Editing

The title saves as you type. The body is edited in CodeMirror as the
Markdown text itself, and also saves as you type: every edit changes exactly
the characters typed, so merges and other programs' diffs stay exact. Live
preview renders headings, bold, italic, strikethrough, inline code and links
in place, and a task's `[ ]` as a checkbox that toggles the one character
inside it; the line holding the cursor shows its syntax. Images and tables
show as plain Markdown.

The open note's title, body, folder and pin are one editor of its note
(`folder.notes.edit({ id })`): saves go one at a
time, the newest carrying every field changed since the last that landed,
each made over what the person saw when they began typing. Another writer's
change to other keys is carried over; their change to a key changed here
(the title, the body, the folder or the pin) is a conflict: the editor keeps what was typed and shows
**Not saved** with Save again (which saves over theirs), Discard and Copy. A
change from elsewhere to the body while nothing is waiting is applied to the
open editor as the smallest edits, outside Undo, so the cursor stays.

When two computers' edits of a body overlap, the merge that `epicenter sync`
runs writes a conflict block into the note; the server never merges. The editor shows each block as a card with
Keep this, Keep that and Keep both; choosing is one edit, and Undo brings the
block back.

In the list, a note's folder and pin are commands: each saves at once and
says so if it could not.

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
src/lib/app.ts                 the page's values, each read through reactive:
                               account (#platform/account) and
                               folder = reactive(openFolder(honeycrisp, home({ site, account })));
                               editing it, or what it imports, reloads the page
routes/+layout.svelte          every page: the chrome
routes/(app)/+layout.svelte    signed out on the web: SignIn; otherwise
                               <WhenOpen app="Honeycrisp" {folder}> (spinner, Recovery,
                               pages, and the leave guard while folder.saving())
routes/(app)/+page.svelte      HoneycrispApp
  HoneycrispApp.svelte         createHoneycrisp over folder.notes and folder.folders (in context);
                               header (Chrome from #platform/chrome), folders, notes, the open note
routes/auth/callback           finishes sign-in, outside (app), then returns to /
```

Every component imports what it reads from `$lib/app.js` (`folder.notes`,
`folder.folders`), never a client of its own; only `app.ts` opens the
store
([ADR-0766](../../docs/adr/0766-an-apps-capabilities-are-module-values-opened-synchronously.md)).
The page state over them (`createHoneycrisp`: the filter, what is open, and
the actions over both collections) is in context (`getHoneycrisp`). On the
web the folder is the account's copy: it opens once the account is signed
in, and a new account is a new page (sign-in returns through
`/auth/callback`, which reloads).

| Path | Role |
| --- | --- |
| `src/lib/app.ts` | The account and the folder, opened once for the page. |
| `src/lib/contract.ts` | The contract. |
| `src/lib/account.ts`, `account.tauri.ts` | The web build's sign-in; none on the desktop. |
| `src/routes/+layout.svelte` | Every page, the sign-in callback included: the chrome. |
| `src/routes/(app)/+layout.svelte` | `SignIn` while the web build is signed out; otherwise `<WhenOpen>` over the folder. |
| `src/lib/components/SignIn.svelte`, `OnlineChrome.svelte` | The web app's signed-out page; the header's status and account. |
| `src/lib/components/DesktopChrome.svelte` | The header's local history status, Set up in Epicenter, and the folder's path (`folder.displayPath`). |
| `src/routes/(app)/+page.svelte` | `HoneycrispApp`, over the folder's notes and folders. |
| `src/lib/honeycrisp.svelte.ts` | The orders (notes newest first, folders by name), what the list and detail show, and the actions over both collections. |
| `src/lib/editor/` | The CodeMirror note editor: the binding that writes local edits and follows changes from elsewhere, live preview, conflict cards. It knows nothing of the app's UI or storage. |
| `src/lib/components/` | Honeycrisp's UI, which reads and writes through `folder` and the page state in context. |
| `src-tauri/` | The desktop shell: `main.rs` names Honeycrisp to `epicenter-standalone`; `capabilities/honeycrisp.json` grants the folder plugin and names no folder. |

## Tests

```sh
bun run --cwd apps/honeycrisp test        # contract, state over a stand-in folder, the editor over jsdom, both builds' seams
bun run --cwd apps/honeycrisp typecheck   # the web and the desktop leaves
cargo test -p honeycrisp -p epicenter-standalone   # the desktop shell: capability, identity, the data folder, Quit
bun x playwright test -c apps/honeycrisp/playwright.config.ts                    # both engines
bun x playwright test -c apps/honeycrisp/playwright.config.ts --project=webkit   # one
```

The unit tests run the state and the editor over a stand-in folder: the
contract's folder at a temporary directory (`directory` from
`@epicenter/folder/node`), the same files at the same paths, in place of
the repository. `bun run test`
passes `--conditions=test`, so anything that imports `$lib/app.js` gets a
folder in memory and a signed-out account.

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
