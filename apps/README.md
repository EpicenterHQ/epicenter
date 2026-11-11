# Apps

Two kinds of app live here: Epicenter's own apps for `~/Epicenter`, and the
apps frozen on the folder sync product, which waits.

## Apps for ~/Epicenter

Capture, Reading, Tasks, and Vocab are the source of starters for apps in
`~/Epicenter`
([ADR-0864](../docs/adr/0864-epicenter-is-a-data-server-for-repositories-of-files-and-code-runs-where-its-owner-trusts-it.md),
[ADR-0866](../docs/adr/0866-an-app-starts-from-a-starter-kept-as-its-upstream-and-update-merges-the-starters-changes.md)).
Each folder is laid out as the app is:

```txt
apps/vocab/
  epicenter.ts          the app: its collections and actions, composed by defineApp
  epicenter.test.ts     the actions' tests, in memory
  package.json          what the actions' types and tests need
  ui/                   the UI, a SvelteKit project of its own
  .cache/ui/            the built UI, ignored
```

A starter is a repository of its own whose root is the app's root, and
`epicenter new vocab --from <git url|path>` makes an app from it, keeping it
as the app's `upstream`; `epicenter update` merges its later changes and
builds the UI. These folders become starters when each moves to a
repository of its own, which waits on publishing `@epicenter/app` and
`@epicenter/ui`: here their packages are `workspace:*` and `catalog:`.

`epicenter` supplies `@epicenter/app` to an `epicenter.ts` when it runs it, so
the app's root `package.json` is only for whoever edits the actions. `ui/`
has its own `package.json`, whose `build` writes `../.cache/ui/`.
`epicenter serve` serves `.cache/ui/` at `/<app>/`, and MCP at `/`. A UI asks
for everything through `connect<typeof app>('<app>')` from
`@epicenter/app/client`, typed by the app it imports as a type, and keeps
nothing of its own. Its `src/lib/app.ts` lists the actions its pages read and
write as TanStack Query options (ADR-0661), and its layout's QueryClient
refreshes every read after each write.

A UI is a static SvelteKit build with hash routes, a record's page at its
path (`#/tasks/<time>.md`), so the server serves files and routes nothing. Its base is `/<the app's folder name>`, the
path `epicenter serve` mounts it at. In development, `bun run dev` in `ui/`
sends a POST to `/` (MCP) to a running `epicenter serve` (`EPICENTER_URL`,
default `http://127.0.0.1:4747`).

| App | Collections | Its own actions |
| --- | --- | --- |
| [Capture](capture) | `captures` | `add`, `recent` |
| [Tasks](tasks/README.md) | `tasks` | `add` |
| [Vocab](vocab) | `words` | `add`, `review`, `due` |

## Apps frozen on the folder sync product

The apps below are frozen on the folder sync product, which waits
([ADR-0840](../docs/adr/0840-epicenter-is-where-one-persons-software-lives-and-the-folder-sync-product-waits.md)).
Each still runs over its local folder, and nothing syncs it. In its turn each
is rebuilt as an app whose `epicenter.ts` defines its actions
([ADR-0841](../docs/adr/0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md)),
with its pages on top, and the frozen copy leaves when the rebuilt one runs
([ADR-0843](../docs/adr/0843-new-code-imports-nothing-from-the-waiting-product-which-leaves-by-deletion.md)).
The rest of this page describes them as they were built.

An app is a lens on a person's folders: a view of what it understands in a
folder, a window over one folder, and its capabilities
([ADR-0813](../docs/adr/0813-epicenter-is-your-folders-and-apps-are-lenses.md),
[ADR-0818](../docs/adr/0818-an-app-is-a-view-a-window-and-its-capabilities-and-everything-is-repairable-by-hand.md)).
Today an app describes that view as a contract (`defineContract` from
`@epicenter/definition/contract`) and opens its folder through
`@epicenter/folder`, which gives it each of the contract's collections, read
with `items`, `get` and `list` and written with `set` and `delete`, which
never fail: the folder keeps a write until it lands
([ADR-0775](../docs/adr/0775-a-write-never-fails-the-folder-keeps-it-until-it-lands.md)).
Any program that writes the layout is a valid writer. The decided shape is
`openFolder(view)` over the folder a window was opened on, with the home,
sync, history, and sharing supplied by the platform
([ADR-0815](../docs/adr/0815-the-platform-gives-a-window-its-folder-and-every-app-the-same-home.md));
`defineView` and `@epicenter/app` are not built.

