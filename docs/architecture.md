# Epicenter architecture

Epicenter is your folders, and apps are lenses
([ADR-0813](adr/0813-epicenter-is-your-folders-and-apps-are-lenses.md)). A
folder is a directory of Markdown and other files that syncs, keeps history, and
is shared with people. An app, the Epicenter app, the command line, or an agent
shows and changes the part of it that it understands. [The vision](vision.md)
says where this is going; this page maps what is built, and names the part that
is not.

Read the [folder package](../packages/folder/README.md) for its contract, the
[application guide](../apps/README.md) for composition, the
[vocabulary](CONTEXT.md), and the [ADRs](adr/README.md) for the decisions.

## A folder on a computer

Every directory directly inside `~/Epicenter` is a folder. `epicenter.json`
(`$schema`, `title`, `collections`) is optional: it adds a title and a contract,
the collections of items with their paths and JSON Schema fields, which give
checking, tables, and merging by field. `epicenter init` proposes one from the
files already there. `AGENTS.md` is written for agents; ADR-0805 makes it carry no front matter, but
a desktop app's data folder still gets one with a `contract` key, which
`epicenter check` reads. A computer keeps the
folder's files and a manifest, `.epicenter/synced.json`, which is a cache, and no
Git: no client links a Git library, and the Rust sync core is deleted
([ADR-0804](adr/0804-a-computer-keeps-a-plain-folder-and-every-surface-syncs-with-one-typescript-function.md)).

An item's front matter is one `key: <JSON>` per line and its body is the
person's ([ADR-0797](adr/0797-front-matter-is-a-strict-grammar-and-anything-else-is-body.md)).
The code still writes block YAML in the contract's key order when an app saves
an item; the grammar's reader and patcher (`@epicenter/definition/front-matter`)
are what sync merges with.

## Sync

One function, `sync({ local, remote, manifest })` in `@epicenter/folder/sync`,
compares the local store, the server's repository, and the manifest, and copies
what changed. A file's version is its Git blob id on every store
([ADR-0808](adr/0808-a-files-version-is-its-git-blob-id-on-every-store.md)).
A store has four verbs, `list`, `read`, `put` (over the version its writer
read, failing with `Moved`), and `watch`, and one conformance suite holds memory,
a Bun directory, the desktop shell, a served directory, and the server's
repository to them. A note both sides changed merges by front matter key and by
line for the body; a conflict leaves Git's markers. The server never merges: it
refuses a commit over a version it no longer holds, and the sync reads what is
there and runs again. `syncAtMoments` runs it when an app opens, after a burst of
saves, when its window returns, and every few seconds while shown.

The CLI runs it today (`epicenter sync`). No app or Epicenter window runs
`syncAtMoments` yet, and the decided rule that every program keeps the folders it
has open in sync
([ADR-0819](adr/0819-every-program-keeps-the-folders-it-has-open-in-sync-and-the-epicenter-app-has-them-all-open.md))
is unbuilt.

## The server

`@epicenter/server` holds each folder as a Git repository at
`<git audience>/folders/<id>` (`<id>` minted at the folder's first sync), with its
history also reachable as a Git remote at `/folders/<id>.git`. Attachments are
stored by their sha256 at `blobs/<sha256>`. A folder has members, who are people,
each an owner, a writer, or a reader. A share is an invitation to an email that
waits until that person accepts it
([ADR-0820](adr/0820-a-share-is-an-invitation-to-an-email-and-reaching-every-folder-is-a-permission.md)).
An app's token reaches the folders attached to it; a token with `folders:all`
(the CLI and the Epicenter app) reaches every folder its person holds.
`apps/api` composes it as the hosted Worker, and on Bun with Postgres for
self-hosting; see the [server README](../packages/server/README.md).

## The platform and the command line

Every operation on folders is a function in `@epicenter/folder/platform`: the
home of folders and their state, `initFolder`, `syncFolder`, `syncEvery`, cloning,
sharing, accepting, and attaching to apps
([ADR-0817](adr/0817-the-cli-exposes-every-platform-operation-and-an-app-inherits-everything-about-folders.md)).
The `epicenter` CLI is a command for each, plus `log`, `diff`, and `restore`
against the server's history. The Epicenter app composes the same functions and
never runs the CLI; no program calls another. `epicenter query`, `set`, `mcp`,
and `normalize` are decided and not built.

## Apps

An app is a view of the folder, a window over one folder, and its capabilities
([ADR-0818](adr/0818-an-app-is-a-view-a-window-and-its-capabilities-and-everything-is-repairable-by-hand.md),
[ADR-0814](adr/0814-one-window-shows-one-folder.md)). Today an app opens its
folder in `src/lib/app.ts`:

```ts
export const folder = openFolder(todos, home({ site: APPS.TODOS.url, account }));
```

`home` is the app's own place, which the build picks: in a Tauri window the data
folder the shell names under `~/Epicenter`, which works with no account; in a
browser the folder on the server attached to the app, through the signed-in
account, online only; and memory under the `test` condition. A script names a
directory (`directory(path)` from `@epicenter/folder/node`). A write never fails:
the folder keeps it, in order, until it lands
([ADR-0775](adr/0775-a-write-never-fails-the-folder-keeps-it-until-it-lands.md)).
A Svelte page reads the folder through `reactive`, and its editors show typed
text until a save lands.

`openFolder(view)`, `defineView`, `@epicenter/app`, the platform's home screen
and history in every window, and the web's memory store seeded from the server
(ADR-0807) are unbuilt. Until they land, an app still chooses its place with
`home` and does not wire sync.

## The Epicenter app

The Epicenter app is where a person sees and manages every folder
([ADR-0816](adr/0816-the-epicenter-app-is-where-a-person-sees-and-manages-every-folder.md)).
It is a Tauri program of its own, optional to the apps and the CLI. Its Folders
window is not built yet; [its README](../apps/epicenter/README.md) says what it
is today. Each standalone app (Capture, Honeycrisp, Todos, Vocab, Whispering) is
also a Tauri program, on the shared `epicenter-standalone` crate
([ADR-0701](adr/0701-apps-run-as-separate-programs.md)), and Epicenter does not
host any of them.

## What to check next

Run apps from the repository root with `bun dev:<app>`: `bun dev:todos:ui` for
a browser demo, `bun dev:epicenter` for the native host.

A rename is pending throughout: the decided words are item (the code says note)
and `{name}` for the file-name placeholder in a path pattern (contracts still
write `{id}`). Older records call one sync a round; there is no round in the code.
