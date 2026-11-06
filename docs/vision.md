# Vision

**Epicenter is your folders, and apps are lenses** ([ADR-0813](adr/0813-epicenter-is-your-folders-and-apps-are-lenses.md)).
A folder in `~/Epicenter` holds your things, syncs, keeps history, and is
shared with people; an app, the library, the command line, or an agent shows
and changes the part of it that it understands.

Where Epicenter is going, on one page. Each section links the records that
decided it; read them for the reasons and the detail. This is direction, not
current truth: most of it is unbuilt, and each record's `Unbuilt` line says
what is missing. Built so far: one build for every surface, the online web,
the account asking for what its capabilities need, and the folder's one write
over stores of four verbs. [Positioning](positioning.md) owns what Epicenter
claims today; [CONTEXT](CONTEXT.md) owns the vocabulary.

Under all of it sit three roots and one rule for apps ([ADR-0763]):

| Root or rule | What it means now |
| --- | --- |
| Your things are files in a place you can see | a folder under `~/Epicenter`, or the app's container on a phone |
| Programs meet in shared places, never by calling each other | the folder, its `.git` and its lock; the model cache |
| Speak the standard; invent only what none covers | Git, OAuth, JSON Schema, HTTP, MCP |
| An app declares what it is and what it needs; the platform supplies where, how and when | `app.ts` composes capabilities; app code names no path, platform, or sync moment |

## A folder is files and one contract

```txt
~/Epicenter/
├── todos/                     your first team's Todos
│   ├── AGENTS.md              names the contract; written once, then yours
│   ├── todos/call-dentist.md  a note: front matter, then body
│   ├── .git/                  the repository, so the team
│   └── .epicenter/            this computer's unfinished writes
└── Family/                    another team: its apps' folders inside
    └── todos/
```

A folder's `AGENTS.md` names its contract, and Epicenter finds folders by
reading it, never by a stored or derived path ([ADR-0772]). A note's name is
its file name, and a rename is a write at the new name and a delete of the
old ([ADR-0776]). Everything in a folder syncs ([ADR-0788]).

A note's front matter is the machine's; its body is the person's and the
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
person asks or a write touches the note, never on a read. Epicenter reads
nothing in a body but conflict markers.

## Merging

| What | How it merges |
| --- | --- |
| a note's body | Git's three-way line merge; a clash leaves Git's markers |
| a note's front matter | by key: a key one side changed takes that side; a key both changed takes the later write |
| any other file | the later write; the other stays in history |
| an edit against a delete | the edit |

Epicenter's own merge is the key rule, about forty lines in TypeScript and in
Rust under one fixture, and a round runs it with no page and no JavaScript
([ADR-0795]). A note holding Git's markers shows ⚠ and is resolved in the
repair editor ([ADR-0789]).

A sync round checks out only the files that did not move while it ran. A
file that moved ends the round `retry`, and the next round commits and
merges it ([ADR-0794]). The server never merges: it refuses a write over a
version it no longer holds ([ADR-0773]).

## Changes

A store is a place: memory, a directory, the desktop shell's root, or the
server's repository. Every store has five verbs ([ADR-0779], [ADR-0798]):

```ts
list(under)    read(paths)    watch(changed)
write(path, bytes | null, over)  // text, deletes, attachments: lands only over the version read
patch(path, { set, delete })     // fields: applied to the file as it is, never stale
```

A change is JSON discriminated by `op`, the same on every transport, in every
queue, and in the conformance suite ([ADR-0798]). Over HTTP the verbs are
conditional requests: `GET` with an `ETag`, `PUT` with `If-Match` or
`If-None-Match: *`, `DELETE`, `412 Precondition Failed` for a stale write, and
`PATCH` for fields ([ADR-0800]). An app writes with `set` and `delete`, and a
write never fails: the folder keeps it, in order, until it lands
([ADR-0774], [ADR-0775]).

## Programs only compose

A program holds no logic of its own. Each piece lives in one package, in the
language every program that needs it can run ([ADR-0793]):

| TypeScript: what Epicenter means | Rust: the OS, Git, and secrets |
| --- | --- |
| contracts, validation, notes, the folder engine, query tables, discovery by `AGENTS.md`, Normalize | a round's Git work, files and watching, credentials files, audio, local models, shortcuts |

The front-matter primitive (read, patch, and merge a field) is the one piece
written in both, under one fixture. Every program composes the same
packages and differs only in its hands: an app's page, the library, the CLI,
and the server, which holds the repository and never merges.

## Surfaces

| Surface | What it opens | Signing in |
| --- | --- | --- |
| Desktop app | its own folder, complete without an account | to sync that folder and to use hosted services ([ADR-0785]) |
| Web app | the team's repository, online only ([ADR-0786]) | required |
| Library (the Epicenter app) | every folder under `~/Epicenter`, by team | its own grant, reaching each team repository it syncs |
| CLI | the folder it runs in, folders by path, or `--all` | its own OAuth client and credentials file ([ADR-0793]) |

- One build serves the web and the desktop. An app branches on what a
  capability offers, never on the platform ([ADR-0781]), and the surfaces
  need not promise the same things ([ADR-0780]).
