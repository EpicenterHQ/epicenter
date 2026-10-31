# Context: shared vocabulary

Epicenter is a toolkit for local-first apps over files, with optional Git
synchronization and inference. Apps open local data before sign-in. The CLI
can inspect ordinary files. The Epicenter desktop app manages folders: it
registers, syncs, shares, and shows the status of folders, and offers Files,
grid, board, saved views, and read-only SQL over them. Apps are separate
programs; Epicenter does not host them ([ADR-0701](adr/0701-apps-run-as-separate-programs.md)).

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
| Clone | An independent local copy of a repository. A desktop folder registered with `epicenter init` is a clone; a web app never holds one. |
| Remote or sync destination | The Git endpoint configured for synchronization. The remote URL does not identify the local dataset or grant access to it. |
| Table | A reader's view of immediate Markdown rows in one named top-level directory. Apps or selected schemas name tables; marker files do not. |
| Row | One table's `<id>.md` file, interpreted as frontmatter fields and a Markdown body. |
| Row id | The filename segment without `.md`, addressed within its table. It can change on rename; a hosted repository ID has a different stability contract. |
| Row directory | Optional adjacent files under `<table>/<id>/`. Deleting the Markdown row leaves these files in place. It is not a nested table. |
| Field, value, body | A frontmatter key, its complete value, and the Markdown text after frontmatter. |
| File, path, root | Source bytes, their address relative to opened data, and that address's boundary. File access remains available outside selected tables. |
| Reference | A value interpreted by its app's format, or a literal Markdown link. Existing record IDs remain; automatic cross-repository navigation is deferred. |

Browser local data lives under its web origin: in the origin's private file
system for a contract's `openDevice`, or in IndexedDB for the legacy
`openFolder`. It is not an ordinary folder that another app origin or desktop
editor can open. Disk data can be shared by cooperating clients at the same
path. The web never syncs. An app has up to three variants, each with one
store for its life: desktop (the folder, synced only by `epicenter sync`),
local web (this browser's files, for good), and online web (the repository
through the server, online only). Nothing moves between stores, and signing
in grants capabilities, never storage ([ADR-0700](adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)).

Only a variant's root chooses its store. A desktop app on
`epicenter-standalone` opens two roots in its root startup component:
`openAppData(settings)`, the app's operating-system AppData directory
(machine-local, never synced), then `openDataFolder(contract, { appData })`,
the `folder` its `settings.md` names or `~/Epicenter/<productName>` by
default. Only the default is made when missing; a root that cannot open shows
a recovery screen, never another folder, and there is no first-run question
([ADR-0701](adr/0701-apps-run-as-separate-programs.md)). A local web variant
awaits `openDevice(contract)` over the origin's private file system; an
online web variant opens the repository with `openRemote`.

The legacy `openFolder({ tables })` remains for Epicenter's own windows and
Bun, which passes an explicit `directory`. Epicenter's records keep the
library's fixed reverse-DNS default, `so.epicenter` under `~/Epicenter`
(`~/Epicenter Dev` in development)
([ADR-0672](adr/0672-native-app-defaults-are-fixed-reverse-dns-children-of-one-library.md)).

The folders Epicenter syncs are the global Git configuration's multi-valued
`epicenter.folder`, which `epicenter init`, `clone`, and `forget` change; the
desktop's Folders window runs those commands, and no AppData file lists
folders. A CLI `open <directory>` command remains unbuilt. A data folder's
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
| Contract | An app's file layout: collections of notes (`.md`, front matter fields plus a body) and files at path templates such as `recordings/{id}.md`, written with `defineContract` and published as JSON. `epicenter check` and `epicenter format` take one as a URL or a file path; a folder holds no copy. |
| Folder declaration | The legacy portable root `epicenter.json`, with independently optional `tables` and saved `views`. CLI `query` requires its table schemas. The document schema is distinct from the row schemas it contains. |
| Reader or writer | A role performed by an app, CLI, or agent, not another product or data owner. |
| Issue or diagnostic | A specific parsing or schema problem, with its source. A schema disagreement is distinct from unparseable source or a storage failure. |
| View | A presentation of data. Selecting another schema changes interpretation, not saved files or edit ownership. |
| Saved view | A grid, board, or SQL configuration in the folder declaration. An opaque key identifies it; its display title can change. View settings travel with the folder, without a personal override. |
| Query projection | Derived query data, such as an in-memory SQLite table built from files and selected schemas. It is not another durable data owner. |

