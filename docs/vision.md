# Vision

Your life's data is plain files you own, in one place on your computer. Small
apps are lenses on those files, and agents work on them as easily as you do.
Epicenter keeps the files the same on every device and with the people you
share them with, keeps every version, and lets you leave at any moment with
everything, as files and as Git.

This page is the front door: what Epicenter is, the rules it keeps, and where
to read next. It describes the design as decided; parts of it are not built
yet. [ADR-0835] lists every decision in force, the record that made it, and
whether it is built; [architecture](architecture.md) and the package READMEs
say what the code does today and where; [CONTEXT](CONTEXT.md) owns the
vocabulary.

## What a person knows

1. Your folders live in `~/Epicenter`, as plain files.
2. Epicenter keeps them the same on every device, and for everyone you share
   them with: your changes leave the moment you make them, and others' arrive
   within half a minute.
3. Every version is kept, and when two edits to the same paragraph meet, you
   see both.
4. Share any folder with anyone, by email.

Those four sentences are the whole product vocabulary. A person sees four marks
beside a folder or a note: ✓ synced, ◌ waiting, ⚠ a conflict to look at, ✗ a
file the server refused.

## Three places and one change

```txt
   your devices                the server: a ledger              outside
 ┌────────────────┐  a change  ┌────────────────────────┐  out  ┌─────────┐
 │ plain files in │ ─────────▶ │ who may see a folder   │ ────▶ │   Git   │
 │ ~/Epicenter    │ ◀───────── │ every change, in order │ ◀──── │         │
 └────────────────┘            └────────────────────────┘  in   └─────────┘
  where you, apps, and           where web apps write
  agents work
```

A folder lives in three places. **Your devices** are where work happens, in
files. **The server** is a ledger: it puts changes in order, keeps every
version, and knows who may see what. **Git** is the door in and out. One thing
moves between them: **a change**, a set of files each going from the version it
replaced to a new one. Every feature is a change moving between places, a read
of the ledger, or a lens on the files.

## The rules

1. **Files are the artifact.** What you write with is what remains. Everything
   Epicenter knows is in the files, in plain JSON beside them, or in the
   ledger, and all of it can be read and repaired by hand ([ADR-0818]).
2. **The server is a ledger, not a workplace.** Nothing is edited on the
   server; it orders, remembers, and admits ([ADR-0824], [ADR-0830]).
3. **There is one write door.** Every write, from a device, a web app, an
   agent, or Git, is a change that names the version of each file it replaces,
   and a stale write is refused, never applied ([ADR-0824]).
4. **Machines edit fields; people edit prose.** A front-matter field is
   machine-edited, one `key: <JSON>` per line, and merges by key, the change
   ordered later winning. The body is the person's: it merges by paragraph, and
   a conflict stays visible and repairable in the file. Every writer merges the
   same way ([ADR-0795], [ADR-0830],
   [ADR-0836]).
5. **Standards at the edges, the simplest engine inside.** Markdown and JSON
   in the files, Git for history in and out, OAuth, MCP, and HTTP; inside, a
   log of changes ([ADR-0762], [ADR-0824], [ADR-0834]).

A new idea is weighed by three questions: does it keep the truth in plain
files on devices; does it keep the server a ledger; and does it add anything a
person has to hear beyond the four sentences? An idea that fails one earns it
with a concrete need, not elegance.

## A folder is files

```txt
~/Epicenter/
├── Notes/
│   ├── epicenter.json        optional: a title and the folder's collections
│   └── ideas.md              a note: front matter, then body
├── Whispering/               recordings, each beside a note of its transcript
└── Recipes/                  shared with Jess
```

Every real directory in `~/Epicenter` is a folder; a link there is shown as
outside and never synced, so a folder kept elsewhere moves in and a link at its
old path points back ([ADR-0825]). A folder holds only its content: no state of
Epicenter's ([ADR-0822]). A folder that is a Git working tree is Git's, and
Epicenter never syncs it.

`epicenter.json` holds a `title` and `collections`, path patterns such as
`todos/{name}.md` with JSON Schema for their fields ([ADR-0805],
[ADR-0818]). A note's front matter is the machine's and its body the person's:
one `key: <JSON>` per line, which is valid YAML, and anything else is body
([ADR-0796], [ADR-0797]). Prose belongs in the body, never in a field.

```md
---
title: "Call dentist"
done: false
---
Ask about the Thursday slot.
```

## Changes and the ledger

**Sending.** Epicenter, a menu-bar app that starts at login, sends a change the
moment a file changes, and checks for others' changes every thirty seconds
([ADR-0830]). On a computer only Epicenter's programs (the app, the CLI,
`epicenter mcp`) sync with the server; desktop apps read and write files, and
reach the server only for hosted AI ([ADR-0822]). A web app has no disk, so its folder is the folder on the server,
and each save is a change ([ADR-0823]).

**Merging.** A device merges, never the server ([ADR-0773]):

| What | How it merges |
| --- | --- |
| a front-matter field | by key; both changed: the change ordered later wins (in a sync, the computer that syncs second) |
| a note's body | Git's line merge; both changed one paragraph: both versions, marked |
| any other file | the later change; the other stays in history |
| an edit against a delete | the edit |

**Knowing which folder is which.** Epicenter remembers what it synced, beside
the folders in `~/Epicenter/.epicenter/`, and follows a folder the way a Finder
alias does: renamed or moved, it is the same folder; copied, it is a new one.
Anything else asks once; a new computer asks "Reconnect these folders?"
([ADR-0821], [ADR-0832]).

