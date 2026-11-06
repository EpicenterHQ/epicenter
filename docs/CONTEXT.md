# Context: shared vocabulary

Epicenter is a toolkit for local-first apps over files, with optional Git
synchronization and inference. A desktop app opens its folder before
sign-in; a web app opens its team's repository once the person signs in.
The CLI can inspect ordinary files. Today the Epicenter desktop app manages
folders: it sets up, syncs, shares, and shows the status of folders, and
opens none of their files. Apps are separate
programs; Epicenter does not host them ([ADR-0701](adr/0701-apps-run-as-separate-programs.md)).

Use these names for the current API and the named remaining work. Source names
in the implementation table remain exact. Package READMEs describe the available
entry points; ADRs retain the decisions and their amendment history. An entry
marked **Direction** names a decided shape that is not built yet; its record's
`Unbuilt` line says what is missing, and [the vision](vision.md) maps them.
<!-- vocab-check: ignore-next-line (historical ADR filename) -->
The decisions are in [ADR-0584](adr/0584-each-concept-has-one-noun-in-code-on-the-wire-and-in-prose.md),
[ADR-0632](adr/0632-a-lens-belongs-to-its-reader.md),
[ADR-0633](adr/0633-apps-open-local-data-before-connecting-services.md),
[ADR-0634](adr/0634-hosted-inference-is-independent-of-repository-sync.md),
[ADR-0635](adr/0635-generic-desktop-data-tools-are-deferred.md),
and [ADR-0636](adr/0636-an-app-opens-local-files-through-one-folder-handle.md).

## Data and locations

| Name | Meaning |
| --- | --- |
| Epicenter | The toolkit and optional hosted services. It does not name one person's body of data. |
| Local dataset | The local data an app opens, with identity independent of account, remote URL, or hosted repository ID. Say "local data" in ordinary explanations. |
| Place | Where a folder is, as a value `openFolder(contract, place)` opens: an app's `home`, a `directory` in Bun or Node, or `memory()` in a test. A place opens to a store; nothing outside `@epicenter/folder` writes one. A caller may open several folders. |
| Store | What a place opens to: bytes at paths, with four verbs, `list`, `read`, `write(path, bytes \| null, over)`, and `watch` (`packages/folder/src/device/store.ts`, [ADR-0779](adr/0779-a-store-is-four-verbs-and-a-browser-recording-lands-whole.md)). Memory, a Bun directory, the desktop shell's root, a served directory, and the server's repository each answer them, held to one conformance suite. A store knows nothing of contracts or notes. **Direction:** a fifth verb, `patch` ([ADR-0798](adr/0798-a-store-patches-fields-and-writes-text-and-a-change-is-data.md)); a store reached over HTTP reads and writes one file as HTTP's conditional requests ([ADR-0800](adr/0800-a-stores-wire-speaks-http-conditional-requests-and-apps-connect-agents-to-the-cli.md)). |
| Directory | A physical filesystem location. In ordinary explanations, folder can name a disk directory. |
| Repository | A Git repository; repo is its shorthand, not another concept. A hosted repository also has a stable service ID, a changeable label, and membership. **Direction:** a repository's address `<team>/<name>` never changes; it is never renamed or moved, and a different name is a copy ([ADR-0771](adr/0771-plain-files-let-epicenter-refuse-renames-attachment-conflict-copies-and-a-second-store.md)). |
| Clone | An independent local copy of a repository. A desktop folder set up with `epicenter init` is a clone; a web app never holds one. |
| Remote or sync destination | The Git endpoint configured for synchronization. The remote URL does not identify the local dataset or grant access to it. |
| Table | A reader's view of immediate Markdown rows in one named top-level directory. Apps or selected schemas name tables; marker files do not. |
| Row | One table's `<id>.md` file, interpreted as frontmatter fields and a Markdown body. |
| Row id | The filename segment without `.md`, addressed within its table. There is no identity beyond the file name: a rename is a `set` at the new name and a `delete` of the old ([ADR-0776](adr/0776-a-notes-name-is-its-file-name-and-a-rename-is-a-set-and-a-delete.md)). A hosted repository ID has a different stability contract. |
| Row directory | Optional adjacent files under `<table>/<id>/`. Deleting the Markdown row leaves these files in place. It is not a nested table. |
| Field, value, body | A frontmatter key, its complete value, and the Markdown text after frontmatter. Front matter is the machine's; the body is the person's and the app's, and Epicenter reads nothing in it but conflict markers. **Direction:** a field Epicenter writes is one line, `key: <JSON>`, and a write patches only the lines of the fields it changes ([ADR-0796](adr/0796-a-field-is-a-line-its-value-is-json-and-a-write-patches-only-the-fields-it-changes.md)). |
| Front matter grammar | **Direction:** YAML restricted to `key: <JSON>`: a `---` first line, a later `---`, and between them one key, a colon, a space, and a JSON value per line, each key once. A file outside the grammar has no front matter: it is all body, shows in `invalid()`, and merges by lines ([ADR-0797](adr/0797-front-matter-is-a-strict-grammar-and-anything-else-is-body.md)). Today a write formats the whole note as block YAML in contract key order (`packages/definition/src/note/canonical.ts`). |
| Normalize | **Direction:** rewriting another tool's YAML header into the grammar, only when nothing is lost. It runs when a write touches the note, or when a person asks from the repair editor, the library, or `epicenter normalize`; never on a read ([ADR-0797](adr/0797-front-matter-is-a-strict-grammar-and-anything-else-is-body.md)). |
| File, path, root | Source bytes, their address relative to opened data, and that address's boundary. File access remains available outside selected tables. |
| Hidden path | A path with a segment starting with `.`. It is not a folder's data: no contract claims it, no watcher reports a change to it, sync never commits `.epicenter`, and listings show hidden files for their readers to skip. |
| Unfinished write | A file in a folder's `.epicenter/`, on its way somewhere: a save in `saves/` waiting to be renamed over its target (always safe to delete when no app runs), or a desktop recording in `recordings/` until it stops or the next open recovers it. |
| Reference | A value interpreted by its app's format, or a literal Markdown link. Existing record IDs remain; automatic cross-repository navigation is deferred. |

