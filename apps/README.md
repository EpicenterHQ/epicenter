# Apps

An app's data is a layout of files that its contract describes
(`defineContract` from `@epicenter/definition/contract`), and Git is the
record of that layout
([ADR-0700](../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)).
An app opens its folder through `@epicenter/folder`, which gives it each of
the contract's collections, read with `items`, `get` and `list` and written
with `set` and `delete`, which never fail: the folder keeps a write until it
lands ([ADR-0775](../docs/adr/0775-a-write-never-fails-the-folder-keeps-it-until-it-lands.md)).
Any program that writes the layout is a valid writer. Apps never
commit: Epicenter (`epicenter sync`) commits a folder on a computer, and the
server commits each web write.

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
| Desktop (a Tauri window) | a folder on the computer | optional: signing in syncs the folder ([ADR-0785](../docs/adr/0785-a-desktop-app-signs-in-to-sync-its-own-folder.md)) |
| Web | the person's repository, behind sign-in | required |

| App | Surfaces |
| --- | --- |
| Capture, Honeycrisp, Todos, Vocab, Whispering | web, desktop |
| Messages | local (a program on the computer where Beeper Desktop runs) |

The surfaces need not promise the same things
([ADR-0780](../docs/adr/0780-a-surface-uses-what-its-platform-gives-and-parity-is-not-a-goal.md)).
A guarantee that needs a process outliving the page is the desktop's:
keeping a recording through a crash or a closed window, recording in the
background, a global shortcut, and syncing a folder offline. Each app's
README says what its web build does not promise.

Each desktop app is a Tauri program of its own
([ADR-0701](../docs/adr/0701-apps-run-as-separate-programs.md)) that loads
the same build the web serves. Capture, Honeycrisp, Todos, Vocab and
Whispering share the
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
// apps/todos/src/lib/app.ts
const signIn = connectAccount({ clientId: 'so.epicenter.todos', api: APP_URLS.API, selfHosted: SELF_HOST_ORIGIN });