On a computer an app reads and writes files and does not sync: only
Epicenter's programs (the Epicenter app, the CLI, `epicenter mcp`) do
([ADR-0822](../docs/adr/0822-only-epicenter-syncs-on-a-computer-and-a-folder-holds-only-its-content.md)),
and no Git runs there
([ADR-0804](../docs/adr/0804-a-computer-keeps-a-plain-folder-and-every-surface-syncs-with-one-typescript-function.md)).
A folder's history is its ledger on the server, at
`<api origin>/folders/<id>`. A web app has no disk, so its folder is the
folder on the server and each save is a change
([ADR-0823](../docs/adr/0823-on-the-web-the-folder-on-the-server-is-the-apps-store.md)).
The code still says note and `{id}` where the records
decided item and `{name}`; the rename is pending
([ADR-0802](../docs/adr/0802-people-share-spaces-an-app-works-in-one-at-a-time-and-a-folder-carries-its-contract.md)).

## Variants

An app has one build, which serves the web and its desktop window
([ADR-0781](../docs/adr/0781-apps-branch-on-what-a-capability-offers-and-one-build-serves-every-surface.md));
each surface has one store for the page's life. Every web app is online
and keeps nothing in the browser
([ADR-0786](../docs/adr/0786-every-web-app-is-online-and-browser-storage-leaves-the-platform.md)).

Every surface opens its folder the same way, `openFolder(contract,
home({ site, account }))` from `@epicenter/folder`, and `home` picks its
store where the page runs:

| Surface | Store | The account |
| --- | --- | --- |
| Desktop (a Tauri window) | a folder on the computer, which Epicenter (the app, the CLI) syncs, never the app | only for hosted features: its token holds only `ai`, and its shell relays only inference ([ADR-0822](../docs/adr/0822-only-epicenter-syncs-on-a-computer-and-a-folder-holds-only-its-content.md)) |
| Web | the folder attached to the app, on the server, behind sign-in | required |

| App | Surfaces |
| --- | --- |
| Honeycrisp, Whispering | web, desktop |
| Messages | local (a program on the computer where Beeper Desktop runs) |

The surfaces need not promise the same things
([ADR-0780](../docs/adr/0780-a-surface-uses-what-its-platform-gives-and-parity-is-not-a-goal.md)).
A guarantee that needs a process outliving the page is the desktop's:
keeping a recording through a crash or a closed window, recording in the
background, a global shortcut, and working on a folder offline, which Epicenter
syncs when it can. Each app's
README says what its web build does not promise.

Each desktop app is a Tauri program of its own
([ADR-0701](../docs/adr/0701-apps-run-as-separate-programs.md)) that loads
the same build the web serves. Honeycrisp and Whispering share the
[`epicenter-standalone`](../packages/tauri-epicenter-standalone/README.md)
crate, which also describes how a web app gains a desktop window.

## Svelte app root

Every app opens its capabilities once, in `src/lib/app.ts`, and adapts each
for Svelte there with `reactive`
([ADR-0766](../docs/adr/0766-an-apps-capabilities-are-module-values-opened-synchronously.md),
[ADR-0769](../docs/adr/0769-svelte-reads-every-capability-through-one-reactive-copy.md)).
Nothing in it awaits, and an edit to it reloads the page
([ADR-0768](../docs/adr/0768-retry-belongs-to-a-failure-and-editing-app-ts-reloads-the-page.md)):

```ts
// apps/honeycrisp/src/lib/app.ts
const signIn = connectAccount({ clientId: 'so.epicenter.honeycrisp', api: APP_URLS.API, selfHosted: SELF_HOST_ORIGIN });

export const account = reactive(signIn);
export const folder = reactive(
  openFolder(honeycrisp, home({ site: APPS.HONEYCRISP.url, account: signIn })),
);
```

The page connects once to its stores: the folder and, where the app keeps
any, this computer's settings (`settings` from `@epicenter/local`), passed
to `<WhenOpen>` from `@epicenter/svelte` beside the folder
([ADR-0778](../docs/adr/0778-a-page-connects-once-and-then-reads-synchronously.md)).
`<WhenOpen>` shows a spinner after 150 ms while they connect, Recovery with
Retry when one cannot, the pages once both have, and the leave guard while
a write is out. Every read inside it is synchronous.
Where the folder is on the server, a signed-out person is asked to sign in
first; a folder on this computer (`folder.reveal`) needs no sign-in:

```svelte
<!-- apps/honeycrisp/src/routes/(app)/+layout.svelte -->
{#if folder.reveal === null && account.state().status === 'signed-out'}
  <SignIn {account} />
{:else}
  <WhenOpen app="Honeycrisp" {folder}>{@render children()}</WhenOpen>
{/if}
```

