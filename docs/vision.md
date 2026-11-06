# Vision

**Epicenter is your folders, and apps are lenses** ([ADR-0813](adr/0813-epicenter-is-your-folders-and-apps-are-lenses.md)).
A folder in `~/Epicenter` holds your things, syncs, keeps history, and is
shared with people; an app, the Epicenter app, the command line, or an agent shows
and changes the part of it that it understands.

It is the document architecture of desktop systems with a folder as the
document ([ADR-0815](adr/0815-the-platform-gives-a-window-its-folder-and-every-app-the-same-home.md)):

| Desktop documents | Epicenter |
| --- | --- |
| a document | a folder in `~/Epicenter` |
| a document-based app | an app: a view and a window |
| the start screen and Open | the home: folders that fit, and New |
| one window per document | one window per folder |
| autosave | writes that never fail |
| Browse All Versions | History, from the folder's Git history on the server |
| Share and iCloud | Share with people, and sync |
| Finder | the Epicenter app |

An app is a view (what it understands in a folder), a window over one folder,
and its capabilities; the platform does everything about folders
([ADR-0818](adr/0818-an-app-is-a-view-a-window-and-its-capabilities-and-everything-is-repairable-by-hand.md),
[ADR-0817](adr/0817-the-cli-exposes-every-platform-operation-and-an-app-inherits-everything-about-folders.md)).
And everything is repairable by hand: whatever the platform does, plain file
operations can do too, and the files are the only truth.

Where Epicenter is going, on one page. Each section links the records that
decided it; read them for the reasons and the detail. This is direction, not
current truth: most of it is unbuilt, and each record's `Unbuilt` line says
what is missing. Built so far: one build for every surface, the online web,
the folder's one write over stores of four verbs, the plain folder with its
one sync function, a server that keeps each folder's history and shares it
with people, and the CLI commands that sync, share, and read them. No app
syncs yet, and no app is a view yet. [Positioning](positioning.md) owns what
Epicenter claims today; [CONTEXT](CONTEXT.md) owns the vocabulary.

Under all of it sit three roots and one rule for apps ([ADR-0763],
[ADR-0818]):

| Root or rule | What it means now |
| --- | --- |
| Your things are files in a place you can see | a folder under `~/Epicenter`, or the app's container on a phone |
| Programs meet in shared places, never by calling each other | the folder and its manifest; the model cache |
| Speak the standard; invent only what none covers | Git, OAuth, JSON Schema, HTTP, MCP |
| An app is a view, a window, and its capabilities | it names what it understands and needs; the platform supplies the folder |

## A folder is files

```txt
~/Epicenter/
├── todos/                      a folder, labeled by its directory's name
│   ├── epicenter.json          optional: a title and a contract
│   ├── AGENTS.md               prose for agents; written once, then yours
│   ├── todos/call-dentist.md   an item: front matter, then body
│   └── .epicenter/             this computer's cache, including synced.json
└── Ancestry/                   another folder, shared with a family
```

Every directory directly in `~/Epicenter` is a folder; one elsewhere joins by
a symbolic link there. Nothing is registered ([ADR-0813], [ADR-0815]).

`epicenter.json` holds `$schema`, a `title`, and `collections`: path patterns
such as `todos/{name}.md`, with JSON Schema for the fields. A pattern ending
in `.md` holds items, any other holds files, and files sharing a directory
and a name are one item ([ADR-0805], [ADR-0818]). An item's name is its file
name, and a rename is a write and a delete ([ADR-0776]). The folder's people
own the contract; an app's schema is a view that must fit it, and attaching
an app only adds ([ADR-0812]). The code still says note and `{id}`
where the records decided item and `{name}` ([ADR-0802]); the rename is
pending.

An item's front matter is the machine's; its body is the person's and the
app's. Front matter is YAML restricted to one `key: <JSON>` per line
([ADR-0796], [ADR-0797]):

```md
---
title: "Call dentist"
done: false
tags: ["health"]
---
Ask about the Thursday slot.
```

