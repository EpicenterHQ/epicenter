# Vision

Epicenter gives apps two ways to keep your data: files you own on disk, and
documents synced through your account. Both speak one field language and one
export format, so you can browse, back up, move, and compact all of it from
one place.

**Everything you own is in `~/Epicenter`.** Each app keeps its folder there,
named from the app's address. A folder that lives somewhere else is a link
inside it.

**Everything a machine shares is in `~/.epicenter`.** The sync engine, the
sign-in, local copies of documents, and logs. Secrets stay in the keychain.

**You sign in a machine, not an app.** One account per machine. Every
Epicenter program on it shares that sign-in.

This page describes where Epicenter is going and links the records that decide
each part. Most of it is not built yet; each record's `Unbuilt` line says what
is missing. [Positioning](positioning.md) owns what Epicenter claims today.

## Principles

Every change to the data model is checked against eight principles
([ADR-0719](adr/0719-every-change-to-the-data-model-is-checked-against-eight-principles.md)):

1. Your records are files or documents. A database is only ever a cache.
2. One field language, one export format.
3. An app's site is its identity, every name derives from its host, and the
   environment picks the roots.
4. Each app has two places on a machine with the same note names: its synced
   folder and this device's AppData. Epicenter's machinery is a third place,
   `~/.epicenter`.
5. Find things by convention; store only the exceptions.
6. Apps work alone. Epicenter and the account add capabilities and never take
   custody of your data.
7. One engine and one merge rule wherever Git runs. Conflicts stay visible.
8. Where a guarantee is weaker, the screen says so.

## Identity and names

An app is a site that publishes `/contract.json`, and optionally `/SKILL.md`
for agents ([ADR-0723](adr/0723-an-apps-site-is-found-by-convention.md)). The
site's address is the app's identity, and every name a program uses derives
from its host ([ADR-0722](adr/0722-an-apps-names-derive-from-its-sites-host.md)):

| | Epicenter's app | Anyone else's app |
| --- | --- | --- |
| Site | `https://whispering.epicenter.so` | `https://zhongwen.bradenwong.com` |
| Folder | `~/Epicenter/whispering` | `~/Epicenter/bradenwong.com/zhongwen` |
| Repository | `<account>/whispering` | `<account>/zhongwen.bradenwong.com` |
| This device's place | `<AppData>/so.epicenter.whispering` | `<AppData>/com.bradenwong.zhongwen` |

At the top of `~/Epicenter`, a name without a dot is one of Epicenter's apps,
and a name with a dot is an owner's folder holding that owner's apps. This is
the layout Go uses: the standard library is short, and everything else is
named by its domain.

Development builds use the same names under `~/Epicenter Dev` and
`~/.epicenter-dev`, with `.dev` on the AppData name. Every program computes
every path from the site's address and the environment, so no program stores a
location or needs a registry. People see the app's own name, "Whispering", in
its window and menus.

## Two stores

An app's data lives in two kinds of store: folders and documents. An app opens
the stores it needs; most open exactly one, usually a folder, and some may open
a folder and a few documents. No data lives in both.

| | Folder | Document |
| --- | --- | --- |
| Working form | Markdown notes and attached files on disk | A Yjs document synced through your account |
| History and sync | Git, through the Epicenter engine | Your Epicenter or self-hosted Epicenter server |
| Size | Large: thousands of notes, gigabytes of audio | No cap (Tabs: hundreds of items) |
| Agents | Edit the files directly | `epicenter get` and `epicenter set` |
| Co-editing | No | Yes |
| Offline | Always | A local copy on each device |
| Example | Whispering | Tabs |

What both stores share:

- **One field language: JSON Schema.** A contract's fields are a written
  subset of JSON Schema, and each reader interprets it directly: `epicenter
  check` validates it, Epicenter's generic views pick a control per type
  (`enum` is a dropdown), `epicenter query` picks a column per type, and a
  document app stores each field as a key
  ([ADR-0727](adr/0727-json-schema-is-the-field-language.md)). Helpers such as
  `instant()` are optional shorthand that return JSON Schema. Contracts differ
  per store; the fields do not.
- **One export format.** Every store exports to Markdown notes with their
  attached files, and imports from them. A folder's working form is already
  that format. Moving data between stores is an export followed by an import,
  never two live stores at once.

Records: [ADR-0705](adr/0705-an-apps-data-lives-in-two-kinds-of-store.md)
(two stores), [ADR-0707](adr/0707-an-app-that-needs-co-editing-is-a-document-app.md)
(co-editing apps are document apps),
[ADR-0709](adr/0709-a-document-is-rebuilt-into-a-fresh-generation-by-copying-its-current-state.md)
(rebuilding a document),
[ADR-0716](adr/0716-agents-edit-a-document-through-one-shot-cli-commands.md)
(agents edit documents through the CLI).