A web app keeps nothing in the browser: it opens the team's repository
through the server, online only, after the person signs in
([ADR-0786](adr/0786-every-web-app-is-online-and-browser-storage-leaves-the-platform.md)).
A desktop app opens its folder on the computer and works with no account.
Each surface has one store for the page's life, nothing moves between
stores, and one build serves both
([ADR-0781](adr/0781-apps-branch-on-what-a-capability-offers-and-one-build-serves-every-surface.md)).
Disk data can be shared by cooperating clients at the same path.

Only an app's `src/lib/app.ts` chooses its store, by the place it opens
its folder at: `openFolder(contract, home({ site, account }))` from
`@epicenter/folder`, whose `home` the package chooses when the page runs
([ADR-0773](adr/0773-a-folder-opens-at-a-place-every-place-is-a-store-and-the-server-never-merges.md),
[ADR-0781](adr/0781-apps-branch-on-what-a-capability-offers-and-one-build-serves-every-surface.md)).
A desktop shell on `epicenter-standalone` names Data and AppData. In a Tauri
window `home` is Data, which the shell names from the host of the app's
site under `~/Epicenter` (`~/Epicenter Dev` in development); what a
capability keeps on one computer goes to AppData through `settings` from
`@epicenter/local`. The shell makes the folder when nothing is at that path.
A root that cannot open shows a recovery screen with Retry and a
file-manager action; the app does not ask a first-run question
([ADR-0701](adr/0701-apps-run-as-separate-programs.md)). In a browser, `home`
is the account's repository for the app's site.

Epicenter keeps no records of its own in the library root, `~/Epicenter`
(`~/Epicenter Dev` in development); the standalone apps keep their folders
there.

Epicenter finds synced folders under the environment's library root and
one owner level. Each folder's local Git configuration records consent as
`epicenter.synced = true`. The desktop's Folders window runs the CLI's
commands, and no AppData file lists folders. A data folder's
`epicenter.json` has the separate portable declaration role described next.
**Direction:** a folder is found by the contract its `AGENTS.md` names,
under `~/Epicenter` and each team folder; no path is derived or stored, and
a folder's name is only a label
([ADR-0772](adr/0772-a-folder-says-what-it-is-in-agents-md-and-this-computer-keeps-the-rest.md)).
A folder's first sync moves it into its team's folder
([ADR-0791](adr/0791-a-folders-first-sync-places-it-in-its-teams-folder.md)).