A file outside that grammar has no front matter: it is all body and shows as
invalid. Normalize rewrites another tool's YAML into the grammar when a
person asks or a write touches the item, never on a read.

## Sync

A computer keeps a folder's files and a manifest, and no Git ([ADR-0804]).
One TypeScript function, `sync(local, remote, manifest)`, compares the local
store, the folder's log on the server at `/folders/<id>`, and
`.epicenter/synced.json`, a cache. A file's version is the SHA-256 of its
bytes on every store ([ADR-0803], [ADR-0824]).

| What | How it merges |
| --- | --- |
| an item's body | Git's three-way line merge; a clash leaves Git's markers |
| an item's front matter | by key: a key one side changed takes that side; a key both changed takes the later write |
| any other file | the later write; the other stays in history |
| an edit against a delete | the edit |

The key rule is about forty lines of TypeScript ([ADR-0795]). The server never
merges: it refuses a commit over a blob its writer did not expect, and the
sync reads what is there and runs again ([ADR-0773]). Every write is over the
version read, so two programs may sync one folder at once and neither loses
an edit ([ADR-0805]). A rename beside an edit leaves both items, and a
deleted item edited elsewhere returns ([ADR-0806]). A person sees ✓ synced,
◌ waiting, ⚠ a conflict in a body, and ✗ a file the server refused, never
Git's steps ([ADR-0788], [ADR-0789], [ADR-0807]).

History is the server's: `epicenter log`, `diff`, and `restore`, or plain
`git clone` of `/folders/<id>.git`. A folder syncs only with an Epicenter
server, hosted or self-hosted.

A store is a place bytes live: memory, a directory, the desktop shell's root.
It has four verbs (`list`, `read`, `watch`, and `put(path, bytes | null,
expect)`, which lands only over the version expected) ([ADR-0779]), and a
local store will add `patch` for fields ([ADR-0798]). An app writes with
`set` and `delete`, and a write never fails: the folder keeps it, in order,
until it lands ([ADR-0774], [ADR-0775]). Only sync talks to the server; a web
app's store is memory seeded from the repository ([ADR-0807]).

Every program keeps the folders it has open in sync while it has them open: a
window its folder, the Epicenter app every folder, `epicenter mcp` the folders
it writes, none coordinating with another ([ADR-0806], [ADR-0819]).

## Sharing

A folder is the one thing synced and shared ([ADR-0811]). Its members are
people, and a share is an invitation to an email: it waits until a person with
that email accepts, and grants nothing before. Members are equal, a reader
only reads, and a folder lives while any member remains ([ADR-0820]). Its
title is a field of `epicenter.json`; the directory's name is each computer's
own label.

A first sync joins the folder it names before it creates one, and a copied
folder asks whether it is a copy or the same folder moved before it pushes. An
app reaches only the folders attached to it. The CLI and the Epicenter app
hold `folders:all`, reach every folder, and are the only programs that attach
a folder to an app ([ADR-0811], [ADR-0820]).

## Apps

An app is a view, a window, and its capabilities ([ADR-0818]):

```ts
export const view = defineView({ recordings: { path: 'recordings/{name}.md', fields: { title: text() } } });
export const folder = openFolder(view); // the folder this window was opened on
export const recorder = openRecorder();
```

Today an app calls `openFolder(contract, home({ site, account }))`; `defineView`
and `@epicenter/app` are unbuilt.

A window shows one folder for its life; another folder opens in another
window, and views across folders are the Epicenter app's ([ADR-0814]). The
platform owns the home and everything about folders: sync, history, sharing,
conflicts, the fit check. An app places the platform's pieces and replaces
none ([ADR-0815], [ADR-0817]).

A program holds no logic of its own: what Epicenter means is TypeScript, and
the OS (files and their watch, credentials, audio, local models, shortcuts) is
Rust, which holds no Git ([ADR-0793], [ADR-0804]).

## Surfaces