export const account = reactive(signIn);
export const folder = reactive(
  // `home` says the account needs the repository (ADR-0792).
  openFolder(todos, home({ site: APPS.TODOS.url, account: signIn })),
);
```

The page connects once to its stores: the folder and, where the app keeps
any, this computer's settings (`settings` from `@epicenter/local`), passed
to `<WhenOpen>` from `@epicenter/svelte` beside the folder
([ADR-0778](../docs/adr/0778-a-page-connects-once-and-then-reads-synchronously.md)).
`<WhenOpen>` shows a spinner after 150 ms while they connect, Recovery with
Retry when one cannot, the pages once both have, and the leave guard while
a write is out. Every read inside it is synchronous.
Where the folder is the person's repository, a signed-out person is asked
to sign in first; a folder on this computer (`folder.reveal`) needs no
sign-in:

```svelte
<!-- apps/todos/src/routes/(app)/+layout.svelte -->
{#if folder.reveal === null && account.state().status === 'signed-out'}
  <SignIn {account} />
{:else}
  <WhenOpen app="Todos" {folder}>{@render children()}</WhenOpen>
{/if}
```

One build serves every surface
([ADR-0781](../docs/adr/0781-apps-branch-on-what-a-capability-offers-and-one-build-serves-every-surface.md)):
each capability package decides where the page runs, and a view branches
on what a capability offers, such as the header's `FolderChrome` where
`folder.reveal` is there and `RepositoryChrome` otherwise. Components
import `folder` from `$lib/app.js`.

UI components read a collection off `folder`, sort with the app's own
order, and read and write through it: `items()`, `invalid()` (notes that
do not read, with their text), and `set` and `delete`, which settle a change
another writer made since the way sync does. The component that shows a
note makes one editor of it (`todos.edit({ id })`), gates on `exists()`,
and binds its `fields`. See [Todos](todos/README.md),
[Capture](capture/README.md) and the
[Svelte package](../packages/svelte/README.md).

## Running an app

The root `bun dev:<app>` scripts start each app's required development
processes. `bun dev:<app>:desktop` and `bun build:<app>:desktop` start and
build a desktop app (`capture`, `honeycrisp`, `todos`, `vocab`,
`whispering`) over the app's dev server or its `build/`; they need a Rust
toolchain. Each app README names its route
and test commands.

## Where each app's files live

A desktop app on `epicenter-standalone` opens the folder its shell derives
from its site: `~/Epicenter/<label>` for Epicenter apps and
`~/Epicenter/<owner>/<label>` for other apps. Development builds use
`~/Epicenter Dev` as the root. The folder is made when missing for now.
A failed open shows `<WhenOpen>`'s recovery screen with Retry. **Set up in Epicenter**
enrolls the folder for local history; connecting a repository there enables transfer.

| App | Surfaces | Desktop folder | Contract |
| --- | --- | --- | --- |
| Epicenter | Folders, Settings | none | none |
| [Todos](todos/README.md) | web; desktop | `~/Epicenter/todos` | `todos`: `todos` |
| [Capture](capture/README.md) | web; desktop | `~/Epicenter/capture` | `capture`: `captures` |
| [Honeycrisp](honeycrisp/README.md) | web; desktop | `~/Epicenter/honeycrisp` | `honeycrisp`: `notes`, `folders` |
| [Vocab](vocab/README.md) | web; desktop | `~/Epicenter/vocab` | `vocab`: `entries`, `chats`, `messages` |
| [Whispering](whispering/README.md) | web; desktop | `~/Epicenter/whispering` | `whispering`: `recordings`, `audio`, `transcriptions`, `transformations`, `transformation_runs`, `text_runs`, `shortcuts` |
| [Messages](messages/README.md) | local program (`bun run --cwd apps/messages start`) | none: `<AppData>/apps/so.epicenter.messages`, which its program owns | `messages`: `drafts`, `attempts` |

A web app keeps none of its files in the browser. The Epicenter app keeps no data of its own; its
library root, `~/Epicenter` (`~/Epicenter Dev` for a development build, whose
`tauri.dev.conf.json` states `"environment": "development"`), holds the
standalone apps' folders. A
standalone app reaches its folder and its AppData by name, never by path
([ADR-0725](../docs/adr/0725-an-app-reaches-named-roots-through-one-command-per-storage-operation.md)),
and whatever is at its folder's path is its own
([ADR-0726](../docs/adr/0726-an-apps-path-is-its-claim.md)).

Local Books keeps its QuickBooks replica in SQLite under
`<AppData>/apps/so.epicenter.local-books`, outside the library. `api`,
`landing`, and `posthog-reverse-proxy` are infrastructure and open no folder.

## Product root names

Name each product root `<Product>App`: `TodosApp`, `CaptureApp`,
`HoneycrispApp`, `VocabApp`, `WhisperingApp`, and `MessagesApp`. This
component composes the product's state and interface over the folder
`src/lib/app.ts` opened; nothing under it chooses a store.

Use `Shell` for surrounding layout and `View` for a screen or representation.
Keep a specific tool name such as `FolderEditor` for a window within a larger
application. For the naming rationale, see
[product root component names](../docs/adr/0655-product-root-components-use-the-app-name-and-app-suffix.md).

## Messages and Beeper

[Messages](messages/README.md) keeps its drafts and send attempts as notes of
its own contract in a directory its program owns on this computer, outside
the library. Conversation history stays in Beeper and is read into memory.
Messages runs as a local program on the computer where Beeper Desktop runs
(`bun run --cwd apps/messages start`): its server answers the page's
requests of its drafts' directory, and its Beeper requests through the
Epicenter CLI, which keeps the token in the device keychain. It starts with
fictional demo chats, and `bun dev:messages` shows only those.