Local dataset is a countable way to describe the local data an app selected,
not a required public object, universal ID, or registry. Stable local identity
means reopening the same local work independently of sign-in and remote changes.
It does not require a new identifier format.

Use repository in developer explanations about Git. Preserve exact CLI names
such as `repos` and HTTP paths such as `/api/repos`. In product text, name the
task: open a folder, use local data, or choose where to sync. App repository
and data repository describe contents; they are not different repository types.
Choose repository boundaries around the files that should share history,
synchronization, and access. An app or action does not require its own repository;
several apps can use the same files through their own schemas.

## Schemas and reading

| Name | Meaning |
| --- | --- |
| Schema or table schema | JSON Schema expectations for a row's frontmatter object, supplied by the reader. It does not validate the complete API Row wrapper. |
| Field schema | The expectations for one frontmatter value within a table schema. |
| Contract | An app's file layout: collections of notes (`.md`, front matter fields plus a body) and files at path templates such as `recordings/{id}.md`, written with `defineContract` and published as JSON. `epicenter check` and `epicenter format` take one as a URL or a file path; a folder holds no copy. **Direction:** `epicenter format` goes with the whole-note formatter ([ADR-0796](adr/0796-a-field-is-a-line-its-value-is-json-and-a-write-patches-only-the-fields-it-changes.md)), and a contract is also the input schema of each collection's MCP tools ([ADR-0799](adr/0799-a-folders-contract-is-also-an-mcp-server.md)). |
| Folder declaration | A folder's optional root `epicenter.json`, the legacy portable schema and saved-view file. No current tool reads or writes it; a file already there stays as ordinary content. |
| Reader or writer | A role performed by an app, CLI, or agent, not another product or data owner. |
| Issue or diagnostic | A specific parsing or schema problem, with its source. A schema disagreement is distinct from unparseable source or a storage failure. |
| View | A presentation of data. Selecting another schema changes interpretation, not saved files or edit ownership. |
| Query projection | Derived query data, such as an in-memory SQLite table built from files and selected schemas. It is not another durable data owner. **Direction:** `epicenter query` attaches each folder as a SQLite schema with a table per collection (a column per field, plus `name` and `body`) and an `invalid` table, rebuilt on every run and never stored ([ADR-0790](adr/0790-the-epicenter-app-is-a-library-over-every-folder-and-the-cli-answers-its-queries.md)). |

Apps supply their own read schemas and need no schema file. `epicenter check`
and `epicenter format` take an app's contract; no CLI command reads a folder's
`epicenter.json`.

Row schemas grant no access and choose no merge policy. They
execute no code and fetch no external references. Git operations interpret no
declaration sections. Tracked files remain tracked; untracked files enter
commits unless Git ignores them. The folder's `.gitignore` files travel as
ordinary content, and native Git also honors machine-specific excludes. Schema
disagreements retain raw source.

Use schema for row expectations and declaration for the whole portable
`epicenter.json` document. Retire lens, description, and shape as competing
domain names for those expectations. "Describe" remains an ordinary verb. Without a selected
schema, a reader can inspect stored values but gives no app-specific validity
verdict. Schema selection is independent of storage, identity, and credentials.

## Changes and Git

