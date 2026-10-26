# Context: shared vocabulary

Epicenter is a toolkit for local-first apps over files, with optional Git
synchronization and inference. Apps open local data before sign-in. The CLI
can inspect ordinary files. The Epicenter desktop app offers Files, grid,
board, saved views, read-only SQL, and a fixed set of bundled apps. A
personal-tool runner remains future work.

Use these names for the current API and the named remaining work. Source names
in the implementation table remain exact. Package READMEs describe the available
entry points; ADRs retain the decisions and their amendment history.
<!-- vocab-check: ignore-next-line (historical ADR filename) -->
The decisions are in [ADR-0584](adr/0584-each-concept-has-one-noun-in-code-on-the-wire-and-in-prose.md),
[ADR-0632](adr/0632-a-lens-belongs-to-its-reader.md),
[ADR-0633](adr/0633-apps-open-local-data-before-connecting-services.md),
[ADR-0634](adr/0634-hosted-inference-is-independent-of-repository-sync.md),
[ADR-0635](adr/0635-generic-desktop-data-tools-are-deferred.md),
[ADR-0636](adr/0636-an-app-opens-local-files-through-one-folder-handle.md),
[ADR-0641](adr/0641-epicenter-remembers-folders-as-machine-local-paths.md), and
[ADR-0642](adr/0642-each-desktop-app-selects-its-cli-independently-of-the-terminal.md).

## Data and locations

| Name | Meaning |
| --- | --- |
| Epicenter | The toolkit and optional hosted services. It does not name one person's body of data. |
| Local dataset | The local data selected by an app, with identity independent of account, remote URL, or hosted repository ID. Say "local data" in ordinary explanations. |
| Folder handle | The public `Folder`: one opened lifetime over rooted local paths and contents, on disk or in browser-private storage. A caller may open several handles. |
| Directory | A physical filesystem location. In ordinary explanations, folder can name a disk directory; qualify a browser folder when its private storage matters. |
| Remembered path | An optional machine-local shortcut shared by Epicenter desktop and CLI. It grants no access and does not configure where a standalone app saves. |
| Repository | A Git repository; repo is its shorthand, not another concept. A hosted repository also has a stable service ID, a changeable label, and membership. |
| Clone | An independent local copy of a repository. Different web origins can keep separate clones of the same repository. |
| Remote or sync destination | The Git endpoint configured for synchronization. The remote URL does not identify the local dataset or grant access to it. |
| Table | A reader's view of immediate Markdown rows in one named top-level directory. Apps or selected schemas name tables; marker files do not. |
| Row | One table's `<id>.md` file, interpreted as frontmatter fields and a Markdown body. |
| Row id | The filename segment without `.md`, addressed within its table. It can change on rename; a hosted repository ID has a different stability contract. |
| Row directory | Optional adjacent files under `<table>/<id>/`. Deleting the Markdown row leaves these files in place. It is not a nested table. |
| Field, value, body | A frontmatter key, its complete value, and the Markdown text after frontmatter. |
| File, path, root | Source bytes, their address relative to opened data, and that address's boundary. File access remains available outside selected tables. |
| Reference | A value interpreted by its app's format, or a literal Markdown link. Existing record IDs remain; automatic cross-repository navigation is deferred. |

Browser local data lives in IndexedDB under its web origin. It is not an
ordinary folder that another app origin or desktop editor can open. Disk data
can be shared by cooperating clients at the same path. Connected copies on
different origins meet through Git synchronization.

`openFolder({ tables })` opens the browser origin's local default or the
existing directory bound to a native window. Bun receives an explicit
`directory` path. Native defaults are fixed reverse-DNS children of one library
root, `~/Epicenter` in release and `~/Epicenter Dev` in development. Standalone
and hosted Todos share `so.epicenter.todos`; Epicenter's records use
`so.epicenter`. Ordinary launch creates or reuses that default. A missing bound
or explicitly chosen directory is refused. There is no first-use path selection
or independently configurable app home (ADR-0672).

AppData's machine-local `bookmarks.json` stores a JSON array of folder paths.
`epicenter folders add|list|forget` edits that list under the same save lock as
desktop. Earlier `folders.json` selections and shortcuts are not read or
migrated. Scanned library children need no bookmark. Forgetting removes no data
and changes no Git remote or live editor.
A CLI `open <directory>` command remains unbuilt. A data folder's
`epicenter.json` has the separate portable declaration role described next.

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
| Folder declaration | The portable root `epicenter.json`, with independently optional `tables` and saved `views`. CLI `check` and `query` require its table schemas. The document schema is distinct from the row schemas it contains. |
| Reader or writer | A role performed by an app, CLI, or agent, not another product or data owner. |
| Issue or diagnostic | A specific parsing or schema problem, with its source. A schema disagreement is distinct from unparseable source or a storage failure. |
| View | A presentation of data. Selecting another schema changes interpretation, not saved files or draft ownership. |
| Saved view | A grid, board, or SQL configuration in the folder declaration. An opaque key identifies it; its display title can change. View settings travel with the folder, without a personal override. |
| Query projection | Derived query data, such as an in-memory SQLite table built from files and selected schemas. It is not another durable data owner. |

