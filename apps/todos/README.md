# Todos

Todos keeps each todo as a Markdown file, `todos/<id>.md`, in a repository ([`@epicenter/repository`](../../packages/repository)). It is an app at `todos.epicenter.so` ([ADR-0694](../../docs/adr/0694-installing-an-app-is-trusting-it.md), contract in [`@epicenter/app`](../../packages/app)). This package exports its manifest (`@epicenter/todos`: `manifest`, whose collections are `todosApp`, claiming `todos/{stem}.md`, and `todosTables`) and its bundle (`@epicenter/todos/bundle`: `mount`). It has no SvelteKit dependency and no repository chooser. The web shell ([`apps/web`](../web)) mounts it at `/<owner>/<repo>/todos.epicenter.so`, over any repository; your home's todos are at `/me/home/todos.epicenter.so`.

A todo's title and `done` flag live in frontmatter; its notes live in the Markdown body. The checkbox and the title each set their one field, so fields the schema does not name, and a change made elsewhere to the rest of the todo, stay. The notes are a view of the todo's editor; **Edit source** opens the same editor on the todo's whole file, frontmatter included (`<SourceEditor>` from `@epicenter/svelte`), whose status says whether the frontmatter parses and whether the todo matches the schema, with each issue. A file that does not read as a todo is listed under **Needs repair** and opens straight into its source. Text whose frontmatter does not parse is saved on this device and held, not sent, until it parses again; the editor's status says so, and the shell's repository bar counts it as **Not sent**.

The todos are held in page memory, so the list and the open todo read them at once, and every edit shows at once. An edit resolves once it is saved on this device; if it cannot be saved, Todos says so in a toast and the controls show the stored todo again. Edits made offline are sent when the server is reachable, and edits from elsewhere merge with them: where two people changed the same words, the todo keeps both, as a labelled conflict block in its text.

## As an app

`src/bundle.ts` is `mountSvelte(TodosApp)` (`@epicenter/svelte/app`), so the root gets the contract's `{ repo, path, navigate }`, its reads tracked:

- `repo` may hold other apps' collections; Todos reads `repo.todos` only.
- The path is which todo is open: `/<id>`, or `/` for the list. Opening a todo is a history entry, so Back returns to the list; a delete replaces the entry. It survives a reload and the breakpoint.
- The repository's name and where it syncs are the shell's bar above the app, not Todos' header. The header says when a new todo's title is typed but not added.

Todos has no settings yet; when it has, they follow ADR-0693 ("Settings are data").

## Run it

From the repository root, `bun dev:web` and open `/me/home/todos.epicenter.so`. To sync, see [the shell's README](../web/README.md#join-a-synced-repository). The browser tests for Todos (alone, and two people syncing by a join link) are the shell's: `bun run --cwd apps/web test:browser`.

## The desktop shell (not built from here now)

`src-tauri/` is the standalone Todos desktop shell. It loaded this package's former site build (`build:host` into `dist/`), and Epicenter's desktop bundled the same build (`apps/epicenter/scripts/build-bundled-apps.ts`). That site is gone, so neither builds Todos's page now; desktop repositories are phase 9 (a repository is a folder on disk kept as a Git clone). Since phase 7 the page had already stopped reading the bound directory. The shell's Rust (`cargo test --manifest-path apps/todos/src-tauri/Cargo.toml`), its fixed default `<library>/so.epicenter.todos`, and **Open in Epicenter** (`open-in-epicenter.ts`, [ADR-0646](../../docs/adr/0646-a-native-app-hands-epicenter-a-directory-path-and-the-person-accepts-it.md)) are unchanged.

## Native directory example

```sh
mkdir -p /tmp/todos-example
bun apps/todos/scripts/native.ts /tmp/todos-example create "Buy milk"
bun apps/todos/scripts/native.ts /tmp/todos-example list
bun apps/todos/scripts/native.ts /tmp/todos-example complete <id>
```

The CLI opens `openFolder({ directory, tables: todosTables })`. It saves ordinary files and never makes a commit or contacts a remote. It leaves other files and unknown row fields intact.

## Checks

From the repository root:

```sh
bun run --cwd apps/todos typecheck
bun run --cwd apps/todos test
```

`src/` reads the repository through Svelte context (`repository.ts`), writes with `create`, `patch` and `delete`, edits a todo's notes and source through its editor (`openEditor`), and reports writes it could not save. The mounted tests (`TodosApp.mounted.test.ts`) mount the root over a repository in this process. `apps/todos/scripts/native.ts` still uses `@epicenter/folder` over a directory, with the same schema; it does not read the repository.

## Export the table schema

The app's TypeBox module owns both runtime validation and developer types.
To distribute a portable copy without opening a data folder:

```sh
bun run --cwd apps/todos schema:export > todos-schema.json
epicenter schema import FOLDER todos-schema.json
```

Replace `FOLDER` with an existing data directory. Importing writes only the
exported table definitions in `epicenter.json`; opening or updating Todos
publishes no schema. A conflicting definition requires `--replace`.
