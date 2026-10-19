# 0584. Names preserve the distinctions callers need

- **Status:** Accepted
- **Date:** 2026-10-17
- **Amended by:** [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md) at `folder.isOwn`, "`isOwn` is publication eligibility", `runHistory`'s `own?`, `isOwnFolder`, "Publish stays for `epicenter.json` (`publishDefinition`)", and the rename of `declare-epicenter-folder` to `write-epicenter-definition`: each is deleted.
- **Amended by:** [ADR-0586](0586-you-open-a-folder-never-an-app.md) at `openFolder({ app, definition })` and `WindowFolder.app`: the opener takes no `app`, and `window_folder` answers the folder alone.
- **Amended by:** [ADR-0589](0589-an-app-is-one-git-repository-of-built-files-at-an-address.md) at the App noun, "named by its reverse-domain id", and at its wire renames: an app is named by its address, and the renames land before the first release, after which the page API changes only by addition.
- **Amended by:** [ADR-0607](0607-an-app-opens-any-data-folder-by-its-id-on-every-host.md) at the rename of `WindowFolder.folder` to `folderId`: `WindowFolder` is deleted, so nothing is renamed.
- **Amended by:** [ADR-0612](0612-a-repository-is-shared-by-the-people-on-its-access-list.md) at the Folder noun: what a person shares and an app opens is a repository.
- **Amended by:** [ADR-0613](0613-a-table-is-a-top-level-directory-described-by-its-table-json.md) at "A row is addressed by its stem, never by an id": the address is unchanged and its name is `id`.
- **Unbuilt:** application migration from the legacy folder API to the public local-data API; this terminology pass changes no exported function, stored field, CLI command, or lock name.
- **Relates:** [ADR-0583](0583-a-folders-declaration-is-published-only-by-the-app-it-is-named-after.md) decided the opener (`openFolder`, `folder.own`, no `lens`); [ADR-0576](0576-a-folder-has-one-write-a-merge-by-unit-where-the-writer-acting-wins.md) is the one write; [ADR-0581](0581-a-desktop-pages-folder-storage-is-one-shell-command-per-storage-method.md) pins installed apps to the shell commands they were built against; [ADR-0457](0457-a-row-filename-is-its-exact-id-and-a-title-is-a-field.md) addresses a row by its stem.

## Context

One concept carried several names, and the names crossed layers. The contents
of `epicenter.json` were `DataSchema` in `@epicenter/definition`,
`FolderDefinition` in `@epicenter/folder`, "the declaration" in
`readDeclaration` and `DECLARATION_PATH`, and "the shape" in `ShapeMismatch`
and `shapeProblems`. A folder was a "data folder" in prose and Rust
(`list_data_folders`, `DataFolder`), and a `scope` in every shell command
argument and in `UnknownScope`. A version was `saveVersion` in apps, the query
layer, and the CLI-to-page JSON, `save_version` in the shell, `save-version` on
the command line, `log` for the list of them, and `'saved'` for a sync that
committed without pushing. A row's address was `Entry.id` in Vocab, `NoteId`
in Honeycrisp, `recordingId(at)` in Whispering, and `stem` in the table API.
Absence was `undefined` from `Table.get` and `null` in `table.write`. A failure
had a union per type rather than per verb: `FileError`, `RowReadError`,
`RowWriteError`, `WriteError`, and `OpenFolderError`.

A reader had to learn that these were the same things, and a grep for one name
missed the others.

## Decision

**Use one domain name for one concept within its context.**
Use ordinary words in product explanations and accurate technical names in
code and developer documentation. Qualify an overloaded word when its
meaning affects behavior. The maintained vocabulary is [shared vocabulary](../CONTEXT.md).