## On a computer

Three places, each with one job:

```txt
~/Epicenter/                       your data: visible, synced per folder, not a repository
  whispering/                      one repository per app folder
    AGENTS.md                      contract: https://whispering.epicenter.so/contract.json
    settings.md                    settings that follow you
    shortcuts.md                   shortcuts that follow you
    recordings/<id>.md             one note per thing, named by its ID
    recordings/<id>.wav            attached files sit beside their note (Git LFS)
  vocab/  capture/  …              Epicenter's apps: names without a dot
  bradenwong.com/                  an owner's folder: a name with a dot
    zhongwen/                      that owner's apps
  Obsidian Vault -> ~/Documents/Vault   your own folder: a name no app can have (it has a space)

~/.epicenter/                      Epicenter's machinery: hidden, never synced, read by every program
  session.lock                     held while refreshing the sign-in
  bin/epicenter                    the engine
  bin/git-lfs                      bundled with it
  documents/<namespace>/tabs/      the one local copy of each document
  logs/                            sync logs

<AppData>/so.epicenter.whispering/ this device, for one app: never synced
  settings.md                      this device's overrides
  shortcuts.md                     this device's shortcut overrides
  index.sqlite                     derived data, rebuilt from the folder
```

- **Settings and shortcuts follow you.** Each is a note in the folder; an
  optional note of the same name in AppData overrides it on this device. A
  reader spreads defaults, then the folder's note, then the device's.
- **An app's path is its claim**
  ([ADR-0721](adr/0721-an-apps-folder-is-derived-never-stored.md),
  [ADR-0726](adr/0726-an-apps-path-is-its-claim.md)). No program stores where
  a folder is. `~/Epicenter/whispering` belongs to Whispering: it opens that
  path, creates the folder when nothing is there, and reads and writes only
  its contract's paths. Onboarding shows it ("Your recordings are files in
  `~/Epicenter/whispering`"). A failure, such as a link to an unplugged
  drive, is shown plainly with [Retry] and [Show in Finder].
- **An app reaches named roots, never paths**
  ([ADR-0725](adr/0725-an-app-reaches-named-roots-through-one-command-per-storage-operation.md)).
  Its page asks the shell to list, read, put, and watch files by root and
  relative path. A link at or above a root is followed when it opens; a link
  inside a root is refused
  ([ADR-0729](adr/0729-a-link-is-followed-only-at-or-above-a-root.md)).
- **Links do the moving.** `epicenter move whispering /Volumes/Archive` moves
  the folder and leaves a link at `~/Epicenter/whispering`; Epicenter's
  "Move…" runs the same command. Apps never move or choose a location.
- **A folder's `AGENTS.md`** names its contract and tells agents what the
  folder is ([ADR-0711](adr/0711-a-folder-names-its-apps-contract-in-a-committed-agents-md-note.md)).
- **`~/.epicenter`** holds what every program on this machine shares
  ([ADR-0718](adr/0718-epicenters-machinery-on-a-machine-lives-in-a-hidden-home-every-program-reads.md)).
  Who this machine is signed in as lives with the sign-in in the keychain.
- **One sign-in per machine.** Whichever Epicenter program you sign in from,
  every first-party program on the machine is signed in; signing out anywhere
  signs the machine out. Work and personal folders are namespaces under one
  account. Third-party apps get their own grant
  ([ADR-0720](adr/0720-you-sign-in-a-machine-not-an-app.md)).

## On the server

Repositories and documents are two kinds of resource in one namespace, shared
through one kind of grant
([ADR-0708](adr/0708-a-namespace-holds-documents-beside-repositories-under-one-resource-grant.md)).
A folder syncs with any Git host, with some manual setup for hosts other than
Epicenter. What the account adds:

- the list of your repositories and documents on every device
- online web variants of folder apps
- documents and their sync
- sharing
- hosted inference
- LFS storage

## Who does what

| Piece | Job |
| --- | --- |
| An app | Reads and writes its stores. A folder app needs no account and no Epicenter to save locally; syncing goes through Epicenter's engine. A document app works locally and syncs once you sign in. |
| The app's site | Publishes `/contract.json`, and optionally `/SKILL.md` ([ADR-0723](adr/0723-an-apps-site-is-found-by-convention.md)). "Get the app" opens the site. |
| The `epicenter` engine | Git, LFS, merge, `check`, `move`, `get`, and `set`. One copy per machine in `~/.epicenter/bin`, installed by the Epicenter app ([ADR-0713](adr/0713-one-epicenter-engine-per-machine-syncs-every-apps-folder.md)). |
| The Epicenter app | Installs the engine, asks consent for a first sync, syncs on a schedule, and browses every folder and document you have ([ADR-0715](adr/0715-the-epicenter-app-browses-every-folder-and-document-a-person-has.md)). |
| Your account | Resources, grants, documents, inference. Signed in once per machine. |

