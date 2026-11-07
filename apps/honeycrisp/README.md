# Honeycrisp

Honeycrisp is a Markdown notes app. Each note is a Markdown note at
`notes/<id>.md`: its `title`, `folderId`, `pinned` and `createdAt` in front
matter, its text in the body. Each folder is a note of its own at
`folders/<id>.md` with a `name` (and an optional emoji `icon`). That layout
is Honeycrisp's contract, `src/lib/contract.ts`, published unchanged as
`static/contract.json` (`bun run contract` rewrites it after a change), the
file `epicenter check <dir> --contract <url>/contract.json` checks a folder against. Any
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
folder's history on the server keeps what a delete removed.

Honeycrisp has no settings, so it has no settings note, and keeps no other
files.

Honeycrisp has two variants, one store each and nothing moving between them
(decisions 77 to 79): the online web app over the folder attached to
Honeycrisp on the server, and a desktop app over a folder of notes it keeps on
the computer (below). A folder of notes on a computer, the desktop app's or a
clone of that folder (`epicenter clone`), is synced by `epicenter sync`,
never by Honeycrisp, and any editor can change it.

## The web app

Honeycrisp in a browser is its online variant only: the folder attached to
Honeycrisp on the server (its history is the folder's ledger at `/folders/<id>`),
at `/`. Signed out it
asks for a sign-in; signed in, every create, edit, move, pin and delete is a
change there, and nothing is kept in the browser. It needs the network;
there is no browser copy to fall back on
([ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)).

The header says where the notes are and whether the repository answers:
Online, Offline when it does not, or Sign in again when the session needs
renewing; Sign out is beside it.

- Changes made elsewhere (another tab, or a desktop's `epicenter sync`) show
  without a reload, in the open note too.
- A file at a note's or folder's path that does not read as one is listed
  under "Needs repair" with why. It opens as its text, which says what is
  wrong as it is typed; saving writes the text as typed, so fixed text
  repairs the file, and text that still does not fit stays under "Needs
  repair" with its new problems.

Honeycrisp signs in as `so.epicenter.honeycrisp` (`connectAccount()`, made
once in `src/lib/app.ts`) for the repository alone, the one need `home`
declares when it is handed the account
([ADR-0792](../../docs/adr/0792-an-account-asks-for-what-the-capabilities-that-take-it-need.md)).
The server is
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

The page is the web's own build (`build/`, the dev server in
development), over the folder (`openFolder(honeycrisp, home({ site, account }))`,
whose `home` in a Tauri window is the Data root). It asks for no sign-in: a
desktop app never syncs, and Epicenter, once installed, syncs the folder
(ADR-0822). Its header says "On this computer" or "Synced by Epicenter"
(from the record Epicenter keeps of it, asked again each time the window
gains focus), says where to get Epicenter until then, and shows the shell's
folder path in the status details. Closing the window or quitting does not wait.

One build serves both
([ADR-0781](../../docs/adr/0781-apps-branch-on-what-a-capability-offers-and-one-build-serves-every-surface.md)):
`home` and `connectAccount` decide where the page runs, and the header
branches on `folder.reveal`, showing `FolderChrome` (whether Epicenter
syncs the folder) where the folder can be revealed and
`RepositoryChrome` (the repository's status and the account) otherwise.

The sign-in callback page finishes a browser's sign-in; a Tauri window's
sign-in ends in its shell, so there the page says Honeycrisp does not sign
in here.

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
time, the newest carrying every field changed since the last that landed. A
save never fails: while the store cannot be reached it waits, the editor
keeps showing what was typed, and the status line under the header says
changes will save when the store is back (ADR-0775). Another writer's change
to other keys is kept; on a key changed here (the title, the folder or the
pin) the later write wins; and a body changed both here and elsewhere is
merged by lines the way `epicenter sync` merges it, an overlap kept as a
conflict block (ADR-0774). A change from elsewhere to the body while nothing
is waiting is applied to the open editor as the smallest edits, outside
Undo, so the cursor stays.

When two edits of a body overlap, whether two computers' or this page's and
another writer's, the merge writes a conflict block into the note; the
server never merges. The editor shows each block as a card with
Keep this, Keep that and Keep both; choosing is one edit, and Undo brings the
block back.

In the list, a note's folder and pin are commands, and Delete asks first:
each is one write the folder keeps until it lands.

## Run it

From the repository root:

```sh
bun dev:honeycrisp                         # Vite dev server on http://localhost:5175
bun run --cwd apps/honeycrisp build        # static files in apps/honeycrisp/build/
bun run --cwd apps/honeycrisp demo         # the whole stack, to try it by hand
```

The build is static: any host that answers unknown paths with `index.html`
(for `/auth/callback`) serves it, at an origin the API registers.

`demo` boots a disposable Postgres, the local API with a temporary blob
store, the built app on `http://localhost:5175`, a demo person, and a
desktop sandbox for the `epicenter` CLI, then prints a sign-in helper URL and
the `epicenter clone`, `check` and `sync` commands for the person's
`honeycrisp` repository. It needs `initdb`, `pg_ctl`, `git` and `git-lfs` on
`PATH`, and port 5175 free. Ctrl-C deletes everything.

## How it is wired

```text
src/lib/app.ts                 the page's values, each read through reactive:
                               account = reactive(connectAccount(...)) and
                               folder = reactive(openFolder(honeycrisp, home({ site, account })));
                               editing it, or what it imports, reloads the page
routes/+layout.svelte          every page: the chrome
routes/(app)/+layout.svelte    over the repository and signed out: SignIn; otherwise
                               <WhenOpen app="Honeycrisp" {folder}> (spinner, Recovery,
                               pages, and the leave guard while folder.saving())
routes/(app)/+page.svelte      HoneycrispApp
  HoneycrispApp.svelte         createHoneycrisp over folder.notes and folder.folders (in context);
                               header (AppHeader), folders, notes, the open note
    AppHeader.svelte           FolderChrome where folder.reveal is there, else RepositoryChrome
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
| `src/routes/+layout.svelte` | Every page, the sign-in callback included: the chrome. |
| `src/routes/(app)/+layout.svelte` | `SignIn` while the repository's account is signed out; otherwise `<WhenOpen>` over the folder. |
| `src/lib/components/SignIn.svelte`, `RepositoryChrome.svelte` | The web app's signed-out page; the header's status and account. |
| `src/lib/components/FolderChrome.svelte` | The header's account of the folder: whether Epicenter syncs it, and its path (`folder.displayPath`). |
| `src/routes/(app)/+page.svelte` | `HoneycrispApp`, over the folder's notes and folders. |
| `src/lib/honeycrisp.svelte.ts` | The orders (notes newest first, folders by name), what the list and detail show, and the actions over both collections. |
| `src/lib/editor/` | The CodeMirror note editor: the binding that writes local edits and follows changes from elsewhere, live preview, conflict cards. It knows nothing of the app's UI or storage. |
| `src/lib/components/` | Honeycrisp's UI, which reads and writes through `folder` and the page state in context. |
| `src-tauri/` | The desktop shell: `main.rs` names Honeycrisp to `epicenter-standalone`; `capabilities/honeycrisp.json` grants the folder plugin and names no folder. |

## Tests

```sh
bun run --cwd apps/honeycrisp test        # contract, state over a stand-in folder, the editor over jsdom
bun run --cwd apps/honeycrisp typecheck   # the app, scripts, end to end
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