Apps supply their own read schemas and need no schema file. In v1, CLI
`check` and `query` require `<folder>/epicenter.json`, which supplies their
shared table interpretation. A person explicitly imports an app's exported
schemas or authors them in the file. Apps never publish it by
opening or saving. A committed copy restores the CLI interpretation on clone.

Missing metadata blocks schema-aware table commands, not Git history, app
opening, or ordinary file access. Row schemas grant no access and choose no merge policy. They
execute no code and fetch no external references. Git operations interpret no
declaration sections. Tracked files remain tracked; untracked files enter
commits unless Git ignores them. The folder's `.gitignore` files travel as
ordinary content, and native Git also honors machine-specific excludes. Schema
disagreements retain raw source.

ADR-0648 records optional table schemas, shared saved views, and explicit
app-schema import. The canonical TypeBox format, whole-table readers,
section-preserving writers, schema exchange, grid, board, saved-view settings,
and desktop SQL are implemented. Grid and board configurations name a top-level
directory without requiring a schema. They retain column choices, filters, and
sort rules. Grid cells and board moves share the editor's existing file drafts;
moving a card edits its grouping field without a separate rank record.
SQL results remain read-only. Explicitly saving the first view can create a
declaration containing only `views`.

Clean view settings follow saved changes; unfinished settings remain owned by
the window until submitted or reloaded. A submission transforms the current
`epicenter.json` editor text, preserving sibling entries, then immediately
replaces and saves that same source. Raw and structured submissions share the
file owner and publication lane. Assignments have no source precondition.
Invalid and future entries retain source and diagnostics. The transform is
portable; the generic editor remains a desktop product surface.

A schema-distribution service remains unbuilt. Existing app callers use Folder;
migration of older stored browser data is separate. The CLI retains its
required-schema `check` and `query`, plus executable `epicenter.ts` generation,
with generation preserving unrelated declaration sections.

Use schema for row expectations and declaration for the whole portable
`epicenter.json` document. Retire lens, description, and shape as competing
domain names for those expectations. "Describe" remains an ordinary verb. Without a selected
schema, a reader can inspect stored values but gives no app-specific validity
verdict. Schema selection is independent of storage, identity, and credentials.

## Changes and Git

| Name | Meaning |
| --- | --- |
| Draft or unsaved input | One complete source accepted by the folder for publication. A save acknowledges only the input it captured, by identity; newer input stays dirty even when its text equals an earlier submission. |
| Save | Acknowledged local persistence of an edit. It does not promise a Git commit or remote receipt. |
| Write | A file or storage operation, as in `files.write`. It is not a second kind of dataset or an automatic upload. |
| Commit or version | A fixed Git snapshot. Prefer commit in technical text; version can explain it in a UI. |
| Sync | Exchange commits with the remote and merge changes. It can run after local saves. |
| Merge | Combine base, current, and change by frontmatter field or text region. Schemas do not choose merge behavior. |
| History | The commits Git records. Overwritten intermediate saves need not be recoverable. |
| Snapshot | The file state described by a commit; retaining that snapshot does not require retaining every ancestor. |
| Ref, head, base | A Git pointer, the selected local commit, and the incorporated remote commit or merge input where qualified. |
| Git object, tree, blob | Content-addressed Git data: commit metadata, directory entries, and file bytes. A Git blob is not a managed audio attachment. |
| Revision | The local publication counter used to reject stale browser computations. It is not a Git commit. |
| Transaction or publication | Atomic storage work that acknowledges local state. This publication is unrelated to the retired app-owned schema publication. |
| Cache | Data rebuilt without losing saved work. Unsent edits and uncertain pending commits are not caches. |

A Folder shows what storage last returned or accepted; a draft holds what a
person typed until that text's save lands. `folder.files()` and table rows are
landed values. Each `write`, `update`, `create`, or `delete` joins one serial
queue and answers after its unconditional put lands and the mirror shows it,
or with a `WriteError`. A row update composes over the file as it stands when
the operation runs. It preserves unrelated values but rewrites frontmatter
canonically. Local writes do not merge against outside writers. Git sync
retains its separate three-way merge and conditional storage publication.

A Svelte editor creates one `draft(source, save)` for its input. The draft
shows typed text until the corresponding write answers, then follows the
Folder again. A failed save retains that text and its error beside the
control for retry or discard. Mounted drafts flush on teardown and page
departure. The Folder has no working document or aggregate save status; its
`saving()` value reports queued and active writes. `close()` refuses new
writes, drains admitted work, then releases storage. In-memory drafts do not
survive a crash. See [the folder package](../packages/folder/README.md) and
[the Svelte adapter](../packages/svelte/README.md).

