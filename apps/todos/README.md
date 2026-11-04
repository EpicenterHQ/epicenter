# Todos

Todos keeps each todo as a Markdown note at `todos/<id>.md`: its `title` and
`done` in front matter, its notes in the body. That layout is Todos'
contract, `src/lib/contract.ts`, published unchanged as `static/contract.json`
(`bun run contract` rewrites it after a change), the file
`epicenter check <url>/contract.json <dir>` checks a folder against. Any
program that writes the layout is a valid writer.

Todos has two variants, one store each and nothing moving between them
(decisions 77 to 79): the online web app over the signed-in person's
repository, and a desktop app over a folder of todos it keeps on the
computer (below). A folder of todos on a computer, the desktop app's or a
clone of the person's repository (`epicenter clone`), is synced by Epicenter
(`epicenter sync`), never by Todos.

## The web app

Todos in a browser is its online variant only: the person's own repository,
`<handle>/todos`, through Epicenter. Signed out it asks for a sign-in;
signed in, every create, edit, completion and delete is a commit there, and
nothing is kept in the browser. It needs the network; there is no browser
copy to fall back on
([ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)).

- Changes made elsewhere (another tab, or a desktop's `epicenter sync`) show
  without a reload.
- A note at a todo's path that does not read as a todo is listed under
  "Needs repair" with its text. Saving fixed text there replaces the note,
  written in house style; text that still does not fit is refused.

The title, notes and Done of the open todo are one editor of its note
(`todos.edit({ id })`): they save as you type or click, one save at a time,
and a save that fails stays in the editor with Save again, Discard and Copy.
Done in the list saves at once and says when it fails.

The app signs in as `so.epicenter.todos` for the server's Git audience only
(`src/lib/auth.ts`, made on first use, and only by the web build). The
server is `VITE_EPICENTER_SERVER` at build time, else Epicenter's. The
hosted API does not serve web writes yet, so signing in works against a
local or self-hosted API.

### Run it

From the repository root:

```sh
bun dev:todos:ui                       # Vite dev server on http://localhost:5186
bun run --cwd apps/todos build         # static files in apps/todos/build/
bun run --cwd apps/todos demo          # the whole stack, to try it by hand
```

The build is static: any host that answers unknown paths with `index.html`
(for `/auth/callback`) serves it, at an origin the API registers.

`demo` boots a disposable Postgres, the local API with temporary Git and LFS
stores, the built app on `http://localhost:5186`, a demo person, and a
desktop sandbox for the `epicenter` CLI, then prints a sign-in helper URL and
the `epicenter clone`, `check` and `sync` commands for the person's `todos`
repository. It needs `initdb`, `pg_ctl`, `git` and `git-lfs` on `PATH`, and
port 5186 free. Ctrl-C deletes everything.

## The desktop app

```sh
bun dev:todos:desktop     # from the repository root; needs a Rust toolchain
bun build:todos:desktop   # a local, unsigned macOS app bundle
```

Its Tauri shell derives the data folder from the app's site and names it
the Data root, which the page opens by name. The page opens `~/Epicenter/todos` (`~/Epicenter Dev/todos`
in development), making it when missing for now. A failed open shows the
shared recovery screen with Retry. The files remain when the app is removed.

The page is the same UI as the web, built as the desktop variant
(`bun run build:native`, into `build-desktop/`), over the folder
(`openFolder(todos, { site })`, whose `tauri` leaf opens the Data root) with
no sign-in: Todos makes no
inference calls, and Epicenter can keep the folder's local history. Its header
says whether Epicenter manages the folder, offers **Set up in Epicenter** until it does
(`syncWithEpicenter({ contract })`, the contract at `APPS.TODOS.url`'s
`contract.json`), and shows the shell's folder path in the status details. Closing the window or quitting does not wait.

The build picks the folder: `openFolder` from `@epicenter/folder` resolves
to its desktop leaf under the `tauri` condition that `desktopVariant()` in
`vite.config.ts` turns on, and to the web leaf otherwise. Two things are
Todos' own and differ by build, through `#platform/*` seams
([the shared pattern](../../packages/tauri-epicenter-standalone/README.md#making-a-web-apps-desktop-variant));
`tsconfig.tauri.json` typechecks the desktop leaves, and
`src/lib/platform.test.ts` names a seam or capability whose desktop leaf
went missing.

| Seam | Web leaf | Desktop leaf |
| --- | --- | --- |
| `#platform/account` | `account.ts`: `connectAccount()`, the browser sign-in | `account.tauri.ts`: none, `null` |
| `#platform/chrome` | `OnlineChrome.svelte`: the repository's status and the account | `DesktopChrome.svelte`: the folder's local history status and Set up in Epicenter |

## The native CLI

```sh
bun apps/todos/scripts/native.ts /tmp/todos list
bun apps/todos/scripts/native.ts /tmp/todos create "Buy milk"
bun apps/todos/scripts/native.ts /tmp/todos complete <id>
```

It opens the directory as the contract's client (`openDevice` from
`@epicenter/folder/node`), keeps front matter keys and notes Todos does not
name, and never commits or contacts a server.

## How it is wired

```text
src/lib/app.ts                 the page's values: account (#platform/account) and
                               folder = fromClient(openFolder(todos, { site, account })),
                               and one import.meta.hot dispose that closes them
routes/+layout.svelte          every page: the chrome and the leave guard
routes/(app)/+layout.svelte    signed out on the web: SignIn; otherwise
                               <Opening app="Todos" {folder}> (spinner, Recovery, pages)
routes/(app)/+page.svelte      TodosApp
  TodosApp.svelte              header (Chrome from #platform/chrome), the list, the open todo
routes/auth/callback           finishes sign-in, outside (app), then returns to /
```

Every component imports what it reads from `$lib/app.js` (`folder.todos`),
never a client of its own; only `app.ts` opens the store
([ADR-0766](../../docs/adr/0766-an-apps-capabilities-are-module-values-opened-synchronously.md)).
On the web the folder is the account's copy: it opens once the account is
signed in, and a new account is a new page (sign-in returns through
`/auth/callback`, which reloads).

| Path | Role |
| --- | --- |
| `src/lib/app.ts` | The account and the folder, opened once for the page. |
| `src/lib/contract.ts` | The contract. |
| `src/lib/todos.ts` | A todo's file, label and order (open first, then done, each oldest first). |
| `src/lib/account.ts`, `account.tauri.ts` | The web build's sign-in; none on the desktop. |
| `src/lib/components/SignIn.svelte`, `OnlineChrome.svelte` | The web app's signed-out page; the header's status and account. |
| `src/lib/components/DesktopChrome.svelte` | The header's local history status, Set up in Epicenter, and the folder's path (`folder.displayPath`). |
| `src/lib/components/TodosApp.svelte` | The header, the list, and the open todo, over `folder.todos`. |

## Tests

```sh
bun run --cwd apps/todos test        # contract, order, the list over a memory folder, both builds' seams, the native CLI
bun run --cwd apps/todos typecheck   # app (web and desktop leaves), scripts, end to end
bun x playwright test -c apps/todos/playwright.config.ts                    # both engines
bun x playwright test -c apps/todos/playwright.config.ts --project=webkit   # one
bun run --cwd apps/todos build:native && cargo test -p todos -p epicenter-standalone
```

`bun run test` passes `--conditions=test`, so `$lib/app.js` opens a folder
in memory and a signed-out account: a component test seeds the folder
through its ordinary methods (`folder.todos.create`) and mocks no module.

The desktop shell's tests compile against `build-desktop/` (`frontendDist`),
so they need `build:native` first. They check its identity, its name (so its
default folder), and that its capability grants only plugin permissions and
names no folder.

The Playwright suite (`e2e/todos.spec.ts`) starts the same environment as
`demo`, built into a scratch directory (never `build/`), and walks one person
through five steps per engine: Todos asks for a sign-in, and signed in,
todos are created, edited, completed and deleted in the repository, never in
the browser's files, and survive a reload; `epicenter clone` holds them as
written and `epicenter check` passes; a desktop title edit shows with no
reload, and notes edited in the browser reach the desktop; a note the
desktop wrote that does not read as a todo shows with its text and is
repaired; and signing out asks for a sign-in again.