| Name | Meaning |
| --- | --- |
| Edit or unsaved input | Text an editor holds after the person typed it and until its save lands. The folder shows only what landed; the editor shows each typed field until its save lands. |
| Save | Acknowledged local persistence of an edit. It does not promise a Git commit or remote receipt. |
| Write | A file or storage operation. An app writes with `set` and `delete`, which never fail: the folder keeps each write, in order, until it lands, and rejects the ones still waiting with `FolderClosed` only when the folder fails or closes ([ADR-0775](adr/0775-a-write-never-fails-the-folder-keeps-it-until-it-lands.md), [ADR-0782](adr/0782-a-waiting-write-the-folder-will-not-make-rejects.md)). |
| Write over a version | A store's write lands only while the path still holds `over`, the version its writer read (`'absent'`: nothing there), and answers `'stale'` otherwise. The version is internal to the folder; no app holds one ([ADR-0774](adr/0774-one-write-makes-it-so-and-settles-a-change-the-way-sync-does.md)). **Direction:** text, deletes, and attachments stay writes over the version read; field changes become patches. |
| Patch | **Direction:** a store's fifth verb, `patch(path, { set, delete })`: field lines replaced, added, or removed on the file as it is, so a patch sent twice writes the same file and is never stale. It never creates a file and never normalizes; it answers `gone` or `outside` and the page decides ([ADR-0798](adr/0798-a-store-patches-fields-and-writes-text-and-a-change-is-data.md)). |
| Change | **Direction:** one write or patch as JSON discriminated by `op`, the vocabulary every transport, queue, and conformance test carries ([ADR-0798](adr/0798-a-store-patches-fields-and-writes-text-and-a-change-is-data.md)). |
| Commit or version | A fixed Git snapshot. Prefer commit in technical text; version can explain it in a UI. |
| Sync | `epicenter sync`: commit a synced folder's files with `git add`, fetch, merge, and push. It is the only desktop committer; the server commits web writes. Apps never commit. **Direction:** each native app syncs its own folder through the sync core at a person's moments, and signs in to do it ([ADR-0751](adr/0751-every-native-app-carries-one-sync-core.md), [ADR-0785](adr/0785-a-desktop-app-signs-in-to-sync-its-own-folder.md)). |
| Round | One sync of a folder under its lock: commit, fetch, merge, check out, push. **Direction:** checkout writes only what did not move during the round; a file that moved ends it `retry` before anything advances, and the next round merges it ([ADR-0794](adr/0794-a-sync-round-asks-its-host-to-settle-checks-out-only-what-did-not-move-and-retries-rather-than-guess.md)). |
| Merge | Combine base, current, and incoming (the later arrival). Today `settle` (`@epicenter/definition/merge`) does it: a front matter key goes to the later arrival; the body merges by line, then by word; an edit beats a delete. Schemas do not choose merge behavior. **Direction:** Git's three-way line merge for a body, Epicenter's key rule for front matter comparing JSON values, the later write for any other file, and an edit beating a delete; `settle`'s body merge goes ([ADR-0795](adr/0795-git-merges-a-notes-body-and-epicenter-merges-its-front-matter-by-key.md), [ADR-0796](adr/0796-a-field-is-a-line-its-value-is-json-and-a-write-patches-only-the-fields-it-changes.md)). |
| Conflict block | What a merge leaves when both sides changed the same spot of a note's body: one block of whole lines between Git's markers, ordinary file content. A binary file never gets one: the later write wins, and the version it replaced stays in history. Today each marker's label names a device and a time. **Direction:** the labels are fixed, `current` and `incoming`, so two computers merging one clash write the same text ([ADR-0795](adr/0795-git-merges-a-notes-body-and-epicenter-merges-its-front-matter-by-key.md)). |
| Marks | **Direction:** what a person sees of sync, never Git's steps: synced (✓) when an item matches what the server held at the last round, waiting (◌) when it changed since, and conflict (⚠) when a note holds a conflict block, resolved in the repair editor ([ADR-0788](adr/0788-everything-in-a-folder-syncs-and-a-recordings-audio-is-kept-in-one-of-three-places.md), [ADR-0789](adr/0789-a-conflict-is-a-mark-on-its-note-resolved-in-the-repair-editor.md)). The web shows no sync marks. |
| History | The commits Git records. Overwritten intermediate saves need not be recoverable. |
| Snapshot | The file state described by a commit; retaining that snapshot does not require retaining every ancestor. |
| Ref, head, base | A Git pointer, the selected local commit, and the incorporated remote commit or merge input where qualified. |
| Git object, tree, blob | Content-addressed Git data: commit metadata, directory entries, and file bytes. A Git blob is not a managed audio attachment. |
| Revision | The local publication counter used to reject stale browser computations. It is not a Git commit. |
| Transaction or publication | Atomic storage work that acknowledges local state. This publication is unrelated to the retired app-owned schema publication. |
| Cache | Data rebuilt without losing saved work. Unlanded edits and uncertain pending commits are not caches. |

