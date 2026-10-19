# Todos

Todos keeps Markdown files in one local [Folder](../../packages/folder/README.md). It opens without an account, a remote, or Git. The browser build uses this origin's IndexedDB folder. The installed build uses the directory Epicenter's shell grants its window. The native CLI opens an existing directory supplied on its command line. The same table schema interprets `todos/<id>.md` on both hosts.

The current UI can add, edit, complete, and delete todos. A todo's title and `done` flag live in frontmatter; its notes live in the Markdown body. Fields the schema does not name remain in the source when a row is edited. A file that does not read as a todo remains visible with its source for repair.
Deleting a todo removes its Markdown row; adjacent files stay in the Folder.

## Run the browser app

From the repository root:

```sh
bun dev:todos:ui
```

Open the URL Vite prints. Use a fresh browser profile or origin for a fresh workspace. The header says **Saved on this device** after IndexedDB confirms each save and no draft or failure remains. Open a second tab at the same URL to see saved changes propagate. Once the page has loaded, editing needs no network connection. A cold offline launch requires an offline app shell and is separate work.

For an isolated automated walkthrough, from the repository root run:

```sh
bun run --cwd apps/todos demo:local
```

The demo uses a fresh browser profile. It exercises editing, reopening, two tabs, offline edits after load, source preservation, and a controlled failed save that retains the draft. It also checks the browser's IndexedDB storage, so an unchanged looking screen cannot conceal the former OPFS engine.

## Native directory example

```sh
mkdir -p /tmp/todos-example
bun apps/todos/scripts/native.ts /tmp/todos-example create "Buy milk"
bun apps/todos/scripts/native.ts /tmp/todos-example list
bun apps/todos/scripts/native.ts /tmp/todos-example complete <id>
```

The CLI opens `openFolder({ directory, tables: todosTables })`. It saves ordinary files and never makes a commit or contacts a remote. It leaves other files and unknown row fields intact.

## Earlier browser data

Earlier Todos builds kept named folders in OPFS. This build does not read or migrate them. The browser opener checks for an earlier folder before opening the IndexedDB default. When it finds one, Todos shows a refusal instead of an empty list; the OPFS bytes stay untouched. A verified importer is required before those earlier todos can be edited through this opener. Use a fresh profile or origin to try the new path without changing an existing profile.

## Boundaries and checks

`src/routes/+page.svelte` mounts one `FolderApp` with `todosTables`. The root owns the Folder handle, query cache, drafts, status, and close. `src/routes/local/` contains the UI; it reads the handle through the Svelte context. `scripts/native.ts` uses the same public Folder operations over a directory. Todos has no account, inference, or sync action.

From the repository root:

```sh
bun run --cwd apps/todos test
bun run --cwd apps/todos typecheck
bun run --cwd apps/todos build
bun run --cwd apps/todos build:installed
```
