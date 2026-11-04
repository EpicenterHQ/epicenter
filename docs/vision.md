# Vision

Epicenter keeps what you keep as items: Markdown files in collections, in
folders you own on disk. Live state, such as a whiteboard several people draw
on at once, belongs in a document synced through your account; no app has
live state yet. Both speak one field language and one export format, so you
can browse, back up, and move all of it from one place.

**Everything you own is in `~/Epicenter`.** Each app keeps its folder there,
named from the app's address. A folder that lives somewhere else is a link
inside it.

**Everything a machine shares is in `~/.epicenter`.** A link to the sync
engine, local copies of documents, and logs.

**Each app signs in as its site.** The account asks once per app and
remembers; a machine groups those sign-ins.

**Your own `git` in an Epicenter folder is plain Git.** Epicenter writes no
paths into your Git configuration.

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
5. Derive from the site; store only data, decisions, proofs, exceptions, and
   caches ([ADR-0730](adr/0730-everything-not-derived-from-an-apps-site-is-one-of-five-stored-kinds.md)).
6. Apps work alone. Epicenter and the account add capabilities and never take
   custody of your data.
7. One engine and one merge rule wherever Git runs. Conflicts stay visible.
8. Epicenter reconciles what it made; anywhere else, the screen says what it
   found and the command that fixes it
   ([ADR-0741](adr/0741-epicenter-reconciles-only-states-it-made.md)).

Behind several of these is one rule: Epicenter draws its boundaries where
people already expect them, and the screen says each limit in their words
([ADR-0749](adr/0749-epicenter-draws-its-boundaries-where-people-already-expect-them.md)).
A website needs the internet and an installed app works offline; your files
are in a folder you can see; an app asks once to use your account; an
extension pairs with its desktop app; quitting an app stops what it does; a
copy of a folder is a copy of your data.

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

**Items are what you keep; documents are what's live**
([ADR-0742](adr/0742-items-are-what-you-keep-documents-are-whats-live.md)).
A collection holds items, and an item is one Markdown file: fields in front
matter, then a body. A document holds live state whose value is being
current: a shared whiteboard, a text two people draft at once, who is looking
at what. The test is whether you would want it in your history a year from
now. If yes, it is an item.

| | Collections of items | Document |
| --- | --- | --- |
| Holds | what you keep | live state |
| Working form | Markdown files and attached files in a folder on disk | A Yjs document synced through your account |
| History and sync | Git, through the Epicenter engine | Your Epicenter or self-hosted Epicenter server |
| Size | Large: thousands of items, gigabytes of audio | No cap |
| Agents | Edit the files directly | `epicenter get` and `epicenter set` |
| Co-editing | No | Yes |
| Offline | Always | A local copy on each device |
| Example | Whispering's recordings, Tabs's saved tabs | none yet |

No app has live state today, so the document store is decided and unbuilt
until the first app that does. No data lives in both.

What both stores share:

- **One field language: JSON Schema.** A contract's fields are a written
  subset of JSON Schema, and each reader interprets it directly: `epicenter
  check` validates it, Epicenter's generic views pick a control per type
  (`enum` is a dropdown), `epicenter query` picks a column per type, and a
  document app stores each field as a key
  ([ADR-0727](adr/0727-json-schema-is-the-field-language.md)). Helpers such as
  `instant()` are optional shorthand that return JSON Schema. Contracts differ
  per store; the fields do not.
- **One export format.** Every store exports to Markdown items with their
  attached files, and imports from them. A folder's working form is already
  that format. Moving data between stores is an export followed by an import,
  never two live stores at once.

