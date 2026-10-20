# Context: shared vocabulary

Epicenter is a toolkit for local-first apps over files, with optional Git
synchronization and inference. Apps open local data before sign-in. The CLI
can inspect ordinary files. The Epicenter desktop app offers Files, a generic grid, read-only SQL, and
a fixed set of bundled apps. Saved views, boards, and a personal-tool runner
remain future work.

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
`directory` path. Standalone Todos uses its application data directory;
Epicenter chooses each hosted window's directory. A missing bound or explicitly
chosen directory is refused. Current launch policy can create fixed defaults;
first-use tracking across launches remains separate work.

AppData's machine-local `folders.json` stores an `epicenter` records-location
pointer and a `folders` shortcut list. `epicenter folders add|list|forget` edits
that list under the same save lock as desktop. Scanned root children need no
shortcut. Forgetting removes no data and changes no Git remote or live editor.
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
| Folder declaration | The portable root `epicenter.json`. Current CLI readers require its table schemas; ADR-0648 adds independently optional `tables` and saved `views`. The document schema is distinct from the row schemas it contains. |
| Reader or writer | A role performed by an app, CLI, or agent, not another product or data owner. |
| Issue or diagnostic | A specific parsing or schema problem, with its source. A schema disagreement is distinct from unparseable source or a storage failure. |
| View | A presentation of data. Selecting another schema changes interpretation, not saved files or draft ownership. |
| Query projection | Derived query data, such as an in-memory SQLite table built from files and selected schemas. It is not another durable data owner. |

Apps supply their own read schemas and need no schema file. In v1, CLI
`check` and `query` require `<folder>/epicenter.json`, which supplies their
shared table interpretation. A person obtains it from a registry or authors
it, then copies it into the folder deliberately. Apps never publish it by
opening or saving. A committed copy restores the CLI interpretation on clone.

Missing metadata blocks those two CLI commands, not app opening or ordinary
file access. Row schemas grant no access and choose no merge policy. They
execute no code and fetch no external references. The declaration's `local`
patterns have a different purpose: current CLI history reads them to exclude
private files from commits. Unusable table schemas must not disable those
rules. Schema disagreements retain raw source.

ADR-0648 records optional table schemas, shared saved views, and explicit
app-schema import. The canonical TypeBox format, whole-table readers, section-preserving writers,
explicit schema exchange, grid, and desktop SQL are implemented. Saved-view
persistence, board presentation, and a schema-distribution service remain open. Existing app callers already use Folder;
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
| Draft or unsaved input | What the person is editing before an acknowledged local save. It retains the exact source the edit started from. |
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

For a local save, the merge's `base` is the caller's `from`: the exact source
that save started from. `current` is the file captured from local storage for
that attempt. `change` is the complete file the caller submitted. A table's
public `set(id, from, change)` takes a partial row change; it builds that
complete file before merging. The returned `sent` is the submitted row for the
draft's next `from`, not necessarily the merged file now stored. During sync,
the same merge roles describe a base tree, the fetched remote tree, and the
local tree being merged. These are roles in Epicenter's merge, not Git's
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
of local saving. The current public `Folder.status` reports `saving` and
`storageFailure`; it does not expose those network states.

## Clients, services, and access

| Name | Meaning |
| --- | --- |
| App | A program using its own read schemas. Qualify a web app or desktop app when runtime or native capabilities matter. |
| CLI | The `epicenter` executable. Its package entry points and commands are documented by the CLI package. |
| Agent or person | A direct file editor. Its writes do not automatically acquire the app's save witness or merge protocol. |
| Epicenter desktop app | The app in `apps/epicenter`: a folder launcher, Files editor, Settings, and host for fixed bundled apps. Host app, desktop host, and launcher are not additional products. It is optional to standalone apps and the CLI. |
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
Whispering's existing `Workspace` is an app session that combines its folder,
capture device, inference, connections, preferences, and closing lifetime. It
is not another data store and should not be renamed to folder.

## Current implementation names

These names distinguish the public app API from older CLI authoring tools and
internal browser storage. Historical terms in accepted ADRs do not create
additional current APIs.

| Source | Names and current behavior |
| --- | --- |
| `@epicenter/folder` | Public `openFolder`, `Folder`, and `Row.id` across root, `/browser`, `/tauri`, and `/bun`. Apps supply TypeBox row schemas and neither read nor publish a declaration when opening. Older `defineFolder`, `Definition`, and `stem` remain in the Bun CLI tools. |
| `@epicenter/folder` browser engine (`src/browser/`) | Internal `openRepository`, `LocalRepository`, caller-supplied `schemas`, and `Row.id`. It has no package entry point; only `openFolder({ tables })` reaches it. |
| CLI | Implemented commands include `auth`, `folders add|list|forget`, `generate`, and `save-version`. The source-installed `app` command group is removed. External-schema flags and CLI `open` remain deferred. |
| Stored records | Existing fields such as `recordingId` retain their names and values. A noun cleanup is not a data-format migration. |

For the full dated inventory and the review's accepted and rejected collapses,
see the [October vocabulary audit](vocabulary-audit-2026-10-19.md).