A folder's write (`set`, `delete`, an editor's save) reads the file just
before writing it and writes over exactly what it read; when the file moved
in between, it reads and applies the change again. The fields a write names
take it, and a body changed since the folder showed the note merges by
lines with `settle`, as sync merges it (ADR-0774). A write never fails: the
folder keeps it, in order, until it lands, and `folder.unavailable()` says
why it waits (ADR-0775). No computer runs a Git merge: sync merges in
TypeScript (ADR-0804).

A Svelte view binds its controls to the open note's editor (`notes.edit`),
which shows each typed field until its save lands, then follows the folder
again. Writes waiting for the store live in the page's memory and do not
survive a crash; the leave guard asks before the page closes. See [the folder package](../packages/folder/README.md)
and [the Svelte adapter](../packages/svelte/README.md).

During a sync (`sync` in `@epicenter/folder/sync`, which `epicenter sync`
runs), a note both sides changed merges against the version both last
agreed on, read from the server by its Git blob id; this computer's side is
the later write. The server merges nothing: it refuses a commit over a
version the repository no longer holds, and the sync reads what is there and
runs again
([ADR-0773](adr/0773-a-folder-opens-at-a-place-every-place-is-a-store-and-the-server-never-merges.md)).
Sync stops, with exit code
2, on anything a person or agent must settle, such as an unfinished merge or a
`main` its owner rewrote ([ADR-0700](adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)).

## Clients, services, and access

| Name | Meaning |
| --- | --- |
| App | A program using its own read schemas. Qualify a web app or desktop app when runtime or native capabilities matter. |
| Capability | A value an app's `app.ts` makes synchronously and hands to its pages: the folder, the account, settings, AI. Its package decides at run time, with `isTauri()`, whether the page runs in a Tauri window, and loads its desktop implementation when it connects or first acts; an app branches on what a capability offers, never on the platform, and a capability a surface cannot give is `null` there ([ADR-0781](adr/0781-apps-branch-on-what-a-capability-offers-and-one-build-serves-every-surface.md)). It exposes no ready promise ([ADR-0777](adr/0777-a-capability-has-no-ready-promise.md)). |
| CLI | The `epicenter` executable. Its package entry points and commands are documented by the CLI package. **Direction:** its own install for agents and terminals, signing in as its own OAuth client with its own credentials file ([ADR-0793](adr/0793-programs-only-compose-typescript-holds-what-epicenter-means-and-rust-holds-the-os-git-and-secrets.md)). |
| Agent or person | A direct file writer. Its changes reach editors through a client's listeners; a folder's next write to that file reads it first and keeps their change. **Direction:** an agent reaches typed tools through `epicenter mcp`, which an app connects with one click ([ADR-0800](adr/0800-a-stores-wire-speaks-http-conditional-requests-and-apps-connect-agents-to-the-cli.md)). |
| Epicenter desktop app | The app in `apps/epicenter`: the folder manager and Settings. It hosts no app and opens no folder's files (ADR-0701). It is optional to standalone apps and the CLI. |
| Library | **Direction:** what the Epicenter app becomes: an app built like the others, over every folder under `~/Epicenter` by team. Each collection is a table filtered by `select * from <collection> where …`, each cell edited by its field's type, beside what needs a look (sync state, conflicts, notes that do not read, duplicate folders) and Sync all ([ADR-0790](adr/0790-the-epicenter-app-is-a-library-over-every-folder-and-the-cli-answers-its-queries.md)). Not to be confused with the library root, `~/Epicenter`. |
| Web origin | The web app's settings storage and OAuth client boundary. It is distinct from Git's remote named `origin`. |
| Runtime or shell | The environment executing an app or providing native mechanisms. Qualify a Git host or inference host separately. |
| Deployment | A hosted or self-hosted service installation. Hosted-only billing stays in `apps/api/worker/billing/`. |
| Account or principal | The person's service account, or the precise authenticated identity where technical code uses principal. A desktop app's folder needs neither; a web app needs the account. Each capability handed the account says what it needs (`repository`, `ai`, or `profile`), and sign-in asks for exactly those ([ADR-0792](adr/0792-an-account-asks-for-what-the-capabilities-that-take-it-need.md)). |
| Membership, owner, member | A hosted repository's access list and roles. A repository grant (`read` or `write`) lets one person outside the namespace reach one repository; only the owner rewrites `main` or grants. Removing membership or revoking a grant does not recall existing copies. |
| Team | **Direction:** what owns repositories, replacing the namespace. Its members reach every repository in it, owners also rename the team and change members, and sharing is membership, with no per-repository grants. Consent chooses an app's team, and another team's folders sit in that team's folder under `~/Epicenter` ([ADR-0770](adr/0770-teams-own-repositories-and-sharing-is-membership.md), [ADR-0772](adr/0772-a-folder-says-what-it-is-in-agents-md-and-this-computer-keeps-the-rest.md)). |
| Grant, consent, scope, audience | Permission, its approval, allowed operations, and the service accepting a token. Qualify repository grants, account grants, and inference authorization. |
| Credential, token, provider key | Authentication material, retained outside synchronized data. It does not identify a local dataset. **Direction:** on the desktop each app keeps its secrets in its own credentials file in AppData, read by the request that uses it and never by the page ([ADR-0783](adr/0783-a-secret-lives-in-the-apps-credentials-file-and-is-read-by-the-request-that-uses-it.md)). |
| Inference provider | The service or local model used for AI work. Its configuration is independent of a Git remote and repository permission. |
| Inference or transcription | AI processing of selected inputs; transcription produces text from audio. It does not imply attachment synchronization. |
| Allowance, usage, credits, billing | Hosted service entitlement and accounting, independent of repository saves. |
| Replica | The page's copy of one folder: the text of each file that is not Git LFS, and the path, version, and size of every other file, fed by the paths that changed ([ADR-0778](adr/0778-a-page-connects-once-and-then-reads-synchronously.md)). It is not an extra product component. |
| Authority | The source that controls accepted state where an implementation uses this precise term. |