Every folder merges by one rule: `.md` notes merge fields and body, a file
with a binary extension goes to Git LFS, and every other file merges as text
by line ([ADR-0714](adr/0714-a-files-extension-decides-how-every-folder-merges-it.md)).

## In a browser

A browser variant runs the same code as the desktop variant with weaker
guarantees: its files are not visible, agents and tools cannot read them, a
local web variant has no history or sync, and the browser can delete them
([ADR-0706](adr/0706-a-browser-variant-runs-the-desktop-code-with-weaker-guarantees.md)).
Whispering keeps a local web variant that works without signing in. Signing in
there unlocks hosted transcription, as on the desktop; its recordings stay in
the browser.

## Apps and their stores

| Store | Apps |
| --- | --- |
| Folder | Whispering, Bureaucracy, Capture, Vocab, Zhongwen, Mail, Photos, Messages, Invest, Ancestry, Geopolitics, Honeycrisp, Notes, Opensidian, The Ark |
| Document | Tabs |
| Folder for now, still open | Tasks, Timebox |
| Neither | Decox (the Codex manager) |

- **Tabs** is the first document app: a browser extension built with WXT,
  Chrome first and Firefox later
  ([ADR-0724](adr/0724-a-browser-extension-keeps-its-data-in-a-document.md)).
  It lists your open tabs from the browser. Saving a tab closes it and keeps
  its URL, title, and save time in the Tabs document. Saving works signed out;
  signing in connects that local document to your account and syncs it at
  once.
- **Zhongwen** is your app at `zhongwen.bradenwong.com`, not one of
  Epicenter's, so its folder is `~/Epicenter/bradenwong.com/zhongwen`.
- **Photos:** Google Photos holds the photos. A SQLite cache in AppData mirrors
  what Google Photos has. The folder holds your annotations, one per photo.
- **Mail:** each account's mail is a cache in AppData, and its secrets live in
  the keychain. The folder holds your saved queries and batches of changes.
- **Messages:** Beeper holds the conversations. The folder holds replies, and
  each send is journaled on the device (ADR-0704). There is no browser variant.
- **Epicenter** gets a synced folder, `~/Epicenter/epicenter`, only when it has
  something worth syncing.

## Planned

Agreed direction, built after the folder work:

- **Restore from your account.** On a second Mac, Epicenter offers "Restore
  Whispering": it clones the repository to the app's path, or joins a folder
  already there.
- **Export all my data.** One archive of every folder and document Epicenter
  can reach, following links and including attached files, with a list of
  browser-only data it cannot reach.
- **Git ships with the engine.** `~/.epicenter/bin` holds `git` and `git-lfs`
  beside `epicenter`, so a first sync never asks for Apple's developer tools.
- **Sync runs under a login agent,** so quitting the Epicenter app does not
  stop sync.
- **Machine sign-in is tested before it is built.** A short experiment checks
  whether separately signed apps can share one keychain item without macOS
  prompting; if not, the engine is the only reader and apps ask it for
  tokens ([ADR-0720](adr/0720-you-sign-in-a-machine-not-an-app.md)).
- **Your own folders take names no app can have,** such as one with a space
  (`Obsidian Vault`): names without a dot belong to Epicenter's apps, and
  names with a dot to owners.

## What Epicenter refuses

- A live editing session over a folder's files. An app that needs co-editing
  is a document app.
- One repository for the whole library root.
- Two live stores for the same data.
- A registry of apps or folders, or a stored location for any folder. An app
  joins by publishing a contract; a folder is where its app's address says.
- Machine state in your Git configuration or in a synced folder.
- A sign-in per app.

## Open questions

- Which of your apps live at `epicenter.so` and which at your own domain.
- Whether Tasks and Timebox stay folders.
- The binary extensions that go to Git LFS, and the size above which the
  server refuses a file outside LFS.
- How app actions and plugins run, when synced batches apply, and how a
  person's own versions of actions survive an app update.
- End-to-end encryption for documents.

## Later

- Document sync. The sync service may reuse parts of the Yjs sync removed in
  `9f75a9bd51`, such as its update protocol and authentication; its store,
  generations ledger, and one-document-per-database design do not return.
- Embeddings. Nothing stores them yet; whether they sync or are recomputed on
  each device is decided when an app needs them.
- `epicenter checkout` and `epicenter apply`, so agents can edit a document as
  files and apply the changes back.
- `epicenter install <url>`. Apps install through Homebrew, app stores, or
  their own site until then.