A document item is a Yjs map of `fields` and `body`, and a collection's body
uses one of three standard codecs: none, Markdown, or rich text
([ADR-0739](adr/0739-a-document-body-uses-a-standard-codec-until-an-app-needs-its-own.md)).
An app gets a codec of its own only when these cannot hold its body.

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
    recordings/<id>.md             one item per thing, named by its ID
    recordings/<id>.wav            attached files sit beside their item (Git LFS)
  tabs/                            Tabs: saved tabs as tabs/<id>.md
  vocab/  capture/  …              Epicenter's apps: names without a dot
  bradenwong.com/                  an owner's folder: a name with a dot
    zhongwen/                      that owner's apps
  Obsidian Vault -> ~/Documents/Vault   your own folder: a name no app can have (it has a space)

~/.epicenter/                      Epicenter's machinery: hidden, never synced, read by every program
  bin/epicenter                    the engine: a link into the Epicenter app's CLI
  documents/<namespace>/<name>/    the one local copy of each document, once an app has live state
  logs/                            sync logs

<AppData>/so.epicenter.whispering/ this device, for one app: never synced
  settings.md                      this device's overrides
  shortcuts.md                     this device's shortcut overrides
  index.sqlite                     derived data, rebuilt from the folder
  requests/<id>.md                 actions a script or agent asked of this app on this device
  (credentials)                    this app's refresh token and your provider API keys, a file only you can read
```

- **Settings and shortcuts follow you.** Each is a note in the folder; an
  optional note of the same name in AppData overrides it on this device. A
  reader spreads defaults, then the folder's note, then the device's.
- **An app's path is its claim**
  ([ADR-0721](adr/0721-an-apps-folder-is-derived-never-stored.md),
  [ADR-0726](adr/0726-an-apps-path-is-its-claim.md)). No program stores where
  a folder is. `~/Epicenter/whispering` belongs to Whispering: it opens that
  path, creates the folder when nothing is there, and reads and writes only
  its contract's paths. The header's folder status shows the path and says
  the recordings are files there; it offers Show in Finder on macOS and Show
  folder elsewhere. A failed open, such as a link to an unplugged drive,
  shows the error with Retry and the same file-manager action.
- **An app reaches named roots, never paths**
  ([ADR-0725](adr/0725-an-app-reaches-named-roots-through-one-command-per-storage-operation.md)).
  Its page asks the shell to list, read, put, and watch files by root and
  relative path. A link at or above a root is followed when it opens; a link
  inside a root is refused
  ([ADR-0729](adr/0729-a-link-is-followed-only-at-or-above-a-root.md)).
- **Links do the moving.** `epicenter move whispering /Volumes/Archive` moves
  the folder and leaves a link at `~/Epicenter/whispering`; Epicenter's
  "Move…" runs the same command. Apps never move or choose a location.
- **Your own folders join through a link you name**
  ([ADR-0736](adr/0736-a-folder-outside-the-library-is-enrolled-through-a-link-the-person-names.md)).
  "Add folder…" puts a link at `~/Epicenter/<name>`. Epicenter suggests the
  name and you confirm it. It always has a space (`Obsidian Vault`), because
  names without a dot belong to Epicenter's apps and names with a dot to
  owners.
- **A folder's `AGENTS.md`** names its contract and tells agents what the
  folder is ([ADR-0711](adr/0711-a-folder-names-its-apps-contract-in-a-committed-agents-md-note.md)).
- **`~/.epicenter`** holds what every program on this machine shares
  ([ADR-0718](adr/0718-epicenters-machinery-on-a-machine-lives-in-a-hidden-home-every-program-reads.md)).
- **Each app signs in as its site** ([ADR-0731](adr/0731-every-app-signs-in-as-its-site.md)). The account's own page asks
  once per app, on the web and the desktop alike, and the server remembers the
  grant. The consent screen preselects the repository named from the app's
  site, and you can choose another, such as one shared with you
  ([ADR-0732](adr/0732-a-grant-reaches-what-the-person-chooses-at-consent.md)).
  Only Epicenter's grant, as `https://epicenter.so`, reaches every
  repository, because it syncs them. The account lists each computer's apps,
  and "Sign out this Mac" revokes them together.
