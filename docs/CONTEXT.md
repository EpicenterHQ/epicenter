# Context: shared vocabulary

Epicenter is your folders, and apps are lenses on them
([ADR-0813](adr/0813-epicenter-is-your-folders-and-apps-are-lenses.md)). A
folder holds a person's things, syncs with an Epicenter server, keeps history
there, and is shared with people. An app, the Epicenter app, the CLI, or an
agent shows and changes the part of a folder it understands. A desktop app
opens its folder before sign-in; a web app opens a folder on the server once
the person signs in. Apps are separate programs; Epicenter does not host them
([ADR-0701](adr/0701-apps-run-as-separate-programs.md)).

Use these names for the current API and the named remaining work. Source names
in the implementation table remain exact. Package READMEs describe the available
entry points; ADRs retain the decisions and their amendment history. An entry
marked **Direction** names a decided shape that is not built yet; its record's
`Unbuilt` line says what is missing, and [the vision](vision.md) maps them.
Where a record decided a word the code has not adopted, this file uses the
decided word for the concept and the code's identifier when it names code; the
[retired terms](#retired-terms) table lists each.
<!-- vocab-check: ignore-next-line (historical ADR filename) -->
The vocabulary decisions are in [ADR-0584](adr/0584-each-concept-has-one-noun-in-code-on-the-wire-and-in-prose.md),
[ADR-0802](adr/0802-people-share-spaces-an-app-works-in-one-at-a-time-and-a-folder-carries-its-contract.md),
[ADR-0813](adr/0813-epicenter-is-your-folders-and-apps-are-lenses.md),
[ADR-0816](adr/0816-the-epicenter-app-is-where-a-person-sees-and-manages-every-folder.md),
and [ADR-0818](adr/0818-an-app-is-a-view-a-window-and-its-capabilities-and-everything-is-repairable-by-hand.md).

## Folders and places

| Name | Meaning |
| --- | --- |
| Epicenter | The product: a person's folders, the apps that are lenses on them, the Epicenter app, the CLI, and the optional hosted services. It does not name one person's body of data. |
| Folder | A directory directly inside the Epicenter folder (a folder elsewhere joins by a symbolic link there). It holds a person's things, syncs, keeps history, and is shared. Its identity is the id the server gives it at its first sync; its directory's name is that computer's own label, and its title is a field of `epicenter.json` ([ADR-0811](adr/0811-folders-are-shared-directly-and-an-app-reaches-the-folders-attached-to-it.md), [ADR-0813](adr/0813-epicenter-is-your-folders-and-apps-are-lenses.md)). Nothing registers a folder: discovery lists the directory (`epicenterRoot` in `@epicenter/folder/node`). |
| Epicenter folder | `~/Epicenter` (`~/Epicenter Dev` in development). Code and Rust comments still call it the library root ([ADR-0816](adr/0816-the-epicenter-app-is-where-a-person-sees-and-manages-every-folder.md)). |
| Directory | A physical filesystem location. In ordinary explanations, folder can name a disk directory. |
| Contract | A folder's `epicenter.json`, which is optional: `$schema`, `title`, and `collections`. The folder's people own it, and no app writes an `$id` into it ([ADR-0805](adr/0805-a-folder-is-recognized-by-epicenter-json-which-is-its-contract.md), [ADR-0812](adr/0812-an-apps-schema-is-a-view-that-must-fit-a-folders-contract.md)). A folder with none is complete: every visible file syncs and keeps history, and a contract adds checking, tables, tools, and merging by field. `epicenter init` proposes one from the files. Today an app also compiles its contract with `defineContract`, and `epicenter check` takes one as a URL or file path. |
| Collection | A name in a contract and a path pattern: `todos/{name}.md` holds items with fields, any other pattern holds files. A file collection is a pattern with no fields. |
| Item | One file of a collection, with its attachments: files that share its directory and name are one item. Its name is its file name, and there is no identity beyond it: a rename is a `set` at the new name and a `delete` of the old ([ADR-0776](adr/0776-a-notes-name-is-its-file-name-and-a-rename-is-a-set-and-a-delete.md), [ADR-0818](adr/0818-an-app-is-a-view-a-window-and-its-capabilities-and-everything-is-repairable-by-hand.md)). The code says note (`NoteOf`, `FolderNotes`, `invalid()`), and `{id}` for the name in path patterns; the decided word is `{name}`. The rename is pending. "Note" names Honeycrisp's notes. |
| Attachment | Any other file an item owns, such as a recording's audio. Its version is the blob id of its canonical Git LFS pointer, and its bytes are fetched at `blobs/<sha256>` ([ADR-0808](adr/0808-a-files-version-is-its-git-blob-id-on-every-store.md)). |
| Field, value, body | A front matter key, its complete value, and the Markdown text after front matter. Front matter is the machine's; the body is the person's and the app's, and Epicenter reads nothing in it but conflict markers. **Direction:** a field Epicenter writes is one line, `key: <JSON>`, and a write patches only the lines of the fields it changes ([ADR-0796](adr/0796-a-field-is-a-line-its-value-is-json-and-a-write-patches-only-the-fields-it-changes.md)). |
| Front matter grammar | YAML restricted to `key: <JSON>`: a `---` first line, a later `---`, and between them one key, a colon, a space, and a JSON value per line, each key once. A file outside the grammar has no front matter: it is all body, shows in `invalid()`, and merges by lines ([ADR-0797](adr/0797-front-matter-is-a-strict-grammar-and-anything-else-is-body.md)). `@epicenter/definition/front-matter` reads, patches, and merges it, and sync uses it; a folder's writes still format the whole note as block YAML in the contract's key order (`packages/definition/src/note/canonical.ts`). |
| Normalize | **Direction:** rewriting another tool's YAML header into the grammar, only when nothing is lost. It runs when a write touches the item, or when a person asks from the repair editor, the Epicenter app, or `epicenter normalize`; never on a read ([ADR-0797](adr/0797-front-matter-is-a-strict-grammar-and-anything-else-is-body.md)). |
| File, path, root | Source bytes, their address relative to opened data, and that address's boundary. |
| Hidden path | A path with a segment starting with `.`. It is not a folder's data: no contract claims it, no watcher reports a change to it, sync never carries it, and listings show hidden files for their readers to skip ([ADR-0804](adr/0804-a-computer-keeps-a-plain-folder-and-every-surface-syncs-with-one-typescript-function.md)). |
| Manifest | `.epicenter/synced.json`: the folder's id, the directory it synced in (`root`: device and inode), the commit both sides last agreed at, and each file's agreed blob id. A cache: its loss costs only the next sync's speed. |
| Unfinished write | A file in a folder's `.epicenter/`, on its way somewhere: a save in `saves/` waiting to be renamed over its target (always safe to delete when no app runs), or a desktop recording in `recordings/` until it stops or the next open recovers it. |
| Reference | A value interpreted by its app's format, or a literal Markdown link. Automatic cross-folder navigation is deferred. |

**Places and stores.** An app opens its folder at a place, a value
`openFolder(contract, place)` opens: the app's `home`, a `directory` in Bun or
Node, `served(url)`, or `memory()` in a test. A place opens to a store: bytes
at paths, with four verbs, `list`, `read`, `watch`, and `put(path, bytes | null,
expect)`, which lands only over the version expected and otherwise fails with
`Moved` (`packages/folder/src/device/store.ts`,
[ADR-0779](adr/0779-a-store-is-four-verbs-and-a-browser-recording-lands-whole.md),
[ADR-0808](adr/0808-a-files-version-is-its-git-blob-id-on-every-store.md)).
Memory, a Bun directory, the desktop shell's root, a served directory, and the
server's repository each answer them, held to one conformance suite. A store
knows nothing of contracts or items. A file's version is its Git blob id on
every store, and no app holds one. **Direction:** a local store also has
`patch(path, { set, delete })`, and a change is JSON discriminated by `op`
([ADR-0798](adr/0798-a-store-patches-fields-and-writes-text-and-a-change-is-data.md));
the server has no single-file routes and no `patch`, and only sync talks to
it ([ADR-0807](adr/0807-an-app-writes-only-to-a-local-store-and-only-sync-talks-to-a-server.md)).

A desktop app opens its folder on the computer and works with no account. A
web app opens the folder attached to its app on the server, online only, after
the person signs in ([ADR-0786](adr/0786-every-web-app-is-online-and-browser-storage-leaves-the-platform.md)).
**Direction:** the web's local store is memory seeded from the repository and
synced ([ADR-0807](adr/0807-an-app-writes-only-to-a-local-store-and-only-sync-talks-to-a-server.md)).
One build serves both ([ADR-0781](adr/0781-apps-branch-on-what-a-capability-offers-and-one-build-serves-every-surface.md)).

Only an app's `src/lib/app.ts` chooses its place: `openFolder(contract,
home({ site, account }))` from `@epicenter/folder`, whose `home` the package
chooses when the page runs. A desktop shell on `epicenter-standalone` names
Data and AppData. In a Tauri window `home` is Data, which the shell names from
the host of the app's site under the Epicenter folder; what a capability keeps
on one computer goes to AppData through `settings` from `@epicenter/local`. The
shell makes the folder when nothing is at that path. A root that cannot open
shows a recovery screen with Retry and a file-manager action; the app does not
ask a first-run question ([ADR-0701](adr/0701-apps-run-as-separate-programs.md)).
In a browser, `home` is the folder the account's app is attached to.
**Direction:** a window shows the folder it was opened on, `openFolder(view)`,
and `home` goes ([ADR-0814](adr/0814-one-window-shows-one-folder.md),
[ADR-0815](adr/0815-the-platform-gives-a-window-its-folder-and-every-app-the-same-home.md)).

## Apps and lenses

| Name | Meaning |
| --- | --- |
| Lens | An app, the Epicenter app, the CLI, or an agent seen as showing and changing the part of a folder it understands. Lenses come and go; the folder stays ([ADR-0813](adr/0813-epicenter-is-your-folders-and-apps-are-lenses.md)). It no longer names a schema's expectations. |
| App | A program that is a view, a window over one folder, and its capabilities ([ADR-0818](adr/0818-an-app-is-a-view-a-window-and-its-capabilities-and-everything-is-repairable-by-hand.md)). Qualify a web app or desktop app when runtime or native capabilities matter. |
| View | What an app understands in a folder: the collections and fields it reads and writes, published at its site. It fits a folder when each of its collections is in the contract at the same path and each field it uses is there with a type the app accepts; attaching an app proposes what is missing, and an app never removes or retypes what is there ([ADR-0812](adr/0812-an-apps-schema-is-a-view-that-must-fit-a-folders-contract.md)). Selecting another view changes interpretation, not saved files or edit ownership. **Direction:** `defineView` ([ADR-0818](adr/0818-an-app-is-a-view-a-window-and-its-capabilities-and-everything-is-repairable-by-hand.md)); today an app compiles a `defineContract`. |
| Window | An app's interface over one folder, for the window's whole life. Another folder opens in another window ([ADR-0814](adr/0814-one-window-shows-one-folder.md)). |
| Platform | What every app inherits about folders: finding them, the home, New and Open, sync and its marks, history, sharing, conflicts and repair, the fit check, and signing in to sync. An app places the platform's pieces and replaces none ([ADR-0817](adr/0817-the-cli-exposes-every-platform-operation-and-an-app-inherits-everything-about-folders.md)). Each operation is a function in `@epicenter/folder/platform`. |
| Home | **Direction:** the screen every app starts on, which the platform gives: the folders the app can open, their state, and New, Open, and Share ([ADR-0815](adr/0815-the-platform-gives-a-window-its-folder-and-every-app-the-same-home.md)). `listHome` in `@epicenter/folder/platform` is its data. |
| Capability | A value an app's `app.ts` makes synchronously and hands to its pages: the folder, the account, settings, AI. Its package decides at run time, with `isTauri()`, whether the page runs in a Tauri window, and loads its desktop implementation when it connects or first acts; an app branches on what a capability offers, never on the platform, and a capability a surface cannot give is `null` there ([ADR-0781](adr/0781-apps-branch-on-what-a-capability-offers-and-one-build-serves-every-surface.md)). It exposes no ready promise ([ADR-0777](adr/0777-a-capability-has-no-ready-promise.md)). |
| Epicenter app | The app in `apps/epicenter`, where a person sees and manages every folder: each folder's title, members, and state (never synced, synced, or shared); a folder as tables of its collections or as its files; sync, sharing, accepting, and repair; views across folders; and "Connect your agents". It keeps every folder in sync while it runs. It knows an app only as data, hosts no app, and runs no MCP server ([ADR-0816](adr/0816-the-epicenter-app-is-where-a-person-sees-and-manages-every-folder.md), [ADR-0819](adr/0819-every-program-keeps-the-folders-it-has-open-in-sync-and-the-epicenter-app-has-them-all-open.md)). Today it has Settings and a Folders window that composes `@epicenter/folder/platform` as it is built; see its README. |
| CLI | The `epicenter` executable: the platform without windows, a command for every platform operation. The Epicenter app and every app compose the same package functions, and none calls the CLI ([ADR-0817](adr/0817-the-cli-exposes-every-platform-operation-and-an-app-inherits-everything-about-folders.md)). Its entry points and commands are documented by the CLI package. **Direction:** its own install for agents and terminals, signing in as its own OAuth client with its own credentials file ([ADR-0793](adr/0793-programs-only-compose-typescript-holds-what-epicenter-means-and-rust-holds-the-os-git-and-secrets.md)). |
| Agent or person | A direct file writer. Its changes reach editors through a client's listeners; a folder's next write to that file reads it first and keeps their change. **Direction:** an agent reaches typed tools through `epicenter mcp`, and reaches every folder because it acts as the person ([ADR-0799](adr/0799-a-folders-contract-is-also-an-mcp-server.md), [ADR-0819](adr/0819-every-program-keeps-the-folders-it-has-open-in-sync-and-the-epicenter-app-has-them-all-open.md)). |
| Reader or writer | A role performed by an app, CLI, or agent, not another product or data owner. A folder's member roles are separate (below). |
| Issue or diagnostic | A specific parsing or schema problem, with its source. A schema disagreement is distinct from unparseable source or a storage failure. |
| Query projection | Derived query data, such as an in-memory SQLite table built from files and a contract. It is not another durable data owner. **Direction:** `epicenter query` attaches each folder as a SQLite schema with a table per collection (a column per field, plus `name` and `body`) and an `invalid` table, rebuilt on every run and never stored ([ADR-0790](adr/0790-the-epicenter-app-is-a-library-over-every-folder-and-the-cli-answers-its-queries.md)). |
| Runtime or shell | The environment executing an app or providing native mechanisms. Qualify a Git host or inference host separately. |

A contract's schemas grant no access and choose no merge policy. They execute
no code and fetch no external references. Without a contract, a reader can
inspect stored values but gives no app-specific validity verdict. A schema's
selection is independent of storage, identity, and credentials.

## Changes and sync

| Name | Meaning |
| --- | --- |
| Edit or unsaved input | Text an editor holds after the person typed it and until its save lands. The folder shows only what landed; the editor shows each typed field until its save lands. |
| Save | Acknowledged local persistence of an edit. It does not promise a sync or a commit. |
| Write | A file or storage operation. An app writes with `set` and `delete`, which never fail: the folder keeps each write, in order, until it lands, and rejects the ones still waiting with `FolderClosed` only when the folder fails or closes ([ADR-0775](adr/0775-a-write-never-fails-the-folder-keeps-it-until-it-lands.md), [ADR-0782](adr/0782-a-waiting-write-the-folder-will-not-make-rejects.md)). |
| Put over a version | A store's write lands only while the path still holds `expect`, the blob id its writer read (`null`: nothing there), and fails with `Moved { now }` otherwise. A `Moved` whose `now` is the version the put meant to land counts as landed. No app holds a version ([ADR-0774](adr/0774-one-write-makes-it-so-and-settles-a-change-the-way-sync-does.md), [ADR-0808](adr/0808-a-files-version-is-its-git-blob-id-on-every-store.md)). |
| Patch | **Direction:** a local store's `patch(path, { set, delete })`: field lines replaced, added, or removed on the file as it is, so a patch sent twice writes the same file and is never stale. It never creates a file and never normalizes ([ADR-0798](adr/0798-a-store-patches-fields-and-writes-text-and-a-change-is-data.md), [ADR-0807](adr/0807-an-app-writes-only-to-a-local-store-and-only-sync-talks-to-a-server.md)). |
| Change | **Direction:** one write or patch as JSON discriminated by `op`, the vocabulary every local transport, queue, and conformance test carries ([ADR-0798](adr/0798-a-store-patches-fields-and-writes-text-and-a-change-is-data.md)). |
| Sync | One exchange of a folder with its repository on the server: `sync({ local, remote, manifest })` in `@epicenter/folder/sync`, one TypeScript function every surface runs. It copies what changed on one side to the other and merges what both changed, writing the local side first, each file over the version listed, then committing to the repository. `epicenter sync` runs it for a folder on this computer. No Git runs on a computer ([ADR-0803](adr/0803-clients-sync-only-with-epicenter-servers-and-sync-is-a-function-of-two-stores.md), [ADR-0804](adr/0804-a-computer-keeps-a-plain-folder-and-every-surface-syncs-with-one-typescript-function.md)). The older word for one sync was round. |
| Moments | When a program syncs a folder it has open: on opening, a few seconds after a burst of saves, when its window returns, every few seconds while shown when either side changed, and on request. `syncAtMoments` in `@epicenter/folder/sync`; no app runs it yet. Every program keeps the folders it has open in sync, and the Epicenter app has every folder open ([ADR-0806](adr/0806-an-open-app-checks-for-changes-and-a-sync-never-silently-loses-an-edit.md), [ADR-0819](adr/0819-every-program-keeps-the-folders-it-has-open-in-sync-and-the-epicenter-app-has-them-all-open.md)). |
| First sync, copy | A first sync joins the folder its manifest names, or the one folder attached to the app, before it creates one. A copied folder (its manifest names another directory) sends nothing until a person answers new or same (`--new`, `--same`) ([ADR-0811](adr/0811-folders-are-shared-directly-and-an-app-reaches-the-folders-attached-to-it.md)). |
| Merge | Combine base, current, and incoming. In sync, `merge3` (`@epicenter/definition/front-matter`) does it: Git's three-way line merge for a body (a port of `git merge-file`), a key rule for front matter comparing JSON values, the later write for any other file, and an edit beating a delete. Sync takes this computer's side as the later write. A folder's own write over a note that changed under it still settles with `settle` (`@epicenter/definition/merge`), which merges a body by line and then by word and goes with the whole-note formatter ([ADR-0795](adr/0795-git-merges-a-notes-body-and-epicenter-merges-its-front-matter-by-key.md), [ADR-0796](adr/0796-a-field-is-a-line-its-value-is-json-and-a-write-patches-only-the-fields-it-changes.md)). Schemas do not choose merge behavior. The server never merges. |
| Conflict block | What a merge leaves when both sides changed the same spot of an item's body: one block of whole lines between Git's markers, ordinary file content. A binary file never gets one: the later write wins, and the version it replaced stays in history. Today each marker's label names a device and a time in `settle`'s blocks. **Direction:** the labels are fixed, `current` and `incoming`, so two computers merging one clash write the same text ([ADR-0795](adr/0795-git-merges-a-notes-body-and-epicenter-merges-its-front-matter-by-key.md)). |
| Marks | **Direction:** what a person sees of sync, never Git's steps: synced (✓), waiting (◌), conflict (⚠) when a body holds a conflict block, resolved in the repair editor, and refused (✗) with the server's reason ([ADR-0788](adr/0788-everything-in-a-folder-syncs-and-a-recordings-audio-is-kept-in-one-of-three-places.md), [ADR-0789](adr/0789-a-conflict-is-a-mark-on-its-note-resolved-in-the-repair-editor.md), [ADR-0807](adr/0807-an-app-writes-only-to-a-local-store-and-only-sync-talks-to-a-server.md)). |
| Commit or version | A fixed Git snapshot in a folder's repository on the server. Prefer commit in technical text; version can explain it in a UI. A file's version in a store is its blob id, a different use of the word. |
| History | The commits the server's repository holds, reached with `epicenter log`, `diff`, and `restore`, or with plain `git clone` of `<git audience>/folders/<id>.git`. Overwritten intermediate saves need not be recoverable. |
| Snapshot | The file state described by a commit; retaining that snapshot does not require retaining every ancestor. |
| Ref, head, base | A Git pointer, the repository's `main`, and the agreed commit or blob a merge reads. |
| Git object, tree, blob | Content-addressed Git data: commit metadata, directory entries, and file bytes. An item's version is its blob id; an attachment's is the blob id of its LFS pointer. |
| Cache | Data rebuilt without losing saved work, such as the manifest and an attachment's hash stamps in `.epicenter/`. Unlanded edits are not caches. |
| Replica | The page's copy of one folder: the text of each contract note, and the path, version, and size of every other file, fed by the paths that changed ([ADR-0778](adr/0778-a-page-connects-once-and-then-reads-synchronously.md)). It is not an extra product component. |

A folder's write (`set`, `delete`, an editor's save) reads the file just
before writing it and puts over exactly what it read; when the file moved in
between, it reads and applies the change again. The fields a write names take
it, and a body changed since the folder showed the item merges by lines with
`settle` ([ADR-0774](adr/0774-one-write-makes-it-so-and-settles-a-change-the-way-sync-does.md)).
A write never fails: the folder keeps it, in order, until it lands, and
`folder.unavailable()` says why it waits
([ADR-0775](adr/0775-a-write-never-fails-the-folder-keeps-it-until-it-lands.md)).

A Svelte view binds its controls to the open item's editor (`notes.edit`),
which shows each typed field until its save lands, then follows the folder
again. Writes waiting for the store live in the page's memory and do not
survive a crash; the leave guard asks before the page closes. See [the folder package](../packages/folder/README.md)
and [the Svelte adapter](../packages/svelte/README.md).

During a sync, an item both sides changed merges against the version both last
agreed on, read from the server by its blob id. The server merges nothing: it
refuses a commit over a blob the repository no longer holds, and the sync reads
what is there and runs again
([ADR-0773](adr/0773-a-folder-opens-at-a-place-every-place-is-a-store-and-the-server-never-merges.md)).
Two syncs of one folder may run at once: every write, the manifest's
included, is over the version read, so neither loses an edit
([ADR-0805](adr/0805-a-folder-is-recognized-by-epicenter-json-which-is-its-contract.md)).
A sync never silently loses an edit: a rename beside an edit leaves both
items, and a deleted item edited elsewhere returns
([ADR-0806](adr/0806-an-open-app-checks-for-changes-and-a-sync-never-silently-loses-an-edit.md)).
`epicenter sync` stops, with exit code 1 when a person must run it again or a
copy asks, and 2 when it could not sync.

## Sharing and access

| Name | Meaning |
| --- | --- |
| Member, role | A person who accepted a folder, and what they may do: a member changes files, shares, unshares, and changes roles; a reader syncs without pushing and manages nothing. No member owns a folder, and a folder lives while any member remains ([ADR-0820](adr/0820-a-share-is-an-invitation-to-an-email-and-reaching-every-folder-is-a-permission.md)). The code still has `owner`, `writer`, and `reader`; the change is pending. |
| Share, invitation | A share names an email and waits as an invitation until a person with that email accepts it; it grants nothing before, and the server answers the same whether or not the email has an account. `epicenter share`, `unshare`, and `accept`. **Direction:** an invitation to an email with no account, accepted at sign-up. |
| Attach | Recording that an app reaches a folder: made when an app's first sync creates the folder, or when a person chooses "Use this folder with" an app (`epicenter attach`). `$id` or contract content authorizes nothing ([ADR-0811](adr/0811-folders-are-shared-directly-and-an-app-reaches-the-folders-attached-to-it.md)). |
| Reach, `folders:all` | An app's token reaches the folders attached to it. A token with the scope `folders:all` (the CLI and the Epicenter app) reaches every folder its person holds, and only such a program attaches a folder to an app. The other folder scopes are `folders:read` and `folders:write`. **Direction:** consent shows `folders:all`. |
| Grant, consent, scope, audience | Permission, its approval, allowed operations, and the service accepting a token. Qualify folder grants, account grants, and inference authorization. |
| Credential, token, provider key | Authentication material, retained outside synchronized data. It does not identify a folder. **Direction:** on the desktop each app keeps its secrets in its own credentials file in AppData, read by the request that uses it and never by the page ([ADR-0783](adr/0783-a-secret-lives-in-the-apps-credentials-file-and-is-read-by-the-request-that-uses-it.md)). |
| Account or principal | The person's service account, or the precise authenticated identity where technical code uses principal. A desktop app's folder needs neither; a web app needs the account. Each capability handed the account says what it needs (`repository`, `ai`, or `profile`), and sign-in asks for exactly those ([ADR-0792](adr/0792-an-account-asks-for-what-the-capabilities-that-take-it-need.md)). The code's `repository` need is a folder on the server. |
| Web origin | The web app's settings storage and OAuth client boundary. It is distinct from Git's remote named `origin`. |
| Deployment | A hosted or self-hosted service installation. A folder syncs only with an Epicenter deployment. Hosted-only billing stays in `apps/api/worker/billing/`. |
| Inference provider | The service or local model used for AI work. Its configuration is independent of a folder and its sharing. |
| Inference or transcription | AI processing of selected inputs; transcription produces text from audio. It does not imply attachment synchronization. |
| Allowance, usage, credits, billing | Hosted service entitlement and accounting, independent of folder saves. |
| Authority | The source that controls accepted state where an implementation uses this precise term. |

Avoid unqualified connection and host when their roles affect behavior. Name the
sync destination, inference provider, runtime, or grant involved. Reserve generic
browser for no product: say web browser for the runtime and Epicenter app for
the native product.

Host is a qualified technical role: a runtime can host an app, a Git service
hosts repositories, and a deployment hosts services. Shell names runtime
integration when that mechanism matters.

Record can explain an item to a person; it does not introduce a second stored
object. Workspace should not become an alias for a folder or local selection.
Name the actual object unless a separate grouping feature exists. Whispering's
`Workspace` supplies platform capabilities beside the opened folder: capture,
inference, connections, preferences, and recording recovery. It holds no
folder or closing lifetime.

## Current implementation names

These names distinguish the public app API from internal storage. Historical
terms in accepted ADRs do not create additional current APIs.

| Source | Names and current behavior |
| --- | --- |
| `@epicenter/folder` places | `openFolder(contract, place)` from `@epicenter/folder`, over a contract from `@epicenter/definition/contract`, at `home({ site, account })` (chosen when the page runs: the desktop's Data root in a Tauri window, the folder attached to the app on the server in a browser), `directory(path)` from `/node`, `served(url)` from `/served`, or `memory()` from `/memory` in a test. |
| `@epicenter/folder` platform | `listHome`, `initFolder`, `syncFolder`, `cloneFolder`, `cloneIntoHome`, `acceptIntoHome`, `syncEvery`, `listFolders`, `getFolder`, `folderHeads`, `shareFolder`, `unshareFolder`, `acceptShare`, and `attachFolder`, from `@epicenter/folder/platform`. |
| CLI | Built: `auth`, `check`, `format`, `status`, `init`, `sync`, `clone`, `log`, `diff`, `restore`, `share`, `unshare`, `accept`, `attach`, `detach`, and `messages`. **Direction:** `query`, `set`, `edit`, `delete`, `normalize`, and `mcp` arrive, and `format` goes ([ADR-0790](adr/0790-the-epicenter-app-is-a-library-over-every-folder-and-the-cli-answers-its-queries.md), [ADR-0797](adr/0797-front-matter-is-a-strict-grammar-and-anything-else-is-body.md), [ADR-0799](adr/0799-a-folders-contract-is-also-an-mcp-server.md)). |
| Server | A folder's routes at `<git audience>/folders/<id>` and `/api/folders`, in `packages/server` ([ADR-0811](adr/0811-folders-are-shared-directly-and-an-app-reaches-the-folders-attached-to-it.md)). |
| `AGENTS.md` | A desktop app's data folder still gets an `AGENTS.md` whose front matter has a `contract:` key, which `epicenter check` reads. ADR-0805 decided an `AGENTS.md` with no front matter and a contract in `epicenter.json`; the code has not caught up. |
| Stored records | Existing fields such as `recordingId` retain their names and values. A noun cleanup is not a data-format migration. |

## Retired terms

A retired term may still appear in code, in accepted records, and in Rust
comments. Do not use it for the current concept.

| Retired | Use | Retired by |
| --- | --- | --- |
| space, space switcher, `contract.json` | folder; a folder picker went too, and the contract is `epicenter.json` | [ADR-0811](adr/0811-folders-are-shared-directly-and-an-app-reaches-the-folders-attached-to-it.md), [ADR-0805](adr/0805-a-folder-is-recognized-by-epicenter-json-which-is-its-contract.md) |
| team, namespace, repository grant | member of a folder, with a role | [ADR-0811](adr/0811-folders-are-shared-directly-and-an-app-reaches-the-folders-attached-to-it.md) |
| group (of people that folders are shared with) | sharing managed by person | [ADR-0811](adr/0811-folders-are-shared-directly-and-an-app-reaches-the-folders-attached-to-it.md) |
| library, library root | Epicenter app, Epicenter folder | [ADR-0816](adr/0816-the-epicenter-app-is-where-a-person-sees-and-manages-every-folder.md) |
| the app as an owner of a folder or its contract, `$id` | an app is a view that must fit | [ADR-0812](adr/0812-an-apps-schema-is-a-view-that-must-fit-a-folders-contract.md) |
| table, row, row id, row directory | collection, item, item name; files sharing a name are one item | [ADR-0818](adr/0818-an-app-is-a-view-a-window-and-its-capabilities-and-everything-is-repairable-by-hand.md), [ADR-0802](adr/0802-people-share-spaces-an-app-works-in-one-at-a-time-and-a-folder-carries-its-contract.md) |
| round | sync | [ADR-0802](adr/0802-people-share-spaces-an-app-works-in-one-at-a-time-and-a-folder-carries-its-contract.md) |
| note, for an entry of a collection | item (the code still says note) | [ADR-0802](adr/0802-people-share-spaces-an-app-works-in-one-at-a-time-and-a-folder-carries-its-contract.md) |
| `{id}` in a path pattern | `{name}` (the code still says `{id}`) | [ADR-0818](adr/0818-an-app-is-a-view-a-window-and-its-capabilities-and-everything-is-repairable-by-hand.md) |
| sync core, libgit2, the Node-API addon, the merge driver, a folder's `.git`, a sync lock | `sync` over stores and a manifest | [ADR-0804](adr/0804-a-computer-keeps-a-plain-folder-and-every-surface-syncs-with-one-typescript-function.md), [ADR-0805](adr/0805-a-folder-is-recognized-by-epicenter-json-which-is-its-contract.md) |
| a Git remote or `origin` as the sync destination, GitHub and GitLab sync | the Epicenter server's repository | [ADR-0803](adr/0803-clients-sync-only-with-epicenter-servers-and-sync-is-a-function-of-two-stores.md) |
| folder declaration, `epicenter.synced` | a folder's `epicenter.json`; every directory in the Epicenter folder is a folder | [ADR-0805](adr/0805-a-folder-is-recognized-by-epicenter-json-which-is-its-contract.md), [ADR-0813](adr/0813-epicenter-is-your-folders-and-apps-are-lenses.md) |

For the full dated inventory and the review's accepted and rejected collapses,
see the [October vocabulary audit](vocabulary-audit-2026-10-19.md).
