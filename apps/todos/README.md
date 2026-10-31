# Todos

Todos keeps each todo as a Markdown note at `todos/<id>.md`: its `title` and
`done` in front matter, its notes in the body. That layout is Todos'
contract, `src/lib/contract.ts`, published unchanged as `static/contract.json`
(`bun run contract` rewrites it after a change), the file
`epicenter check <url>/contract.json <dir>` checks a folder against. Any
program that writes the layout is a valid writer.

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

The title and notes save as you type; a save that fails stays in its editor
with Save again, Discard and Copy.

The app signs in as `so.epicenter.todos` for the server's Git audience only
(`src/lib/auth.ts`, made on first use, and never in the desktop window). The
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
(for `/auth/callback`) serves it, at an origin the API registers. The
desktop window loads the same build from `build/`.

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

The Tauri shell in `src-tauri/` binds one folder to its one window before the
page loads: `~/Epicenter/so.epicenter.todos` (`~/Epicenter Dev/...` for the
development identifier `so.epicenter.todos.dev`, or under
`EPICENTER_FOLDER_DIR`), created when missing. The page is the same build as
the web app; in the window it opens that folder as the contract's client
(`openDevice` from `@epicenter/folder/tauri`, in `src/lib/device.ts`)
and never names a path. This is the desktop variant: it signs in to nothing,
and only Epicenter syncs the folder once it is added (`epicenter sync`). The window also offers
**Open in Epicenter**, which asks the operating system to open
`epicenter://init?path=<the bound folder>&contract=https://todos.epicenter.so/contract.json`:
a request that Epicenter sync the folder, which it shows for the person to set
up or dismiss ([Requests to sync a folder](../epicenter/README.md#requests-to-sync-a-folder),
[ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)).
Closing the window does not wait for a save in flight.

## The native CLI

```sh
bun apps/todos/scripts/native.ts /tmp/todos list
bun apps/todos/scripts/native.ts /tmp/todos create "Buy milk"
bun apps/todos/scripts/native.ts /tmp/todos complete <id>
```

It opens the directory as the contract's client (`openDevice` from
`@epicenter/folder/node`), keeps front matter keys and notes Todos does not
name, and never commits or contacts a server.

## Layout

- `src/lib/contract.ts`: the contract.
- `src/lib/device.ts`: the desktop variant's store, a module singleton: the
  desktop window's folder. Only `src/lib/components/Desktop.svelte`, loaded
  only in the window, imports it.
- `src/lib/todos.ts`: a todo's file, label and order (open first, then
  done, each oldest first), and the list's context.
- `src/routes/(app)/+layout.svelte`: the root that decides the store. In a
  browser it is the signed-in layout: per account,
  `src/lib/components/Online.svelte` opens the repository and sets it
  (`setRepo`); signed out, it asks for a sign-in. In the window it adds
  nothing.
- `src/routes/(app)/+page.svelte`: `fromClient(getRepo<Todos>()).todos` in
  a browser, `Desktop` in the window.
- `src/lib/components/TodosApp.svelte`: Todos over the todos it is given;
  the components under it read and write only through them, so another
  variant needs only a new root.

## Tests

```sh
bun run --cwd apps/todos test        # contract, the native CLI
bun run --cwd apps/todos typecheck
bun x playwright test -c apps/todos/playwright.config.ts                    # both engines
bun x playwright test -c apps/todos/playwright.config.ts --project=webkit   # one
bun run --cwd apps/todos build && cargo test --manifest-path apps/todos/src-tauri/Cargo.toml
```

The desktop shell's tests compile against `build/` (`frontendDist`), so they
need a build first.

The Playwright suite (`e2e/todos.spec.ts`) starts the same environment as
`demo`, built into a scratch directory (never `build/`), and walks one person
through five steps per engine: Todos asks for a sign-in, and signed in,
todos are created, edited, completed and deleted in the repository, never in
the browser's files, and survive a reload; `epicenter clone` holds them as
written and `epicenter check` passes; a desktop title edit shows with no
reload, and notes edited in the browser reach the desktop; a note the
desktop wrote that does not read as a todo shows with its text and is
repaired; and signing out asks for a sign-in again.
