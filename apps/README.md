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

The mounted page opens it. `@epicenter/folder` picks the desktop shell or the
browser's storage when `openFolder` is called
([ADR-0533](../docs/adr/0533-one-folder-handle-opens-in-three-hosts-chosen-by-where-the-code-runs.md)),
and an app that builds for one environment selects its leaf with
`#platform/folder`:

```ts
import { openFolder } from '@epicenter/folder/tauri';

const { data: folder, error } = await openFolder({
  app: 'so.epicenter.todos',
  definition: todosDefinition,
});
```

`app` is the app's id, its manifest `id`. A folder's `epicenter.json` is
published only by the app the folder is named after
([ADR-0583](../docs/adr/0583-a-folders-declaration-is-published-only-by-the-app-it-is-named-after.md)).
In a browser the app opens its own folder. In the desktop app it opens the
folder the shell handed its window, or its own when handed none; any folder
but its own is read through the definition and never written over, and one
that does not declare the definition's tables is refused, named.
`folder.own` says which, for a feature that belongs to the app's own folder
only, such as Todos' Connect.

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

This section is proposed, not built: no app has `FolderProvider` or
`getFolder()` yet
([ADR-0574](../docs/adr/0574-an-app-opens-its-folder-behind-await-and-provides-its-options-through-context.md),
Proposed). Today every app opens its folder in its root page behind
`{#await}`, as below, then builds its own store object around
`folderOptions(folder)`, such as Todos' `createTodos`.

The root page starts opening the folder when it mounts and waits with
`{#await}`; loading and a refusal are screens. Once it is open,
`FolderProvider` creates the page's `QueryClient`, provides
`folderOptions(folder)` with `setFolder`, connects `invalidateOnChange` once,
and closes the folder after its writes when the page goes away
([ADR-0574](../docs/adr/0574-an-app-opens-its-folder-behind-await-and-provides-its-options-through-context.md)).

```svelte
{#await opening}<Loading … />{:then opened}
	{#if opened.error}<Empty …>{opened.error.message}</Empty>
	{:else}<FolderProvider folder={opened.data}>{@render children()}</FolderProvider>{/if}
{/await}
```

Every component reads and writes through `getFolder()`:

```ts
const folder = getFolder();
const book = createQuery(() => folder.books.get.queryOptions(stem));
const setBook = createMutation(() => folder.books.set.mutationOptions());
```

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

Application-specific platform differences use `#platform/*` subpath imports,
resolved at build time: `#platform/folder` for the folder, `#platform/connect`
for Connect. Tests open
folders over a real directory with `@epicenter/folder/bun`, or over an
in-memory OPFS stand-in.

## Adding an app

1. Declare `defineFolder({ tables })` in `apps/<app>/src/lib/`. Preserve
   existing table and field names. Applications own fallback values; schema
   fields have no defaults.
2. Add `#platform/folder` leaves that open the folder in the browser and, if
   the app runs in the desktop host, through `@epicenter/folder/tauri`.
3. Open the folder from the mounted primary route. Callback and auxiliary
   routes must not open a second copy.
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