**History.** Every change is kept, with who made it and when: see a file's
versions, the folder as of any moment, restore. History is reached by time: the folder last Tuesday, a note before
someone's edit ([ADR-0824], [ADR-0837]). A restore never deletes on a device ([ADR-0829]). A
folder's recent history lives in the shared database and its past in its own
archive ([ADR-0833]).

## Sharing

A folder is the one thing shared ([ADR-0811]). A share is an invitation to an
email, granting nothing until accepted; members are equal, and a reader only
reads ([ADR-0820]). A shared folder appears in each member's `~/Epicenter` as
plain files. A web app has no disk, so opening a folder in it grants that
window a token for that one folder, and nothing else ([ADR-0837]).

## Apps

An app is a view of what it understands in a folder, a window over one folder,
and its capabilities (a recorder, AI, shortcuts); the platform does everything
about folders ([ADR-0817], [ADR-0818]). Many apps can open one folder, and one
window shows one folder ([ADR-0814]). The Epicenter app is the Finder of
folders: every folder, its members and state, history, sharing, repair, and
"Connect your agents" ([ADR-0816]).

## Agents and the CLI

An agent works the way a person does:

- on the files in `~/Epicenter`, which Epicenter syncs like any edit;
- through `epicenter mcp`, whose tools are the CLI's operations and typed tools
  from each folder's contract ([ADR-0827]);
- through Git: `epicenter export --git` and `import --git` carry history out
  and in, and `epicenter git land` turns a branch into one change
  ([ADR-0826], [ADR-0831]). Every folder will be a Git remote, where a clone
  reads its history and a push lands as a change ([ADR-0834]). Today an agent
  with only Git can take history out and bring a new folder in; landing a
  branch and the Git remote are decided, not built.

## What Epicenter refuses

- Live sessions and keystroke co-editing; a second store of any kind
  ([ADR-0771], [ADR-0830]).
- Git as storage, on a computer or on the server ([ADR-0804], [ADR-0824]).
- Programs calling each other; they meet in files and the ledger ([ADR-0762],
  [ADR-0817]).
- Guessing which folder is which from its name or contents ([ADR-0832]).
- Syncing anything outside `~/Epicenter`, or `~/Epicenter` inside another sync
  service ([ADR-0825]).

[ADR-0762]: adr/0762-epicenter-is-made-of-standards-and-places.md
[ADR-0771]: adr/0771-plain-files-let-epicenter-refuse-renames-attachment-conflict-copies-and-a-second-store.md
[ADR-0773]: adr/0773-a-folder-opens-at-a-place-every-place-is-a-store-and-the-server-never-merges.md
[ADR-0795]: adr/0795-git-merges-a-notes-body-and-epicenter-merges-its-front-matter-by-key.md
[ADR-0796]: adr/0796-a-field-is-a-line-its-value-is-json-and-a-write-patches-only-the-fields-it-changes.md
[ADR-0797]: adr/0797-front-matter-is-a-strict-grammar-and-anything-else-is-body.md
[ADR-0804]: adr/0804-a-computer-keeps-a-plain-folder-and-every-surface-syncs-with-one-typescript-function.md
[ADR-0805]: adr/0805-a-folder-is-recognized-by-epicenter-json-which-is-its-contract.md
[ADR-0811]: adr/0811-folders-are-shared-directly-and-an-app-reaches-the-folders-attached-to-it.md
[ADR-0814]: adr/0814-one-window-shows-one-folder.md
[ADR-0816]: adr/0816-the-epicenter-app-is-where-a-person-sees-and-manages-every-folder.md
[ADR-0817]: adr/0817-the-cli-exposes-every-platform-operation-and-an-app-inherits-everything-about-folders.md
[ADR-0818]: adr/0818-an-app-is-a-view-a-window-and-its-capabilities-and-everything-is-repairable-by-hand.md
[ADR-0820]: adr/0820-a-share-is-an-invitation-to-an-email-and-reaching-every-folder-is-a-permission.md
[ADR-0821]: adr/0821-a-computer-remembers-what-it-synced-and-a-shell-limits-each-window-to-its-folder.md
[ADR-0822]: adr/0822-only-epicenter-syncs-on-a-computer-and-a-folder-holds-only-its-content.md
[ADR-0823]: adr/0823-on-the-web-the-folder-on-the-server-is-the-apps-store.md
[ADR-0824]: adr/0824-a-folders-history-is-a-log-of-versions-and-git-is-how-it-leaves.md
[ADR-0825]: adr/0825-the-epicenter-folder-contains-its-folders.md
[ADR-0826]: adr/0826-history-enters-and-leaves-epicenter-as-git.md
[ADR-0827]: adr/0827-the-cli-and-mcp-render-one-table-of-operations.md
[ADR-0829]: adr/0829-a-restore-never-deletes-on-a-device-and-historys-chain-covers-what-changed-not-who.md
[ADR-0830]: adr/0830-epicenter-sends-a-change-the-moment-it-happens-and-checks-for-others-every-thirty-seconds.md
[ADR-0831]: adr/0831-a-git-branch-lands-in-a-folder-as-one-change-through-the-cli.md
[ADR-0832]: adr/0832-a-folder-is-the-directory-epicenter-last-synced-or-epicenter-asks.md
[ADR-0833]: adr/0833-a-folders-present-lives-in-one-shared-database-and-its-past-in-its-own-archive.md
[ADR-0834]: adr/0834-every-folder-is-also-a-git-remote.md
[ADR-0837]: adr/0837-the-ledger-is-the-persons-model-folders-the-versions-of-their-files-and-who-may-see-them.md
[ADR-0836]: adr/0836-one-merge-a-cursor-that-carries-its-digest-and-one-grant.md
[ADR-0835]: adr/0835-records-from-0802-to-0834-agree-on-files-a-ledger-and-git-at-the-edges.md