| Name | Meaning |
| --- | --- |
| Local dataset | The local data selected by an app, with identity independent of sign-in and a sync destination; say "local data" in ordinary explanations. |
| Folder or directory | A filesystem location. A data folder is an ordinary folder containing app data. Browser IndexedDB storage is not a filesystem folder. |
| Repository | A Git repository. Qualify a hosted repository when discussing its service ID, membership, or grants. |
| Clone | A separate local copy of a repository. Two web origins can have separate clones of one hosted repository. |
| Remote | A configured Git synchronization destination. A Git remote URL is neither local identity nor authorization. |
| Schema | JSON Schema expectations for a row's frontmatter object. A table schema contains field schemas. |
| Schema file | A JSON file whose tables map supplies named table schemas to a reader. Its filename supplies no authority. |
| Table, row, field, body | A named directory interpreted as immediate Markdown rows, their frontmatter values, and their Markdown bodies. |
| Row id | The filename segment without .md, addressed within its table. Renaming it changes that address; it is not an immutable identity promise. |
| Save, commit, sync | A save acknowledges local persistence; a commit records a Git snapshot; sync exchanges commits and merges changes. |
| App, CLI, agent | Clients that use the same file formats. Reader and writer describe their roles. |
| Epicenter desktop app | The deferred app at apps/epicenter, with possible file browsing and a local app runner. A web browser is a runtime. |

**Schema is the current term for field expectations.**
Retire lens, description, declaration, and shape as competing domain names
for those expectations. The ordinary verb "describe" remains useful.
Definition remains the exact name of a type in the legacy folder package;
it does not require another concept in the destination architecture.
A schema file contains a map of schemas, not one JSON Schema for the whole
repository. It does not configure permissions, identity, or ignored files.

**Names do not erase distinctions in storage, identity, or authorization.**
A local dataset can exist before connection. A folder is its possible disk
location. A hosted repository is a possible sync destination. Save does not
mean commit or upload. A query projection is derived data; an unsent edit
can be the only saved copy and is not a disposable cache.
Use web origin for the browser storage/client boundary and Git remote
origin for Git configuration. Use sync destination and inference provider
for their different settings. A grant names permission, not a connection.

**Existing identifiers remain exact until their implementation is migrated.**
Current applications use openFolder, defineFolder, Definition, and stem in
@epicenter/folder. The internal @epicenter/data engine uses openRepository,
LocalRepository, schemas, and Row.id; it has no public exports yet.
The CLI still uses auth login and save-version. Documentation distinguishes
these implementation names from planned contracts. Do not rename persisted
recordingId fields, exports, or cross-process locks merely to match a glossary.

A package entry point is an import path such as @epicenter/folder/bun.
An executable entry point starts a process, such as the CLI's bin.ts.
An opening function opens data. These are roles, not additional data objects.

**A product name and its technical roles do not create separate components.**
Use Epicenter desktop app for the product. Its runner is a possible capability;
host and shell describe qualified runtime responsibilities. Host app, desktop
host, launcher, and generic browser are not competing product names.

Repository names Git. Repo is shorthand, including exact CLI commands such as
`repos`; app repository and data repository describe contents, not new types.
An app can save local data before a repository or remote exists. Local dataset
describes that selection without requiring a universal ID or registry. Record
can explain a row to a person, and workspace adds no alias for opened data.

## Consequences

- The old P1 to P10 blanket rename plan is withdrawn. Migrations follow
  actual callers and completed replacement behavior.
- The vocabulary check continues guarding retired identifiers in the
  existing implementation; it does not select future API names.
- Standard technical names such as principal, replica, and projection keep
  their precise meanings where used. Product text explains the person's task.
- Historical and superseded records can quote their original nouns.
  A filename, example identifier, or old source symbol is not a current term.

## Considered alternatives

- **One word across every context.** Calling IndexedDB a folder or every
  local dataset a hosted repository conceals storage and identity differences.
- **A domain name for every source of schemas.** Lens, description, and
  definition make readers learn several names for the same expectations.
- **Rename every legacy identifier first.** Adds a migration campaign for
  an implementation whose consumers still need replacement behavior.