During sync, the same merge roles describe a base tree, the fetched remote
tree, and the local tree being merged. These are roles in Epicenter's merge, not Git's
`ours` and `theirs` names.

Native sync applies the file merge again when it publishes the computed tree
to a directory. At that point `base` is the file captured in the local
checkpoint, `current` is the file in the computed merge tree, and `change` is
the live directory file. The live file takes the winning role because a person
or agent may have edited it while sync ran. The native host still checks each
replacement and retains its interrupted-publication marker; those protect the
directory handoff rather than define another content merge policy.

The planned app-facing synchronization states are `local`, `synced`, `pending`,
`disconnected`, and `stuck`. Local means no destination is configured. The
remaining states describe a configured synchronization connection, independently
of local saving. The Folder exposes only local `saving()`; it does not expose those network states.

## Clients, services, and access

| Name | Meaning |
| --- | --- |
| App | A program using its own read schemas. Qualify a web app or desktop app when runtime or native capabilities matter. |
| CLI | The `epicenter` executable. Its package entry points and commands are documented by the CLI package. |
| Agent or person | A direct file writer. Apps and external writers follow last whole-file publication wins; the folder retains accepted app input independently of outside changes. |
| Epicenter desktop app | The app in `apps/epicenter`: a folder launcher, generic Files/grid/board/SQL editor with saved views, Settings, and host for fixed bundled apps. Host app, desktop host, and launcher are not additional products. It is optional to standalone apps and the CLI. |
| Runner | A deferred capability of the Epicenter desktop app: opening built local websites over selected disk data. It is not another app or required platform layer. |
| Web origin | The web app's storage and OAuth client boundary. It is distinct from Git's remote named `origin`. |
| Runtime or shell | The environment executing an app or providing native mechanisms. Qualify a Git host or inference host separately. |
| Deployment | A hosted or self-hosted service installation. Hosted-only billing stays in `apps/api/worker/billing/`. |
| Account or principal | The person's service account, or the precise authenticated identity where technical code uses principal. Neither is required for local data use. |
| Membership, owner, member | A hosted repository's access list and roles. Removing membership does not recall existing copies. |
| Grant, consent, scope, audience | Permission, its approval, allowed operations, and the service accepting a token. Qualify repository grants, account grants, and inference authorization. |
| Credential, token, provider key | Authentication material, retained outside synchronized data. It does not identify a local dataset. |
| Inference provider | The service or local model used for AI work. Its configuration is independent of a Git remote and repository permission. |
| Inference or transcription | AI processing of selected inputs; transcription produces text from audio. It does not imply attachment synchronization. |
| Allowance, usage, credits, billing | Hosted service entitlement and accounting, independent of repository saves. |
| Replica, authority | A copy and the source that controls accepted state where an implementation uses these precise terms. They are not extra product components. |

Avoid unqualified connection and host when their roles affect behavior. Name the
sync destination, inference provider, runtime, or grant involved. Reserve generic
browser for no product: say web browser for the runtime and Epicenter desktop
app for the native product.

ADR-0642 separates each app's matched private CLI from explicit public-command
installation. Executable selection grants no access to another app's session.
Shared files and credentials still require compatible protocols; CLI selection
does not select a data folder.

Host is a qualified technical role: a runtime can host an app, a Git service
hosts repositories, and a deployment hosts services. Hosting an app does not
make host app a second product. Shell names runtime integration when that
mechanism matters. Launcher describes opening an app; it adds no component.

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
| `@epicenter/folder` | Public `openFolder`, `Folder`, and `Row.id` across root, `/browser`, `/tauri`, and `/bun`. Apps supply TypeBox row schemas and neither read nor publish a declaration when opening. Older `defineFolder`, `Definition`, and `stem` remain in the Bun CLI tools. |
| `@epicenter/folder` browser engine (`src/browser/`) | Internal `openRepository`, `LocalRepository`, caller-supplied `schemas`, and `Row.id`. It has no package entry point; only `openFolder({ tables })` reaches it. |
| `@epicenter/folder/declaration` | Canonical portable schema, `SavedView`, `readSavedViews`, and explicit app `exportTables`. The pure `changeSavedView` transform composes into the same declaration file editor used for raw text. |
| CLI | Implemented commands include `auth`, `folders add|list|forget`, `schema export|import`, `generate`, and `save-version`. The source-installed `app` command group is removed. External-schema flags and CLI `open` remain deferred. |
| Stored records | Existing fields such as `recordingId` retain their names and values. A noun cleanup is not a data-format migration. |

For the full dated inventory and the review's accepted and rejected collapses,
see the [October vocabulary audit](vocabulary-audit-2026-10-19.md).