- A team owns repositories, and sharing is membership. Consent picks the
  team, and a folder's first sync moves it into that team's folder
  ([ADR-0770], [ADR-0791]).
- An account asks for what the capabilities handed it need; an app that hands
  the account to nothing never shows sign-in ([ADR-0792]).
- A sign-in serves one app, whose secrets stay in its own credentials file
  and never reach the page ([ADR-0783]).

## The library and the CLI

The Epicenter app is the library, an app built like the others over every
folder ([ADR-0790]). Each collection is a table filtered by
`select * from <collection> where …`, and each cell is drawn and edited by
its field's type. Beside the tables it gathers what needs a look: sync state,
conflicts (⚠), notes that do not read, and duplicate folders. It syncs every
folder, offers Sync all, and builds its tables in its own page.

The CLI is its own install, for agents and terminals ([ADR-0793]):

```sh
epicenter query "select * from todos where done = false"
epicenter set todos todos call-dentist --json '{"done": true}'
epicenter normalize
epicenter mcp --all
```

`epicenter mcp` serves each contract as typed MCP tools (`<collection>_query`,
`_get`, `_set`, `_write`, `_delete`), derived with no app code
([ADR-0799]). Apps and the library offer "Connect your agents": one click
installs the command and adds `epicenter mcp --all` to the agent's MCP
configuration ([ADR-0800]).

## What Epicenter invents, and what it refuses

Epicenter invents three things: names derived from a site ([ADR-0722]), the
front-matter merge by key ([ADR-0795]), and the sync core ([ADR-0751]).
Everything else is a standard ([ADR-0762]).

It refuses:

- a background service, file watcher, or timer, to sync or to serve agents;
  each program syncs at a person's moments ([ADR-0750], [ADR-0800]).
- programs calling each other; they meet in the folder ([ADR-0762]). The one
  named exception is a browser extension, which cannot reach a folder
  ([ADR-0745]).
- a second store: no live documents, no browser storage, and no log of
  operations for sync ([ADR-0771], [ADR-0786], [ADR-0744]).
- renaming or moving a repository, and merging two unrelated histories
  ([ADR-0771], [ADR-0761]).
- a registry of folders or a stored location ([ADR-0772]).

## Open: is a local Git repository a promise?

Positioning promises "Git history beside it" and sync "over plain Git with a
server you choose". [ADR-0794] holds both open until two results are in: an
iOS spike shows whether a round must finish while the app is suspended, and
a store-to-store prototype in TypeScript syncs a folder with the repository
through the stores the folder already has, timed on an unchanged round of
10,000 items. The founder decides against both before the core is linked
into every app. Since [ADR-0795] a round merges by itself, so an embedded
JavaScript engine is no longer part of the question.

[ADR-0722]: adr/0722-an-apps-names-derive-from-its-sites-host.md
[ADR-0744]: adr/0744-sync-diffs-state-because-agents-edit-state.md
[ADR-0745]: adr/0745-a-browser-extension-writes-through-the-local-epicenter-engine.md
[ADR-0750]: adr/0750-sync-is-like-save-any-program-can-sync-a-folder-and-none-owns-it.md
[ADR-0751]: adr/0751-every-native-app-carries-one-sync-core.md
[ADR-0761]: adr/0761-sync-never-merges-two-unrelated-histories.md
[ADR-0762]: adr/0762-epicenter-is-made-of-standards-and-places.md
[ADR-0763]: adr/0763-epicenters-doctrine-is-three-roots-and-one-rule-for-apps.md
[ADR-0770]: adr/0770-teams-own-repositories-and-sharing-is-membership.md
[ADR-0771]: adr/0771-plain-files-let-epicenter-refuse-renames-attachment-conflict-copies-and-a-second-store.md
[ADR-0772]: adr/0772-a-folder-says-what-it-is-in-agents-md-and-this-computer-keeps-the-rest.md
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
[ADR-0791]: adr/0791-a-folders-first-sync-places-it-in-its-teams-folder.md
[ADR-0792]: adr/0792-an-account-asks-for-what-the-capabilities-that-take-it-need.md
[ADR-0793]: adr/0793-programs-only-compose-typescript-holds-what-epicenter-means-and-rust-holds-the-os-git-and-secrets.md
[ADR-0794]: adr/0794-a-sync-round-asks-its-host-to-settle-checks-out-only-what-did-not-move-and-retries-rather-than-guess.md
[ADR-0795]: adr/0795-git-merges-a-notes-body-and-epicenter-merges-its-front-matter-by-key.md
[ADR-0796]: adr/0796-a-field-is-a-line-its-value-is-json-and-a-write-patches-only-the-fields-it-changes.md
[ADR-0797]: adr/0797-front-matter-is-a-strict-grammar-and-anything-else-is-body.md
[ADR-0798]: adr/0798-a-store-patches-fields-and-writes-text-and-a-change-is-data.md
[ADR-0799]: adr/0799-a-folders-contract-is-also-an-mcp-server.md
[ADR-0800]: adr/0800-a-stores-wire-speaks-http-conditional-requests-and-apps-connect-agents-to-the-cli.md
