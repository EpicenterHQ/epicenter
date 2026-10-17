# Apps

An application keeps its data in a data folder: Markdown rows,
`epicenter.json`, and Git history beside them (`@epicenter/folder`). The files
are the data. A recording is a file in the folder from its start
(`@epicenter/recorder`), and its audio stays on the machine that recorded it,
ignored by Git; inference and secrets have their own constructors and
lifetimes beside the folder.

Epicenter's desktop applications run as SPAs in Tauri WebViews. Rust serves
every page from one origin, `epicenter-app://localhost`, and owns native
mechanisms; the `epicenter` CLI holds the account. A desktop page opens its folder itself, over a
directory the shell grants it. Browser builds open the same folder in the
origin's private file system.

This directory also contains the server deployable (`api`, which runs on
Cloudflare Workers or, self-hosted, on Bun with Postgres), the public `landing` site, and the `local-books` accounting CLI.

## Declare the folder, then open it

`defineFolder` declares tables. An app that keeps settings keeps them as rows
of a `settings` table whose fields are all optional; no app here declares one
yet. The declaration is inert: importing it opens
nothing. A folder ID names the dataset, conventionally the app's
reverse-domain ID.

```ts
import { defineFolder, defineTable, field } from '@epicenter/folder';

export const todosDefinition = defineFolder({
  tables: { todos: defineTable({ fields: { title: field.string(), done: field.boolean() } }) },
});
```

The mounted root page opens it with `<FolderApp>` from `@epicenter/svelte`,
given the app's manifest (`epicenter.app.json`, `{ id, title }`) and its
definition:

```svelte
<script lang="ts">
	import FolderApp from '@epicenter/svelte/folder-app';
	import manifest from '../../epicenter.app.json';
	import { todosDefinition } from '$lib/definition.js';
	import TodosView from './components/TodosView.svelte';
</script>

<FolderApp app={manifest} definition={todosDefinition}><TodosView /></FolderApp>
```

`<FolderApp>` calls `openFolder({ app: manifest.id, definition })` from
`@epicenter/folder`, which picks the desktop shell or the browser's storage
when it is called
([ADR-0533](../docs/adr/0533-one-folder-handle-opens-in-three-hosts-chosen-by-where-the-code-runs.md));
`installedAppViteConfig` resolves that specifier to the build's one entry.
An app keeps no per-host folder leaves. `app` is the app's id, its manifest
`id`. A folder's `epicenter.json` is
published only by the app the folder is named after
([ADR-0583](../docs/adr/0583-a-folders-declaration-is-published-only-by-the-app-it-is-named-after.md)).
In a browser the app opens its own folder. In the desktop app it opens the
folder the shell handed its window, which the shell answers the page, never
its URL; any folder but its own is read through the definition and never
written over, one that does not declare the definition's tables is refused,
named, and what the definition keeps `local` never enters that folder's
history. `getFolder().isOwn`, the handle's `folder.own`, says whether the
handle may publish, for a feature that belongs to the app's own folder only,
such as Todos' Connect.

A browser folder is the directory its ID names, and opening it writes nothing;
the first write creates it. Its remote is its own Git configuration, set by
Connect
([ADR-0532](../docs/adr/0532-a-folder-is-the-directory-its-id-names-with-its-remote-in-git-configuration.md)).
Transfers happen only when a person syncs
([ADR-0489](../docs/adr/0489-folder-transfers-happen-only-when-a-person-syncs.md)),
over plain Git with a token to the server the app was built for, or any Git
remote on the desktop
([ADR-0521](../docs/adr/0521-a-folder-syncs-over-plain-git-with-a-token-to-a-server-the-person-chooses.md)).

## Provide the folder, then read it through context

`<FolderApp>` owns what every app root needs
([ADR-0574](../docs/adr/0574-an-app-opens-its-folder-behind-await-and-provides-its-options-through-context.md)):
one loading screen and one refusal screen worded per `OpenFolderError`; the
page's one `QueryClient`, with one policy (fresh until the folder's change
channel says otherwise, no retry, no wait for a network); `invalidateOnChange`
wired once; one toast for a failed save that offers the unsaved text; and
closing the folder after its writes when the page goes away. Nothing else is
opened in a refused folder's place.