Apps supply their own read schemas and need no schema file. CLI `query`
requires `<folder>/epicenter.json`, which supplies its table interpretation;
`check` and `format` take an app's contract instead. A person explicitly imports an app's exported
schemas or authors them in the file. Apps never publish it by
opening or saving. A committed copy restores the CLI interpretation on clone.

Missing metadata blocks schema-aware table commands, not Git history, app
opening, or ordinary file access. Row schemas grant no access and choose no merge policy. They
execute no code and fetch no external references. Git operations interpret no
declaration sections. Tracked files remain tracked; untracked files enter
commits unless Git ignores them. The folder's `.gitignore` files travel as
ordinary content, and native Git also honors machine-specific excludes. Schema
disagreements retain raw source.

ADR-0648 records optional table schemas and shared saved views. The canonical
TypeBox format, whole-table readers, grid, board, saved-view settings, and
desktop SQL are implemented; schema exchange and `epicenter query` are deleted
(decision 72). Grid and board configurations name a top-level
directory without requiring a schema. They retain column choices, filters, and
sort rules. Grid cells and board moves share the editor's existing file edits;
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
required-schema `query`; `epicenter generate` is deleted.

Use schema for row expectations and declaration for the whole portable
`epicenter.json` document. Retire lens, description, and shape as competing
domain names for those expectations. "Describe" remains an ordinary verb. Without a selected
schema, a reader can inspect stored values but gives no app-specific validity
verdict. Schema selection is independent of storage, identity, and credentials.

## Changes and Git

| Name | Meaning |
| --- | --- |
| Edit or unsaved input | Text an editor holds after the person typed it and until its save lands. The folder shows only what landed; a failed save keeps the edit on screen for retry, discard, or copy. |
| Save | Acknowledged local persistence of an edit. It does not promise a Git commit or remote receipt. |
| Write | A file or storage operation. Folder `write` creates or replaces a whole file, while `replace` requires an existing file. It is not a second kind of dataset or an automatic upload. |
| Commit or version | A fixed Git snapshot. Prefer commit in technical text; version can explain it in a UI. |
| Sync | `epicenter sync`: commit a registered folder's files with `git add`, fetch, merge, and push. It is the only desktop committer; the server commits web writes. Apps never commit. |
| Merge | Combine base, current, and incoming (the later arrival): a front matter key goes to the later arrival; the body merges by line, then by word; an edit beats a delete. Schemas do not choose merge behavior. |
| Conflict block, conflict copy | What a merge leaves when both sides changed the same spot: one block of whole lines in a note's body, or, for a binary file, the later bytes beside it as `<stem> (conflict <hash7>).<ext>`. Both are ordinary file content. |
| History | The commits Git records. Overwritten intermediate saves need not be recoverable. |
| Snapshot | The file state described by a commit; retaining that snapshot does not require retaining every ancestor. |
| Ref, head, base | A Git pointer, the selected local commit, and the incorporated remote commit or merge input where qualified. |
| Git object, tree, blob | Content-addressed Git data: commit metadata, directory entries, and file bytes. A Git blob is not a managed audio attachment. |
| Revision | The local publication counter used to reject stale browser computations. It is not a Git commit. |
| Transaction or publication | Atomic storage work that acknowledges local state. This publication is unrelated to the retired app-owned schema publication. |
| Cache | Data rebuilt without losing saved work. Unlanded edits and uncertain pending commits are not caches. |

A Folder shows what storage last returned or accepted; an edit shows what a
person typed until that text's save answers. `folder.files()` and table rows are
landed values. Each `write`, `replace`, `update`, `create`, or `delete` joins one serial
queue and answers after its put lands and the mirror shows it,
or with a `WriteError`. A row update composes over the file as it stands when
the operation runs. It preserves unrelated values but rewrites frontmatter
canonically. Updates make up to three checked attempts, then fail if the file
keeps changing. A whole-file write replaces the file at its turn; `replace`
refuses if the file was deleted. Later writes win on the same field, body, or
whole-file unit. A Folder runs no Git merge; `epicenter sync` does.

