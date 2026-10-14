# Apps

An application composes the stores and services its workflows need. Each store
owns its tables, KV, and cleanup; Local also owns its blobs. Hosted blobs,
recording, inference, SQL, and secrets have their own constructors and lifetimes.

Epicenter's desktop applications run as SPAs in Tauri WebViews. The Tauri host
launches a Bun sidecar that serves bundles, HTTP, WebSockets, and the Home
session; Rust owns native mechanisms. The host brokers credentials and device
resources without opening an application's synchronized store. Browser builds
open stores through the same API.

This directory also contains server deployables (`api` and `self-host`), the
public `landing` site, the `local-books` accounting CLI, and the `sync-lab`
harness. Local Mail has a Svelte UI in `local-mail/ui` and Gmail cache and triage
operations in `local-mail/src`.

## Declare data, then acquire resources

`defineStore` declares a stable store ID and schema. The declaration is inert:
importing it opens no storage and captures no Account. Applications can reuse a
definition across Local and Personal or use different definitions by workflow.
The definition ID names its data and Local blob namespace; host application
identity remains separate even when the two use the same string.

```ts
import { defineStore, defineTable, field } from '@epicenter/app';

export const notesDefinition = defineStore({
  id: 'com.example.notes',
  title: 'Notes',
  kv: {},
  tables: { notes: defineTable({ fields: { title: field.string() } }) },
});
```

The mounted product acquires the resources it needs. A store opener resolves
with a usable handle after required acquisition and hydration:

```ts
import { openLocal, openPersonal } from '@epicenter/app/open';

const local = await openLocal(notesDefinition);
local.tables.notes.create({ title: 'On this device' });

// A workflow requiring synchronized data supplies its captured Account.
const personal = await openPersonal(notesDefinition, { account });
personal.tables.notes.create({ title: 'Personal notes' });
```

Local and Personal hold separate datasets. Local retains its namespace across
sign-in and account changes. Personal captures its account identity and transport
when opening and never retargets. Signing in does not move Local data to Personal.
Each workflow names its destination; products decide which features require
sign-in and which acquisitions may proceed independently.

Recording borrows an opened Local store's blobs through
`createRecorder({ localBlobs: local.blobs })`. Stores expose local SQL through `store.sqlite`; secrets take their own
namespace IDs. Inference takes the account, runtime, or endpoint it uses. Schema
consumers, tests, and artifact tools import the same definition without opening
these resources.

See the [resource contract](../packages/app/README.md) for acquisition and cleanup,
and the [data contract](../packages/app/src/data/README.md) for schema and store
behavior. [ADR-0423](../docs/adr/0423-app-resources-open-as-independent-handles.md)
records resource composition; [ADR-0430](../docs/adr/0430-define-store-declares-data-and-products-compose-resources.md)
records the declaration name.

## Product ownership

Keep the inert declaration separate from live acquisition. Vocab uses
`src/lib/data.ts` and `src/lib/folder.ts` for one account-independent browser
folder through `@epicenter/folder/browser`. Mounted routes start acquisition.
Importing those modules or preloading a route must not acquire root resources.

Whispering is a standalone desktop app whose
data is a Git-versioned folder of files (`@epicenter/folder`). Its declaration
is `src/lib/definition.ts`, and its mounted page opens a workspace from
`src/lib/workspace/`. See its [README](whispering/README.md).

Pass the store or capability a consumer needs. Product composition functions
express startup dependencies and feature availability; they do not create a
mandatory SDK App handle or one readiness barrier for unrelated services.

Root handles normally last for the browser/WebView lifetime. Product departure
fences new work and active capture even while navigation is pending. Full document
replacement or desktop restart ends the session. Explicit resource `close()` is
terminal and awaitable; it settles admitted work and leaves sibling resources
usable. Temporary owners close their own handles. Navigation itself does not
prove that pending work was saved.

Application-specific platform differences use `#platform/*` subpath imports.
Honeycrisp's `#platform/auth` selects its host or browser binding at build time.
`@epicenter/app` selects its default browser or host resource implementations
through `isTauri()`. Store tests inject `createMemoryStoreRuntime()` from
`@epicenter/app/testing` into the store opener. Other resource tests supply the
bindings that resource needs.

## Adding an app

1. Declare `defineStore({ id, title, kv, tables })` in
   `apps/<app>/src/lib/data.ts`. Preserve existing durable IDs, table names, and
   field names. Applications own fallback values; schema fields have no defaults.
2. Add a product opening function beside the declaration. Open the required
   stores and services, capturing an Account only where needed. Keep optional
   feature acquisition from blocking unrelated workflows.
3. Start opening from the mounted primary route. Callback and auxiliary routes
   must not acquire a second primary persistence owner. Pass usable stores and
   capabilities to services and UI.
4. Connect product work to page departure and account retirement. Do not retarget
   retained handles when credentials change.
5. If the app needs the hosted API in development, add a `dev:<app>` script at
   the repo root.

[Todos](todos/README.md) keeps a file-first folder (`@epicenter/folder`)
rather than a Yjs store. Inside Epicenter it is a compiled application over an
ordinary directory, `so.epicenter.todos` under the host's working-copy
directory. The shell locks that directory and grants it to the window; the
page opens it with `@epicenter/folder`'s file storage through Tauri's fs
plugin and keeps its history with the system `git`, which the shell runs for
it. `#platform/folder` selects the desktop adapter at build time. Capture and installed apps still reach their folders through the
shared Rust Folder plugin's owner. `bun dev:todos` starts the browser build
instead, with the folder in the browser's origin private file system (OPFS)
and a loopback Git backend for development. A browser connects its folder to a
private GitHub repository through the hosted API's connector. The desktop
build still needs no hosted API for its folder.

A browser folder is the OPFS directory its ID names, holding its files and
`.git`. Opening writes nothing; the first write creates it. Its remote is its
own Git configuration, set by Connect
([ADR-0532](../docs/adr/0532-a-folder-is-the-directory-its-id-names-with-its-remote-in-git-configuration.md)).
Opening uses only OPFS and does not read earlier IndexedDB databases.

Honeycrisp's [README](honeycrisp/README.md) explains its standalone Tauri shell,
native Markdown folder, and local editing drafts. It needs neither the Epicenter
host nor an account. [Local Mail's README](local-mail/README.md) explains its
saved queries and Gmail cache. Epicenter owns the desktop host and Home session
for applications that use that host.
