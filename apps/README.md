# Apps

An application keeps its data in a data folder: Markdown rows, `kv.json`,
`epicenter.json`, and Git history beside them (`@epicenter/folder`). The files
are the data. A recording is a file in the folder from its start
(`@epicenter/recorder`); inference, hosted blobs, and secrets have their own
constructors and lifetimes beside the folder.

Epicenter's desktop applications run as SPAs in Tauri WebViews. The Tauri host
launches a Bun sidecar that serves bundles, HTTP, and the Home session; Rust
owns native mechanisms. A desktop page opens its folder itself, over a
directory the shell grants it. Browser builds open the same folder in the
origin's private file system.

This directory also contains server deployables (`api` and `self-host`), the
public `landing` site, and the `local-books` accounting CLI.

## Declare the folder, then open it

`defineFolder` declares tables and settings. The declaration is inert: importing
it opens nothing. A folder ID names the dataset, conventionally the app's
reverse-domain ID.

```ts
import { defineFolder, defineTable, field } from '@epicenter/folder';

export const todosDefinition = defineFolder({
  kv: {},
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
  id: 'so.epicenter.todos',
  definition: todosDefinition,
});
```

A browser folder is the directory its ID names, and opening it writes nothing;
the first write creates it. Its remote is its own Git configuration, set by
Connect
([ADR-0532](../docs/adr/0532-a-folder-is-the-directory-its-id-names-with-its-remote-in-git-configuration.md)).
Transfers happen only when a person syncs
([ADR-0489](../docs/adr/0489-folder-transfers-happen-only-when-a-person-syncs.md)),
over plain Git with a token to the server the app was built for, or any Git
remote on the desktop
([ADR-0521](../docs/adr/0521-a-folder-syncs-over-plain-git-with-a-token-to-a-server-the-person-chooses.md)).

## Product ownership

Keep the inert declaration separate from opening. Mounted routes start it;
importing a module or preloading a route must not open the folder.

Root handles normally last for the browser/WebView lifetime. Product departure
fences new work and active capture even while navigation is pending. Full
document replacement or desktop restart ends the session. A folder's `close()`
is terminal and awaitable; it settles admitted work. Navigation itself does not
prove that pending work was saved.

Application-specific platform differences use `#platform/*` subpath imports,
resolved at build time: `#platform/folder` for the folder, `#platform/connect`
for Connect, `#platform/departure` for leaving a desktop window. Tests open
folders over a real directory with `@epicenter/folder/bun`, or over an
in-memory OPFS stand-in.

## Adding an app

1. Declare `defineFolder({ kv, tables })` in `apps/<app>/src/lib/`. Preserve
   existing table and field names. Applications own fallback values; schema
   fields have no defaults.
2. Add `#platform/folder` leaves that open the folder in the browser and, if
   the app runs in the desktop host, through `@epicenter/folder/tauri`.
3. Open the folder from the mounted primary route. Callback and auxiliary
   routes must not open a second copy.
4. Connect product work to page departure. A sync is an explicit action.
5. If the app needs the hosted API in development, add a `dev:<app>` script at
   the repo root.

[Todos](todos/README.md) is the first app over this model. Inside Epicenter it
is a compiled application over `so.epicenter.todos` under the host's folder
root: the shell locks that directory and grants it to the window, and the page
opens it with `@epicenter/folder`'s file storage through the folder plugin's
commands and keeps its history with the system `git`, which the shell runs for it. Capture
opens its folder the same way. `bun dev:todos` starts the browser build
instead, with the folder in the browser's origin private file system.

Whispering is a standalone desktop app over a folder; see its
[README](whispering/README.md). Honeycrisp's [README](honeycrisp/README.md)
explains its standalone Tauri shell, native Markdown folder, and local editing
drafts. Vocab keeps words and chats in a browser folder and its inference in
`@epicenter/ai`. Epicenter owns the desktop host and Home session for
applications that use that host.
