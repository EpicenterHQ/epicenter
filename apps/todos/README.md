# Todos

Todos keeps each todo as a Markdown file, `todos/<id>.md`, in a repository ([`@epicenter/repository`](../../packages/repository)). It is a lens: this package exports its definition (`@epicenter/todos`: `todosApp`, which claims `todos/{stem}.md`, and `todosTables`) and its Svelte root (`@epicenter/todos/app`: `TodosApp`). It has no routes and no repository chooser. The web shell ([`apps/web`](../web)) opens a repository from the URL and mounts `TodosApp` at `/<owner>/<repo>/todos`, so Todos opens any repository, alongside every other first-party app; your home's todos are at `/me/home/todos`.

A todo's title and `done` flag live in frontmatter; its notes live in the Markdown body. The checkbox and the title each set their one field, so fields the schema does not name, and a change made elsewhere to the rest of the todo, stay. The notes are a view of the todo's editor; **Edit source** opens the same editor on the todo's whole file, frontmatter included (`<SourceEditor>` from `@epicenter/svelte`), whose status says whether the frontmatter parses and whether the todo matches the schema, with each issue. A file that does not read as a todo is listed under **Needs repair** and opens straight into its source. Text whose frontmatter does not parse is saved on this device and held, not sent, until it parses again; the status says so, and the header counts it as **Not sent**.

The todos are held in page memory, so the list and the open todo read them at once, and every edit shows at once. An edit resolves once it is saved on this device; if it cannot be saved, Todos says so in a toast and the controls show the stored todo again. Edits made offline are sent when the server is reachable, and edits from elsewhere merge with them: where two people changed the same words, the todo keeps both, as a labelled conflict block in its text.

## The root's contract

```svelte
<TodosApp {repo} repository="Home" syncsTo="http://127.0.0.1:8787/" repositoryHref="/me/home" />
```

- `repo`: the open repository, its reads tracked (`reactive`), under the shell's `RepositoryGate`. It may hold other apps' collections; Todos reads `repo.todos` only.
- `repository`: the repository's name in this browser; `syncsTo`: its server, if any.
- `repositoryHref`: the repository's page, where the header's repository name goes (its apps, and this browser's other repositories).

Which todo is open is the URL's `?todo=<id>` (through SvelteKit's `$app/state` and `$app/navigation`, which the shell provides), so it survives a reload and the breakpoint. Todos has no settings yet; when it has, they follow the shell's rule of settings by audience ([`apps/web`](../web/README.md#settings-by-audience)).

## Run it

From the repository root, `bun dev:web` and open `/me/home/todos`. To sync, see [the shell's README](../web/README.md#join-a-synced-repository). The browser tests for Todos (alone, and two people syncing by a join link) are the shell's: `bun run --cwd apps/web test:browser`.

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

`src/` reads the repository through Svelte context, writes with `create`, `patch` and `delete`, edits a todo's notes and source through its editor (`openEditor`), and reports writes it could not save. The mounted tests (`TodosApp.mounted.test.ts`) mount the root over a repository in this process. `apps/todos/scripts/native.ts` still uses `@epicenter/folder` over a directory, with the same schema; it does not read the repository.

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