| Surface | What it opens | Signing in |
| --- | --- | --- |
| Desktop app | a folder on this computer, complete without an account | to sync it and use hosted services ([ADR-0785]) |
| Web app | a folder in memory, seeded from the server ([ADR-0807]) | required |
| Epicenter app | every folder in `~/Epicenter` | its own grant, with `folders:all` |
| CLI | folders by path, or by id on the server | its own OAuth client and credentials file ([ADR-0793]) |

One build serves the web and the desktop; an app branches on what a
capability offers, never on the platform ([ADR-0781], [ADR-0780]). A sign-in
serves one app, whose secrets stay in its own credentials file ([ADR-0783]).

## The Epicenter app and the CLI

The Epicenter app is where a person sees and manages every folder
([ADR-0816]): each folder's title, members, and state; its collections as
tables, filtered by `select * from <collection> where …` and edited by field
type, or its files; sync, sharing, repair; and the views across folders. It
starts at login and keeps every folder in sync while it runs ([ADR-0819]). It
knows an app only as data, the view it publishes and the address that opens
its window, so a new app appears in Open with without a change to Epicenter.
It hosts no app and runs no MCP server; "Connect your agents" adds
`epicenter mcp --all` to an agent's configuration ([ADR-0800]).

The CLI is the same platform without windows: every platform operation is a
package function and a command, the Epicenter app and every app compose the
same functions, and none calls the CLI ([ADR-0817]):

```sh
epicenter init ~/Epicenter/notes                 # a contract from the files there
epicenter sync ~/Epicenter/notes
epicenter share ~/Epicenter/notes jess@example.com
```

`status`, `clone`, `log`, `diff`, `restore`, `unshare`, `accept`, `attach`, and
`detach` are built too; `query`, `set`, `normalize`, and `mcp` are not
([ADR-0790], [ADR-0797]). `epicenter mcp` serves each contract as typed MCP
tools (`<collection>_query`, `_get`, `_set`, `_write`, `_delete`) to an agent,
which reaches every folder because it acts as the person ([ADR-0799]).

## What Epicenter invents, and what it refuses

Epicenter invents three things: names derived from a site ([ADR-0722]), the
front-matter merge by key ([ADR-0795]), and the sync function ([ADR-0804]).
Everything else is a standard ([ADR-0762]).

It refuses:

- a service every app needs to sync ([ADR-0750], [ADR-0819]).
- programs calling each other; they meet in the folder ([ADR-0762],
  [ADR-0817]).
- a second store: no browser storage, no log of operations for sync
  ([ADR-0786], [ADR-0744]).
- Git on a computer, and a sync with any server but Epicenter's ([ADR-0804]).
- renaming a folder's repository, and merging two unrelated histories
  ([ADR-0771], [ADR-0761]).
- a registry of folders, or a group that owns them ([ADR-0811], [ADR-0813]).