Avoid unqualified connection and host when their roles affect behavior. Name the
sync destination, inference provider, runtime, or grant involved. Reserve generic
browser for no product: say web browser for the runtime and Epicenter desktop
app for the native product.

Host is a qualified technical role: a runtime can host an app, a Git service
hosts repositories, and a deployment hosts services. Shell names runtime
integration when that mechanism matters.

Record can explain a row to a person; it does not introduce a second stored
object. Workspace should not become an alias for a folder, local selection,
or repository. Name the actual object unless a separate grouping feature exists.
Whispering's `Workspace` supplies platform capabilities beside the opened
folder: capture, inference, connections, preferences, and recording recovery.
It holds no folder or closing lifetime.

## Current implementation names

These names distinguish the public app API from older CLI authoring tools and
internal browser storage. Historical terms in accepted ADRs do not create
additional current APIs.

| Source | Names and current behavior |
| --- | --- |
| `@epicenter/folder` places | `openFolder(contract, place)` from `@epicenter/folder`, over a contract from `@epicenter/definition/contract`, at `home({ site, account })` (chosen when the page runs: the desktop's Data root in a Tauri window, the account's repository in a browser), `directory(path)` from `/node`, or `memory()` from `/memory` in a test. |
| CLI | Implemented commands include `auth`, `check`, `format`, `sync`, `clone`, `log`, `diff`, `restore`, `repos`, `share`, `unshare`, and `messages`. **Direction:** `query`, `set`, `edit`, `delete`, `normalize`, and `mcp` arrive; `format`, `share`, and `unshare` go ([ADR-0790](adr/0790-the-epicenter-app-is-a-library-over-every-folder-and-the-cli-answers-its-queries.md), [ADR-0797](adr/0797-front-matter-is-a-strict-grammar-and-anything-else-is-body.md), [ADR-0799](adr/0799-a-folders-contract-is-also-an-mcp-server.md), [ADR-0770](adr/0770-teams-own-repositories-and-sharing-is-membership.md)). |
| Stored records | Existing fields such as `recordingId` retain their names and values. A noun cleanup is not a data-format migration. |

For the full dated inventory and the review's accepted and rejected collapses,
see the [October vocabulary audit](vocabulary-audit-2026-10-19.md).