- **Each credential lives in its app's own place**
  ([ADR-0740](adr/0740-every-credential-an-app-holds-lives-in-its-own-place.md)).
  On the desktop, one file in the app's AppData holds the refresh token and
  your provider API keys, and the page never sees them. On the web, the app
  keeps a rotated refresh token in its origin's storage, so renewing never
  leaves the page.
- **Your own `git` is plain Git**
  ([ADR-0733](adr/0733-your-own-git-in-an-epicenter-folder-is-plain-git.md)).
  Epicenter writes no credential helper, merge driver path, or LFS hooks into
  any Git configuration; its own sync supplies them on each run. A plain
  `git pull` merges notes by line, and the server refuses a plain push of a
  file that belongs in LFS. Epicenter carries its own Git with Git LFS inside
  the app for its own runs, so it needs no Git on the machine and shows no
  installer prompt
  ([ADR-0748](adr/0748-epicenter-ships-a-portable-git-inside-the-app.md));
  it ships after a license review of distributing GPLv2 Git.
- **An app's actions are request notes**
  ([ADR-0737](adr/0737-an-apps-actions-are-request-notes-it-watches-in-this-devices-place.md)).
  A script or agent writes a note into the app's `requests/` in AppData, the
  app handles it when it runs, and the result lands in the synced folder. An
  action that needs the app's window is a deep link, such as
  `whispering://record`.
- **A script names the app it reaches**
  ([ADR-0738](adr/0738-a-script-reaches-an-app-through-a-handle-module-written-from-its-site.md)).
  `epicenter add https://whispering.epicenter.so` writes a handle module,
  `open(handle)` opens the app's data, and `epicenter run <file>` runs the
  script under Bun. `epicenter check` says when a handle's contract is out of
  date.

## On the server

Repositories and documents are two kinds of resource in one namespace, shared
through one kind of grant
([ADR-0708](adr/0708-a-namespace-holds-documents-beside-repositories-under-one-resource-grant.md)).
A folder syncs with any Git host, with some manual setup for hosts other than
Epicenter. What the account adds:

- the list of your repositories and documents on every device
- online web variants of folder apps
- documents and their sync, once an app has live state
- sharing
- hosted inference
- LFS storage

## Who does what

| Piece | Job |
| --- | --- |
| An app | Reads and writes its stores. An app with collections needs no account and no Epicenter to save locally; syncing goes through Epicenter's engine. A document app would work locally and sync once you sign in. |
| A browser extension | Saves items through the engine over Chrome native messaging; without Epicenter it keeps them in its own storage and hands them over when Epicenter appears ([ADR-0745](adr/0745-a-browser-extension-writes-through-the-local-epicenter-engine.md)). |
| The app's site | Publishes `/contract.json`, and optionally `/SKILL.md` ([ADR-0723](adr/0723-an-apps-site-is-found-by-convention.md)). "Get the app" opens the site. |
| The `epicenter` engine | Git, LFS, merge, `check`, `move`, `get`, `set`, `add`, `run`, and writes from browser extensions. The CLI inside the Epicenter app, reached through one link per machine at `~/.epicenter/bin/epicenter` ([ADR-0713](adr/0713-one-epicenter-engine-per-machine-syncs-every-apps-folder.md), [ADR-0733](adr/0733-your-own-git-in-an-epicenter-folder-is-plain-git.md)). |
| The Epicenter app | Carries the engine, asks consent for a first sync, syncs while it runs, opens at login ([ADR-0328](adr/0328-epicenter-runs-when-you-log-in-and-pause-is-the-only-control-it-offers.md)), and browses every folder and document you have ([ADR-0715](adr/0715-the-epicenter-app-browses-every-folder-and-document-a-person-has.md)). |
| Your account | Resources, grants, documents, inference. Each app signs in once. |

Every folder merges by one rule: `.md` notes merge fields and body, and every
other file is kept whole in Git LFS
([ADR-0734](adr/0734-every-file-other-than-a-note-is-kept-whole-in-git-lfs.md)).
Epicenter's screen says: "Files other than notes are kept whole; if two
devices change one, both versions are kept."