A Svelte editor creates one `edit(source, save)` for its input. Its
`save(value)` receives each typed value. The edit shows typed text until the corresponding
write answers, then follows the
Folder again. A failed save retains that text and its error beside the
control for retry or discard. Each typed value enters the queue immediately;
teardown sends nothing more. The Folder has no working document or aggregate
save status; its `saving()` value reports queued and active writes. `close()`
refuses new writes, drains admitted work, then releases storage. In-memory
edits do not survive a crash. See [the folder package](../packages/folder/README.md) and
[the Svelte adapter](../packages/svelte/README.md).

During `epicenter sync`, stock `git merge` runs `epicenter merge-driver` on
each note both sides changed. `base` is the common ancestor, `current` the
side that reached the server first, and `incoming` the later arrival (`%A`
under a merge, `%B` under a rebase). These are roles in Epicenter's merge, not
Git's `ours` and `theirs` names. The server's write translator applies the same
`settle` to a web write landing on a moved `main`. Sync stops, with exit code
2, on anything a person or agent must settle, such as an unfinished merge or a
`main` its owner rewrote ([ADR-0700](adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)).

The planned app-facing synchronization states are `local`, `synced`, `pending`,
`disconnected`, and `stuck`. Local means no destination is configured. The
remaining states describe a configured synchronization connection, independently
of local saving. The Folder exposes only local `saving()`; it does not expose those network states.

## Clients, services, and access

| Name | Meaning |
| --- | --- |
| App | A program using its own read schemas. Qualify a web app or desktop app when runtime or native capabilities matter. |
| CLI | The `epicenter` executable. Its package entry points and commands are documented by the CLI package. |
| Agent or person | A direct file writer. Its changes reach editors through the Folder copy; later writes to the same unit win locally. |
| Epicenter desktop app | The app in `apps/epicenter`: the folder manager, with a generic Files/grid/board/SQL editor with saved views, and Settings. It hosts no app (ADR-0701). It is optional to standalone apps and the CLI. |
| Web origin | The web app's storage and OAuth client boundary. It is distinct from Git's remote named `origin`. |
| Runtime or shell | The environment executing an app or providing native mechanisms. Qualify a Git host or inference host separately. |
| Deployment | A hosted or self-hosted service installation. Hosted-only billing stays in `apps/api/worker/billing/`. |
| Account or principal | The person's service account, or the precise authenticated identity where technical code uses principal. Neither is required for local data use. |
| Membership, owner, member | A hosted repository's access list and roles. A repository grant (`read` or `write`) lets one person outside the namespace reach one repository; only the owner rewrites `main` or grants. Removing membership or revoking a grant does not recall existing copies. |
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
| `@epicenter/folder` | Public `openFolder` from `/tauri` and `/bun`, with `Folder` and `Row.id` from every entry. Apps supply TypeBox row schemas and neither read nor publish a declaration when opening. |
| `@epicenter/folder` contract openers | `openDevice(contract)` from `/browser`, `openDevice(contract, { path })` from `/node`, `openDevice(contract, { path? })` from `/tauri`, and `openRemote(contract, { account })` from `/remote`, over a contract from `@epicenter/definition/contract`. |
| `@epicenter/folder/declaration` | `SavedView`, `readSavedViews`, and the portable schema types. The pure `changeSavedView` transform composes into the same declaration file editor used for raw text. |
| CLI | Implemented commands include `auth`, `check`, `format`, `init`, `sync`, `clone`, `forget`, `status`, `repos`, `share`, and `unshare`. External-schema flags and CLI `open` remain deferred. |
| Stored records | Existing fields such as `recordingId` retain their names and values. A noun cleanup is not a data-format migration. |

For the full dated inventory and the review's accepted and rejected collapses,
see the [October vocabulary audit](vocabulary-audit-2026-10-19.md).
