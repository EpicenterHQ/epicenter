# Todos

Todos keeps each todo as a Markdown note at `todos/<id>.md`: its `title` and
`done` in front matter, its notes in the body. That layout is Todos'
contract, `src/lib/contract.ts`, published unchanged as `static/contract.json`
(`bun run contract` rewrites it after a change), the file
`epicenter check <url>/contract.json <dir>` checks a folder against. Any
program that writes the layout is a valid writer.

## The web app

Todos opens without an account. Signed out, todos live in this browser's
private files (OPFS), at the same paths a folder holds. Signing in with
Epicenter opens the person's own repository, `<handle>/todos`, beside them as
one list:

- A todo made signed out or offline stays in the browser and uploads on its
  own once someone is signed in and online; the browser then lets go of its
  copy. Until then, signed in, it is marked "not uploaded yet".
- A todo added while signed in and online goes straight to the repository.
- Edits, completes and deletes go to the copy shown: the browser's while it
  holds one, else the repository's, which is online only. One made as a todo
  uploads follows it to the repository, and a todo deleted while it uploads
  is deleted there too. An open todo stays open while it uploads.
- Signed in with the server unreachable, the header says "Offline: new todos
  wait to upload", and new todos do.
- Changes made elsewhere (another tab, or a desktop's `epicenter sync`) show
  without a reload.
- A note at a todo's path that does not read as a todo is listed under
  "Needs repair" with its text. Saving fixed text there replaces the note,
  written in house style; text that still does not fit is refused.

Signing out leaves the browser with only the todos it never uploaded. The
title and notes save as you type; a save that fails stays in its editor with
Save again, Discard and Copy.

The app signs in as `so.epicenter.todos` for the server's Git audience only
(`src/lib/auth.ts`, made on first use, and never in the desktop window). The
server is `VITE_EPICENTER_SERVER` at build time, else
Epicenter's. The hosted API does not serve web writes yet, so signing in
works against a local or self-hosted API.

### Run it

From the repository root:

```sh
bun dev:todos:ui                       # Vite dev server on http://localhost:5186
bun run --cwd apps/todos build         # static files in apps/todos/build/
bun run --cwd apps/todos demo          # the whole stack, to try it by hand
```

The build is static: any host that answers unknown paths with `index.html`
(for `/auth/callback`) serves it, at an origin the API registers. It also
writes a service worker so a loaded app reopens offline; the page registers
it in a browser only, never in the desktop window, which loads the same
build from `build/`.

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
(`openDevice` from `@epicenter/folder/tauri`, chosen in `src/lib/device.ts`)
and never names a path. It signs in to nothing and uploads nothing: Epicenter
syncs a folder added to it (`epicenter sync`). Standalone Todos also offers
**Open in Epicenter**, which asks the operating system to open the bound
folder in Epicenter ([ADR-0646](../../docs/adr/0646-a-native-app-hands-epicenter-a-directory-path-and-the-person-accepts-it.md)).
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
- `src/lib/todos.ts`: the one list (`createTodoList`): `oneList` from
  `@epicenter/svelte/client` over the device and, signed in, the repository,
  with Todos' order (open first, then done, each oldest first).
- `src/routes/+page.svelte`: opens the device at the root;
  `src/lib/components/SignedIn.svelte` adds the repository and the uploader
  per account.
- `src/lib/components/`: the views, which read and write only through the
  list in context.

## Tests

```sh
bun run --cwd apps/todos test        # contract, the one list, the native CLI
bun run --cwd apps/todos typecheck
bun x playwright test -c apps/todos/playwright.config.ts                    # both engines
bun x playwright test -c apps/todos/playwright.config.ts --project=webkit   # one
```

The Playwright suite (`e2e/todos.spec.ts`) starts the same environment as
`demo`, built into a scratch directory (never `build/`), and walks one person
through seven steps per engine: create, edit, complete and delete todos
signed out; sign in, and they upload and leave the browser, while a new one
goes straight to the repository; with the server unreachable a new todo
waits on the device under a warning, and once it is back the todo uploads
while its open editor keeps its caret; `epicenter clone`
holds them as written and `epicenter check` passes; a desktop title edit
shows on the web with no reload, and notes edited on the web reach the
desktop; a note the desktop wrote that does not read as a todo shows on the
web with its text and is repaired there; and signing out leaves the browser
empty.
