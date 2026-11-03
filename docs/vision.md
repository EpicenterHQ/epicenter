# Vision

Epicenter gives apps two ways to keep your data: files you own on disk, and
documents synced through your account. Both speak one field language and one
export format, so you can browse, back up, move, and compact all of it from
one place.

This page describes where Epicenter is going and links the records that decide
each part. Most of it is not built yet; each record's `Unbuilt` line says what
is missing. [Positioning](positioning.md) owns what Epicenter claims today.

## Two stores

An app's data lives in two kinds of store: folders and documents. An app
opens the stores it needs; most open exactly one, usually a folder, and some
may open a folder and a few documents. The two kinds have different
strengths, and no data lives in both.

| | Folder | Document |
| --- | --- | --- |
| Working form | Markdown notes and attached files on disk | A Yjs document synced through your account |
| History and sync | Git, through the Epicenter engine | Your Epicenter or self-hosted Epicenter server |
| Size | Large: thousands of notes, gigabytes of audio | Small: hundreds of items |
| Agents | Edit the files directly | `epicenter get` and `epicenter set` |
| Co-editing | No | Yes |
| Offline | Always | A local copy on each device |
| Example | Whispering | Tabs |

What both stores share:

- **One field vocabulary.** Proposed field builders (`text`, `select`, `multiSelect`,
  `date`, `url`, `ref`, `body`) compile to JSON Schema for files, a Yjs shape
  for documents, SQL columns for queries, and UI controls for generic views.
  Contracts differ per store; the fields do not.
- **One export format.** Every store exports to Markdown notes with their
  attached files, and imports from them. A folder's working form is already
  that format. Moving an app from one store to the other is an export followed
  by an import, never two live stores at once.

Records: [ADR-0705](adr/0705-an-apps-data-lives-in-two-kinds-of-store.md) (two stores), [ADR-0707](adr/0707-an-app-that-needs-co-editing-is-a-document-app.md) (co-editing apps are document apps),
[ADR-0709](adr/0709-a-document-is-rebuilt-into-a-fresh-generation-by-copying-its-current-state.md) (rebuilding a document), [ADR-0716](adr/0716-agents-edit-a-document-through-one-shot-cli-commands.md) (agents edit documents through the
CLI).

## On a computer

```txt
~/Epicenter/                       the library root; a plain folder, not a repository
  Whispering/                      one repository per folder, labeled by the contract's title
    AGENTS.md                      contract: https://whispering.epicenter.so/contract.json
    settings.md                    settings that follow you
    shortcuts.md                   shortcuts that follow you
    recordings/<id>.md             one note per thing, named by its ID
    recordings/<id>.wav            attached files sit beside their note (Git LFS)
  Vocab/  Mail/  The Ark/ …

<AppData>/so.epicenter.whispering/ this device: never synced
  settings.md                      this device's overrides and the `folder` key
  shortcuts.md                     this device's shortcut overrides
  index.sqlite                     derived data, rebuilt from the folder

~/.agents/skills/                  your agent skills
Keychain                           secrets
~/.gitconfig                       epicenter.folder: the folders this machine syncs
```

- An app has two names: its contract `name` (slug) for machines and its
  contract `title` for people ([ADR-0710](adr/0710-a-contracts-title-names-everything-a-person-reads.md)).
- A folder's `AGENTS.md` names its contract and tells agents what the folder
  is ([ADR-0711](adr/0711-a-folder-names-its-apps-contract-in-a-committed-agents-md-note.md)).
- A relative `folder` resolves against the library root and an absolute one is
  used as written. An app remembers its folder after the first open, and asks
  before writing into a folder it does not recognize ([ADR-0712](adr/0712-an-apps-folder-path-resolves-against-one-movable-library-root.md)).
- Settings and shortcuts follow you. Each is a note in the folder, with an
  optional note of the same name in AppData that overrides it on this device;
  a reader spreads defaults, then the folder's note, then the device's.
- A database is only ever a cache. An app that wants SQLite builds it in
  AppData from the folder's files.

## On the server

Repositories and documents are two kinds of resource in one namespace, shared
through one kind of grant ([ADR-0708](adr/0708-a-namespace-holds-documents-beside-repositories-under-one-resource-grant.md)). The data stays portable: a folder syncs
with any Git host, with some manual setup for hosts other than Epicenter. What
the account adds:

- the list of your repositories and documents on every device
- online web variants of folder apps
- documents and their sync
- sharing
- hosted inference
- LFS storage

## Who does what

| Piece | Job |
| --- | --- |
| An app | Reads and writes its store. A folder app needs neither Epicenter nor an account to work; a document app syncs through an account. |
| The `epicenter` engine | Git, LFS, merge, `check`, `get` and `set`. One copy per machine, installed by the Epicenter app with `git-lfs` ([ADR-0713](adr/0713-one-epicenter-engine-per-machine-syncs-every-apps-folder.md)). |
| The Epicenter app | Installs the engine, asks consent for a first sync, syncs on a schedule, and browses every folder and document you have ([ADR-0715](adr/0715-the-epicenter-app-browses-every-folder-and-document-a-person-has.md)). |
| Your account | Resources, grants, documents, inference. |

Every folder merges by one rule: `.md` notes merge fields and body, other text
files merge by line, and everything else goes to Git LFS ([ADR-0714](adr/0714-a-files-extension-decides-how-every-folder-merges-it.md)).

## In a browser

A browser variant runs the same code as the desktop variant with weaker
guarantees: its files are not visible, agents and tools cannot read them, a
local web variant has no history or sync, and the browser can delete them
([ADR-0706](adr/0706-a-browser-variant-runs-the-desktop-code-with-weaker-guarantees.md)). Whispering keeps a local web variant that works without signing in.
Signing in there unlocks hosted transcription, as on the desktop; its
recordings stay in the browser.

## Apps and their stores

| Store | Apps |
| --- | --- |
| Folder | Whispering, Bureaucracy, Capture, Vocab, Zhongwen, Mail, Photos, Messages, Invest, Ancestry, Geopolitics, Honeycrisp, Notes, Opensidian, The Ark |
| Document | Tabs |
| Folder for now, still open | Tasks, Timebox |
| Neither | Decox (the Codex manager) |

- **Photos:** Google Photos holds the photos. A SQLite cache in AppData mirrors
  what Google Photos has. The folder holds your annotations, one per photo.
- **Mail:** each account's mail is a cache in AppData, and its secrets live in
  the keychain. The folder holds your saved queries and batches of changes.
- **Messages:** Beeper holds the conversations. The folder holds replies, and
  each send is journaled on the device (ADR-0704). There is no browser variant.
- **Tabs:** the extension reads open tabs from the browser. Saving a tab closes
  it and keeps it in the Tabs document.

## What Epicenter refuses

- A live editing session over a folder's files. An app that needs co-editing
  is a document app.
- A document as the store for large data.
- One repository for the whole library root.
- Two live stores for the same data.

## Open questions

- Whether Tasks and Timebox stay folders.
- The size above which a text file goes to LFS.
- How app actions and plugins run, when synced batches apply, and how a
  person's own versions of actions survive an app update.
- End-to-end encryption for documents.

## Later

- Document sync. Documents have no size cap. The sync service may reuse parts
  of the Yjs sync removed in `9f75a9bd51`, such as its update protocol and
  authentication; its store, generations ledger, and one-document-per-database
  design do not return.
- Embeddings. Nothing stores them yet; whether they sync or are recomputed on
  each device is decided when an app needs them.
- `epicenter checkout` and `epicenter apply`, so agents can edit a document as
  files and apply the changes back.