One build serves every surface
([ADR-0781](../docs/adr/0781-apps-branch-on-what-a-capability-offers-and-one-build-serves-every-surface.md)):
each capability package decides where the page runs, and a view branches
on what a capability offers, such as the header's `FolderChrome` where
`folder.reveal` is there and `RepositoryChrome` otherwise. (`FolderChrome`
says whether Epicenter syncs the folder, from the record Epicenter keeps,
and where to get Epicenter until it does: a desktop app never syncs,
ADR-0822.) Components import `folder` from `$lib/app.js`.

UI components read a collection off `folder`, sort with the app's own
order, and read and write through it: `items()`, `invalid()` (notes that
do not read, with their text), and `set` and `delete`, which settle a change
another writer made since the way sync does. The component that shows a
note makes one editor of it (`notes.edit({ id })`), gates on `exists()`,
and binds its `fields`. See [Honeycrisp](honeycrisp/README.md) and the
[Svelte package](../packages/svelte/README.md).

## Running an app

The root `bun dev:<app>` scripts start each app's required development
processes. `bun dev:<app>:desktop` and `bun build:<app>:desktop` start and
build a desktop app (`honeycrisp`, `whispering`) over the app's dev server or its `build/`; they need a Rust
toolchain. Each app README names its route
and test commands.

## Where each app's files live

A desktop app on `epicenter-standalone` opens the folder its shell derives
from its site: `~/Epicenter/<label>` for Epicenter apps and
`~/Epicenter/<owner>/<label>` for other apps. Development builds use
`~/Epicenter Dev` as the root. The folder is made when missing for now.
A failed open shows `<WhenOpen>`'s recovery screen with Retry. The decided
shape is a folder directly inside the Epicenter folder that the app's first
run offers to make or to pick, and that the app remembers by its id
([ADR-0813](../docs/adr/0813-epicenter-is-your-folders-and-apps-are-lenses.md)).
The Epicenter app and the CLI commands that synced and shared these folders
are deleted; the `folder-sync-product` tag keeps them.

| App | Surfaces | Desktop folder | Contract |
| --- | --- | --- | --- |
| [Honeycrisp](honeycrisp/README.md) | web; desktop | `~/Epicenter/honeycrisp` | `honeycrisp`: `notes`, `folders` |
| [Whispering](whispering/README.md) | web; desktop | `~/Epicenter/whispering` | `whispering`: `recordings`, `audio`, `transcriptions`, `transformations`, `transformation_runs`, `text_runs`, `shortcuts` |
| [Messages](messages/README.md) | local program (`bun run --cwd apps/messages start`) | none: `<AppData>/apps/so.epicenter.messages`, which its program owns | `messages`: `drafts`, `attempts` |

A web app keeps none of its files in the browser. The Epicenter app keeps no
data of its own; the Epicenter folder, `~/Epicenter` (`~/Epicenter Dev` for a
development build, whose `tauri.dev.conf.json` states
`"environment": "development"`), holds the standalone apps' folders and every
other folder a person has. The Rust comments still call it the library root
([ADR-0816](../docs/adr/0816-the-epicenter-app-is-where-a-person-sees-and-manages-every-folder.md)). A
standalone app reaches its folder and its AppData by name, never by path
([ADR-0725](../docs/adr/0725-an-app-reaches-named-roots-through-one-command-per-storage-operation.md)),
and whatever is at its folder's path is its own
([ADR-0726](../docs/adr/0726-an-apps-path-is-its-claim.md)).

Local Books keeps its QuickBooks replica in SQLite under
`<AppData>/apps/so.epicenter.local-books`, outside the Epicenter folder. `api`,
`landing`, and `posthog-reverse-proxy` are infrastructure and open no folder.

## Product root names

Name each product root `<Product>App`: `HoneycrispApp`, `WhisperingApp`,
and `MessagesApp`. This
component composes the product's state and interface over the folder
`src/lib/app.ts` opened; nothing under it chooses a store.

Use `Shell` for surrounding layout and `View` for a screen or representation.
Keep a specific tool name such as `FolderEditor` for a window within a larger
application. For the naming rationale, see
[product root component names](../docs/adr/0655-product-root-components-use-the-app-name-and-app-suffix.md).

## Messages and Beeper

[Messages](messages/README.md) keeps its drafts and send attempts as notes of
its own contract in a directory its program owns on this computer, outside
the Epicenter folder. Conversation history stays in Beeper and is read into
memory.
Messages runs as a local program on the computer where Beeper Desktop runs
(`bun run --cwd apps/messages start`): its server answers the page's
requests of its drafts' directory, and its Beeper requests through the
Epicenter CLI, which keeps the token in the device keychain. It starts with
fictional demo chats, and `bun dev:messages` shows only those.
