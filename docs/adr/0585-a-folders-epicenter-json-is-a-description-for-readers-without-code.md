# 0585. Schema files describe tables without owning them

- **Status:** Accepted
- **Date:** 2026-10-17
- **Supersedes:** [ADR-0583](0583-a-folders-declaration-is-published-only-by-the-app-it-is-named-after.md) (publication by the app a folder is named after, `folder.own`, and the read-through containment check) and [ADR-0538](0538-an-app-opens-any-folder-whose-declaration-contains-its-shape.md) (an app opens a folder whose declaration contains its shape; a folder names no app).
- **Amends:** [ADR-0532](0532-a-folder-is-the-directory-its-id-names-with-its-remote-in-git-configuration.md) at "the folder's first write, which publishes `epicenter.json` just before it": nothing publishes. [ADR-0535](0535-an-existing-folder-opens-with-its-own-declaration.md) at "Only `openFolder` publishes", the typed lens checked by containment, the consequence that `openFolder`'s `definition` is the only way to create a folder, and listing the Epicenter folder by finding `epicenter.json`: nothing publishes or checks containment, a folder is made from a template, and the listing is every real, non-dot directory. [ADR-0560](0560-an-apps-manifest-only-names-it-and-every-installed-app-is-offered-on-every-folder.md) at "the app's lens decides" and Whispering's mismatch refusal: rows that do not fit read as invalid rows. [ADR-0584](0584-each-concept-has-one-noun-in-code-on-the-wire-and-in-prose.md) at `folder.isOwn`, `runHistory`'s `own?`, `isOwnFolder`, "Publish stays for `epicenter.json`", and `write-epicenter-definition`: each is deleted.
- **Amended by:** [ADR-0607](0607-an-app-opens-any-data-folder-by-its-id-on-every-host.md) at "An app opens the folder it was handed" and "on the desktop the shell decides which folder a window opens (`Folders::hand`, `window_folder`), never the page's URL": an app opens any data folder by id, and the launcher names the first one on the URL. [ADR-0605](0605-an-app-is-an-ordinary-single-page-app-in-a-forkable-git-repository.md) at "the `template` commit the approved app commit names", "the one its installed app's approved commit names", and "authored by the app's publisher": no commit is approved and no publisher exists, and ADR-0609 replaces the template commit with files copied once. [ADR-0609](0609-a-new-data-folder-copies-its-apps-template-once.md) at "The template is the folder's Git upstream", the `template` branch, "A folder's first commit is the `template` commit the approved app commit names", "Update from <app>'s template", `epicenter check <dir>` comparing template commits, and the consequences "until the person updates from the template" and "Every folder's history starts with a commit of its app's `template` branch": a new folder copies its app's `template/` once into a first commit of its own, a data folder's only remote is the person's own, and nothing updates a folder from its app. [ADR-0632](0632-a-lens-belongs-to-its-reader.md) at root description discovery: descriptions are optional reader-selected schema files, never automatically published or applied by filename.
- **Amended by:** [ADR-0613](0613-a-table-is-a-top-level-directory-described-by-its-table-json.md) at the root `epicenter.json`, its `app` and `title`, and "A data folder is every real, non-dot directory directly in the Epicenter folder": a table is described by its own `<table>/table.json`, which the library never writes on its own, and the unit a person owns is a repository.
- **Amended by:** [ADR-0626](0626-an-app-reaches-a-repository-only-through-open.md) at "`openFolder({ definition })` (ADR-0586) validates every table read and write against `definition`" and "`openFolder({ id })` and `openFolder({ root, git })`": an app opens a repository with `open({ id?, tables })`, and its schemas check what it reads and refuse no write.
- **Unbuilt:** explicit schema-file input in generic CLI readers and application migration away from declaration publication and containment checks.

## Context

`epicenter.json` held a folder's Definition, and code read it to decide who
may write the file and which apps may open the folder.

- **Publication.** An app publishes its Definition into the folder named
  after it (ADR-0583): `opening` sets `own` when the folder id equals the
  app id (`packages/folder/src/opening.ts:43`), and `handleStorage`
  (`packages/folder/src/folder.ts:292`) runs `publishDefinition` and
  `publishLocalPatterns` before the first put (`:314-333`).
- **Containment.** Every other app reads through its definition: `mismatches`
  (`packages/definition/src/shape.ts:73`) refuses a folder whose declaration
  does not contain it, returned as `DefinitionMismatch`
  (`packages/folder/src/open-at-root.ts:130`), and writes are checked
  against the folder's own declaration. A table the app reads but cannot
  fill is `canCreate: false` (`packages/folder/src/table.ts:99`).
- **Listing.** The desktop shell lists a directory in the Epicenter folder
  only when it holds `epicenter.json`
  (`apps/epicenter/src-tauri/src/data_folders.rs:219-220`), and at every
  launch runs `epicenter declare-epicenter-folder`
  (`spawn_epicenter_folder_declaration`, `apps/epicenter/src-tauri/src/cli.rs:597`).

The file also decides how files merge and what a commit leaves out;
ADR-0591 and ADR-0592 take those over. Each of these reads made
`epicenter.json` load-bearing, so it had to be owned and kept current, and
folders had to be named after apps so the owner could be found. With folder
names belonging to people (ADR-0586), the owner rule has nothing to hold
onto.

## Decision

**A schema file supplies optional table schemas to the tool that selects it.**
Its tables map pairs table-directory names with JSON Schemas for row
frontmatter, as specified by ADR-0632. The reader obtains it separately,
including from a registry, and keeps it outside the data folder. A file
named epicenter.json has no discovery,
identity, permission, or app-installation role.

**Apps supply their own read schemas and never publish them by opening data.**
An app needs no schema file to open, save, or sync. Its schemas check reads;
rows that do not fit keep their raw fields and issues. A schema disagreement
does not refuse a save or rewrite a file. Neither local data nor a table
has an owning app entitled to overwrite a shared schema file.

**Obtaining a schema file changes no existing data.**
Selecting it creates no table, directory, or schema file alongside the data.
Any folder can be read using any explicitly selected supported schema file;
a mismatch remains a read diagnostic. No template branch, template ancestry,
app-update merge, or generated root declaration is required. Schema updates
change the selected tool's interpretation; data changes remain explicit edits.

## Consequences

- Missing or malformed schemas leave ordinary file access available.
- Schema publication, ownership tests, and containment gates are retired.
- Existing epicenter.json files remain source files and can be selected
  explicitly after the reader migration. Their legacy app, title, and local
  metadata does not acquire identity, permission, or Git-policy effects.
- The existing generator and folder opener still implement the older
  behavior. Retiring them requires consumer migration, not a filename change.

## Considered alternatives

- **A required root file or automatic filename discovery.** Makes generic
  reading depend on a shared default that apps do not need.
- **The app named after a folder owns its schema.** Directory names belong
  to people and cannot establish publication rights.