[ADR-0722]: adr/0722-an-apps-names-derive-from-its-sites-host.md
[ADR-0744]: adr/0744-sync-diffs-state-because-agents-edit-state.md
[ADR-0750]: adr/0750-sync-is-like-save-any-program-can-sync-a-folder-and-none-owns-it.md
[ADR-0761]: adr/0761-sync-never-merges-two-unrelated-histories.md
[ADR-0762]: adr/0762-epicenter-is-made-of-standards-and-places.md
[ADR-0763]: adr/0763-epicenters-doctrine-is-three-roots-and-one-rule-for-apps.md
[ADR-0771]: adr/0771-plain-files-let-epicenter-refuse-renames-attachment-conflict-copies-and-a-second-store.md
[ADR-0773]: adr/0773-a-folder-opens-at-a-place-every-place-is-a-store-and-the-server-never-merges.md
[ADR-0774]: adr/0774-one-write-makes-it-so-and-settles-a-change-the-way-sync-does.md
[ADR-0775]: adr/0775-a-write-never-fails-the-folder-keeps-it-until-it-lands.md
[ADR-0776]: adr/0776-a-notes-name-is-its-file-name-and-a-rename-is-a-set-and-a-delete.md
[ADR-0779]: adr/0779-a-store-is-four-verbs-and-a-browser-recording-lands-whole.md
[ADR-0780]: adr/0780-a-surface-uses-what-its-platform-gives-and-parity-is-not-a-goal.md
[ADR-0781]: adr/0781-apps-branch-on-what-a-capability-offers-and-one-build-serves-every-surface.md
[ADR-0783]: adr/0783-a-secret-lives-in-the-apps-credentials-file-and-is-read-by-the-request-that-uses-it.md
[ADR-0785]: adr/0785-a-desktop-app-signs-in-to-sync-its-own-folder.md
[ADR-0786]: adr/0786-every-web-app-is-online-and-browser-storage-leaves-the-platform.md
[ADR-0788]: adr/0788-everything-in-a-folder-syncs-and-a-recordings-audio-is-kept-in-one-of-three-places.md
[ADR-0789]: adr/0789-a-conflict-is-a-mark-on-its-note-resolved-in-the-repair-editor.md
[ADR-0790]: adr/0790-the-epicenter-app-is-a-library-over-every-folder-and-the-cli-answers-its-queries.md
[ADR-0793]: adr/0793-programs-only-compose-typescript-holds-what-epicenter-means-and-rust-holds-the-os-git-and-secrets.md
[ADR-0795]: adr/0795-git-merges-a-notes-body-and-epicenter-merges-its-front-matter-by-key.md
[ADR-0796]: adr/0796-a-field-is-a-line-its-value-is-json-and-a-write-patches-only-the-fields-it-changes.md
[ADR-0797]: adr/0797-front-matter-is-a-strict-grammar-and-anything-else-is-body.md
[ADR-0798]: adr/0798-a-store-patches-fields-and-writes-text-and-a-change-is-data.md
[ADR-0799]: adr/0799-a-folders-contract-is-also-an-mcp-server.md
[ADR-0800]: adr/0800-a-stores-wire-speaks-http-conditional-requests-and-apps-connect-agents-to-the-cli.md
[ADR-0802]: adr/0802-people-share-spaces-an-app-works-in-one-at-a-time-and-a-folder-carries-its-contract.md
[ADR-0803]: adr/0803-clients-sync-only-with-epicenter-servers-and-sync-is-a-function-of-two-stores.md
[ADR-0804]: adr/0804-a-computer-keeps-a-plain-folder-and-every-surface-syncs-with-one-typescript-function.md
[ADR-0805]: adr/0805-a-folder-is-recognized-by-epicenter-json-which-is-its-contract.md
[ADR-0806]: adr/0806-an-open-app-checks-for-changes-and-a-sync-never-silently-loses-an-edit.md
[ADR-0807]: adr/0807-an-app-writes-only-to-a-local-store-and-only-sync-talks-to-a-server.md
[ADR-0811]: adr/0811-folders-are-shared-directly-and-an-app-reaches-the-folders-attached-to-it.md
[ADR-0812]: adr/0812-an-apps-schema-is-a-view-that-must-fit-a-folders-contract.md
[ADR-0813]: adr/0813-epicenter-is-your-folders-and-apps-are-lenses.md
[ADR-0814]: adr/0814-one-window-shows-one-folder.md
[ADR-0815]: adr/0815-the-platform-gives-a-window-its-folder-and-every-app-the-same-home.md
[ADR-0816]: adr/0816-the-epicenter-app-is-where-a-person-sees-and-manages-every-folder.md
[ADR-0817]: adr/0817-the-cli-exposes-every-platform-operation-and-an-app-inherits-everything-about-folders.md
[ADR-0818]: adr/0818-an-app-is-a-view-a-window-and-its-capabilities-and-everything-is-repairable-by-hand.md
[ADR-0819]: adr/0819-every-program-keeps-the-folders-it-has-open-in-sync-and-the-epicenter-app-has-them-all-open.md
[ADR-0820]: adr/0820-a-share-is-an-invitation-to-an-email-and-reaching-every-folder-is-a-permission.md
[ADR-0824]: adr/0824-a-folders-history-is-a-log-of-versions-and-git-is-how-it-leaves.md