Every component below it reads and writes through `getFolder()`, which
answers `{ folder, isOwn, queries, edits, queryClient, writeFailed, close }`.
`queries` is the TanStack Query layer over the folder's reads
(`folderOptions`), and `edits` the one edit layer every write and draft goes
through (`@epicenter/svelte/edits`):

```ts
const { queries, edits } = getFolder<typeof reading>();
const books = createQuery(() => queries.books.list.queryOptions());
const title = edits.field('books', stem, 'title');
edits.set('books', stem, { read: true });
```

The edit layer holds what a person typed and has not saved: each draft
saves after a pause and when the view leaves it, keeps its text when a save
fails, offers it when the file was deleted elsewhere, and waits its turn
behind the file's other writes. Renames and deletes run once the file's
drafts landed (`exclusive`), Save version and Sync once every one did
(`saveVersion`, `sync`), and closing fences input, then waits for all of it.

An app module adds only product logic, such as a compound action, and is
named for its rows: Todos' `createTodos`, Honeycrisp's `createNotes`,
Capture's `createCaptures`, and Vocab's `entries` and `chats`, which
`createVocab` composes. The root view builds it over `getFolder()`. A save
that fails is reported to `writeFailed` as `{ path, error, unsaved, retry? }`.
Whispering still opens its folder through its own `#platform/workspace`
leaves, and builds its edit layer with `createEdits`.

Input that is not yet committed is local `$state` bound with `bind:value`: a
new-item box, a search, a field being typed.

## Product ownership

Keep the inert declaration separate from opening. Mounted routes start it;
importing a module or preloading a route must not open the folder.

Root handles normally last for the browser/WebView lifetime. Quitting or
restarting the desktop app is immediate and asks no page
([ADR-0542](../docs/adr/0542-quitting-is-immediate-because-unfinished-work-already-lives-in-its-folder.md)),
so work belongs in the folder as soon as it starts. Full document replacement
or desktop restart ends the session. A folder's `close()`
is terminal and awaitable; it settles admitted work. Navigation itself does not
prove that pending work was saved.

Application-specific platform differences that are not the folder use
`#platform/*` subpath imports, resolved at build time, such as Todos'
`#platform/auth` for its account and Whispering's `#platform/workspace`.
Tests open folders over a real directory with `@epicenter/folder/bun`, or
over an in-memory OPFS stand-in, and build the page's context with
`createFolderContext(folder)` from `@epicenter/svelte/folder`.

## Adding an app

1. Declare `defineFolder({ tables })` in `apps/<app>/src/lib/`. Preserve
   existing table and field names. Applications own fallback values; schema
   fields have no defaults.
2. Add `epicenter.app.json` with the app's `id` and `title`.
3. Mount `<FolderApp>` in the primary route, and build the app's views over
   `getFolder()`. Callback and auxiliary routes must not open a second copy.
4. Write work into the folder when it starts, not when the page leaves. A
   sync is an explicit action.
5. If the app needs the hosted API in development, add a `dev:<app>` script at
   the repo root.

[Todos](todos/README.md) is the first app over this model. Inside Epicenter it
is an installed app (ADR-0552) over its own folder, `so.epicenter.todos`, under
the host's folder root: the shell locks that directory and grants it to the
window, and the page
opens it with `@epicenter/folder`'s file storage through the folder plugin's
commands and keeps its history with the system `git`, which the shell runs for it. Capture,
Whispering, and Honeycrisp open their folders the same way. `bun dev:todos` starts the browser build
instead, with the folder in the browser's origin private file system.

Whispering is an installed app in Epicenter, and a browser build, over a
folder; see its [README](whispering/README.md). Honeycrisp is too: its
[README](honeycrisp/README.md) explains its Markdown notes folder, the folder
Epicenter hands it, and its editing drafts. Vocab keeps words and chats in a browser folder and its inference in
`@epicenter/ai`. Epicenter owns the desktop host and Home session for
applications that use that host.