**Sync gives files a history; it never merges two**
([ADR-0735](adr/0735-sync-gives-files-a-history-it-never-merges-two.md)).
No app creates a repository, and a folder has no history until it first
syncs. Turning on sync builds the folder's history on top of the account's
repository for that app: files only the account has are checked out, files
only this machine has are added, and files on both merge by the rule above,
in one commit, "Added from <computer name>". The consent screen says what
will happen: "This Mac's 12 recordings will be added to your Whispering,
which has 340." A folder whose Git history Epicenter did not make is refused
with the Git command that resolves it.

**Sync diffs state, because agents edit state**
([ADR-0744](adr/0744-sync-diffs-state-because-agents-edit-state.md)).
Epicenter keeps no log or outbox of operations. What is unsent is the
difference between the files and the last version both sides agreed on, so
an edit by an agent's `sed` syncs like an app's own. One merge, `settle`,
runs over two transports: Git on the desktop and the server's write path on
the web. On the desktop that is Git itself, run by the engine
([ADR-0747](adr/0747-git-runs-only-as-git-on-the-desktop.md)).

## In a browser

A browser variant runs the same code as the desktop variant with weaker
guarantees: its files are not visible, agents and tools cannot read them, a
local web variant has no history or sync, and the browser can delete them
([ADR-0706](adr/0706-a-browser-variant-runs-the-desktop-code-with-weaker-guarantees.md)).
Whispering keeps a local web variant that works without signing in. Signing in
there unlocks hosted transcription, as on the desktop; its recordings stay in
the browser.

**The web is online; offline needs an installed app**
([ADR-0746](adr/0746-the-web-is-online-offline-needs-an-installed-app.md)).
A web app is local only (this browser's storage, no sync) or online (reads
and writes through the server, no copy in the browser). Offline use with
sync, agents on files, and local history need the desktop app with
Epicenter. A browser extension saves through the engine on that desktop
([ADR-0745](adr/0745-a-browser-extension-writes-through-the-local-epicenter-engine.md)).

## Apps and their stores

| Store | Apps |
| --- | --- |
| Collections | Whispering, Bureaucracy, Capture, Vocab, Zhongwen, Mail, Photos, Messages, Invest, Ancestry, Geopolitics, Honeycrisp, Notes, Opensidian, The Ark, Tasks, Timebox, Tabs |
| Document | none yet |
| Neither | Decox (the Codex manager) |

- **Tabs** is a collection of saved tabs
  ([ADR-0743](adr/0743-tabs-keeps-saved-tabs-as-items-in-a-collection.md)): a
  browser extension built with WXT, Chrome first and Firefox later. It lists
  your open tabs from the browser and stores none of them. Saving a tab closes
  it and creates an item, `tabs/<id>.md`, with its URL, title, and save time.
  The extension writes it through the engine; without Epicenter it keeps
  saved tabs in its own storage and hands them over when Epicenter appears.
  Its Sync button asks the engine to sync now.
- **Zhongwen** is your app at `zhongwen.bradenwong.com`, not one of
  Epicenter's, so its folder is `~/Epicenter/bradenwong.com/zhongwen`.
- **Photos:** Google Photos holds the photos. A SQLite cache in AppData mirrors
  what Google Photos has. The folder holds your annotations, one per photo.
- **Mail:** each account's mail is a cache in AppData, and its secrets live in
  Mail's credentials file in AppData. The folder holds your saved queries and batches of changes.
- **Messages:** Beeper holds the conversations. The folder holds replies, and
  each send is journaled on the device (ADR-0704). There is no browser variant.
- **Epicenter** gets a synced folder, `~/Epicenter/epicenter`, only when it has
  something worth syncing.

## Planned

Agreed direction, built after the folder work:

- **Restore from your account.** On a second Mac, Epicenter offers "Restore
  Whispering". With no folder at the app's path, it checks the repository out
  there. With a folder already there, restoring is turning on sync: this
  Mac's files are added on top of the repository in one commit
  ([ADR-0735](adr/0735-sync-gives-files-a-history-it-never-merges-two.md)).
- **Export all my data.** One archive of every folder and document Epicenter
  can reach, following links and including attached files, with a list of
  browser-only data it cannot reach.
- **The engine is a link into the Epicenter app**
  ([ADR-0733](adr/0733-your-own-git-in-an-epicenter-folder-is-plain-git.md)),
  which carries a portable Git with Git LFS for its own runs, after a license
  review ([ADR-0748](adr/0748-epicenter-ships-a-portable-git-inside-the-app.md)).
- **Browser extensions save through the engine** over Chrome native
  messaging
  ([ADR-0745](adr/0745-a-browser-extension-writes-through-the-local-epicenter-engine.md));
  a spike is verifying native messaging.
- **Epicenter syncs while it runs and opens at login**
  ([ADR-0328](adr/0328-epicenter-runs-when-you-log-in-and-pause-is-the-only-control-it-offers.md)).
- **Your own folders join through a link you name**
  ([ADR-0736](adr/0736-a-folder-outside-the-library-is-enrolled-through-a-link-the-person-names.md)).
- **App actions and scripts:** request notes, deep links, and handle modules
  ([ADR-0737](adr/0737-an-apps-actions-are-request-notes-it-watches-in-this-devices-place.md),
  [ADR-0738](adr/0738-a-script-reaches-an-app-through-a-handle-module-written-from-its-site.md)).

## What Epicenter refuses

- A live editing session over a folder's files. An app that needs co-editing
  is a document app.
- One repository for the whole library root.
- Two live stores for the same data.
- A registry of apps or folders, or a stored location for any folder. An app
  joins by publishing a contract; a folder is where its app's address says.
- Machine state or Epicenter's paths in your Git configuration, or machine
  state in a synced folder.
- A sign-in shared between programs, or a broker that hands apps tokens.
- Merging two unrelated histories, or adopting a folder whose Git history
  Epicenter did not make.
- A merge by line for any file other than a note.
- A socket, verb registry, or windowless mode for app actions, until a named
  action needs a synchronous answer.
- A log or outbox of operations for sync
  ([ADR-0744](adr/0744-sync-diffs-state-because-agents-edit-state.md)).
- Desktop sync through the server's write path, a Git engine in TypeScript,
  and a Yjs document as the authority with Markdown as its working copy
  ([ADR-0747](adr/0747-git-runs-only-as-git-on-the-desktop.md)).
- `checkout` and `apply` for items. An item is already the file an agent
  edits ([ADR-0742](adr/0742-items-are-what-you-keep-documents-are-whats-live.md)).

## Open questions

- Which of your apps live at `epicenter.so` and which at your own domain.
- How plugins run, when synced batches apply, and how a person's own
  versions of actions survive an app update.
- End-to-end encryption for documents.

## Later

- Document sync, built with the first app that has live state. The sync service may reuse parts of the Yjs sync removed in
  `9f75a9bd51`, such as its update protocol and authentication; its store,
  generations ledger, and one-document-per-database design do not return.
- Embeddings. Nothing stores them yet; whether they sync or are recomputed on
  each device is decided when an app needs them.
- `epicenter checkout` and `epicenter apply`, so agents can edit a document as
  files and apply the changes back. They bridge documents only, never items.
- An installed phone app, when the first app's main use is on a phone away
  from a network: Tauri mobile with the Rust folder plugin and Git from a Rust
  library. Two-way offline sync in a browser, when a person with no computer
  that can run Epicenter needs to edit offline
  ([ADR-0746](adr/0746-the-web-is-online-offline-needs-an-installed-app.md)).
- `epicenter install <url>`. Apps install through Homebrew, app stores, or
  their own site until then.
