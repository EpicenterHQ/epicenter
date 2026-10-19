# 0632. A lens belongs to its reader

- **Status:** Accepted
- **Date:** 2026-10-19
- **Amends:** [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md), [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md), [ADR-0613](0613-a-table-is-a-top-level-directory-described-by-its-table-json.md), [ADR-0626](0626-an-app-reaches-a-repository-only-through-open.md), and [ADR-0627](0627-every-change-to-the-data-model-is-checked-against-nine-principles.md) only where repository descriptions determine generic table discovery or a reader's lifetime.
- **Relates:** [ADR-0520](0520-the-cli-acts-on-a-data-folder-by-its-path.md) (CLI readers), [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md) (schema-independent saves).
- **Unbuilt:** explicit lens selection in the CLI and data browser; browsing without a repository description; reader-scoped conformance diagnostics; preserving drafts through lens changes; and migration of current declaration-dependent readers and application openers.

## Context

Whispering declares its recording and transcription fields in
`apps/whispering/src/lib/definition.ts`. It already brings the knowledge
needed to read its files. The internal browser engine accepts caller-supplied
schemas in `packages/data/src/repository.ts`; its saves do not validate
against those schemas.

Current applications still use `@epicenter/folder`. Its opener reads a root
description or publishes the owning app's definition. `readFolder` requires
`epicenter.json` before inspecting tables. The generic browser derives its
tables from that description and reopens the folder when it changes.

ADR-0585 makes the root description optional for apps. ADR-0613 instead
requires a `table.json` to identify each table to generic tools. ADR-0611
and ADR-0626 carry that discovery rule into the browser and CLI. Either
location makes one description in the repository the generic reader's
default interpretation. Several apps can use the same files while holding
different expectations about their fields.

The bounded change is ownership of that interpretation. ADR-0613's flat row
paths, row attachment directories, key ordering, and schema-independent
saves remain. ADR-0626's caller-supplied read schemas remain. Authentication,
repository identity, Git transport, and merge behavior are unchanged.

## Decision

**A lens is static JSON selected by the reader to interpret repository files.**
Its `tables` map names top-level directories and describes each directory's
row frontmatter with JSON Schema. Table keys name the actual directories;
there are no aliases, computed fields, transforms, or migration instructions.
An app supplies its own read schemas from code. The CLI and generic browser
can receive a lens from a local JSON file. A lens grants no repository
access and configures no repository identity or ignored files.

```text
voice-notes/                    data repository
    recordings/<id>.md
    transcriptions/<id>.md

whispering-lens.json            selected separately; may live anywhere
    tables.recordings          JSON Schema for recording frontmatter
    tables.transcriptions      JSON Schema for transcription frontmatter
```

**No description file is required to open, save, sync, or browse the files.**
Neither `epicenter.json` nor `table.json` identifies data or establishes a
directory's status as a table. Apps name the directories they use; a lens
names those its reader presents as tables. Without a lens, the generic
browser still lists files and opens their source. Raw inspection can show
the frontmatter values actually present without inventing field meanings.
A selected lens never hides the file browser or files outside its tables.

**A lens's location confers no special behavior.** A publisher may distribute
JSON alongside its app, and a person may author or copy it. Obtaining a lens
does not create a file in the data repository. A person may commit a lens,
including an existing `epicenter.json`, and select it explicitly by path.
Nothing discovers or applies it merely because of its name. Remembered lens
selections belong to the reader's machine-local settings outside the data.
Reading a lens executes no code and fetches no schema references or updates.

**A lens describes expectations without determining which source survives.**
A row that fails its schema retains its raw fields, source, and issues.
Malformed frontmatter remains available through file access for repair.
Diagnostics identify the selected lens they check against. With no lens,
the reader gives no schema-conformance verdict; an empty schema's successful
check must not be presented as evidence that the files fit an app.

**Selecting or changing a lens changes no repository files or repository lifetime.**
It preserves unsaved input and the exact starting source needed to save it.
Field edits preserve fields outside the view, including when the row does
not fit the lens. A missing, unreadable, or malformed lens produces an issue
with that selection while raw file access remains available. A named table
whose directory is absent is empty; applying the lens creates no directory.

## Consequences

- A fresh clone remains browsable offline without an app, lens, or account.
  Its typed forms and app-specific checks require a lens obtained separately.
- Two readers can select different lenses over the same files. Neither
  selection publishes a declaration or changes the other reader's schemas.
- A team can share a committed lens, but each reader selects it. Cloning
  the data alone does not restore machine-local view selections.
- A stale lens can report disagreements with current data. It never
  migrates records, discards unknown fields, or changes merge policy.
- The CLI's declaration-required `readFolder` path and the browser's
  declaration-driven reopening must be replaced. Invalid rows currently
  excluded by `checkFolder` and SQL projection must retain a source and
  diagnostic path in lens-based views. The browser's current read-only
  invalid-row display still needs a source repair path.
- Declaration publication, ownership and containment gates, and mandatory
  description discovery are unnecessary. Existing description files remain
  ordinary files; migration removes none automatically.
- Schema-free SQL, automatic table discovery, the exact raw-grid interface,
  and a lens registry are separate features. They are not required for
  reader-owned lenses. No tool claims semantic conformance without one.

## Considered alternatives

- **An optional root description applied automatically.** Restores a typed
  default on clone, but introduces filename discovery and a shared default
  interpretation. Explicit selection also permits sharing a committed lens.
- **A required `table.json` beside every table.** Makes generic discovery
  depend on a description no app needs to write.
- **Infer schemas and typed editors from observed values.** Existing values
  cannot establish required fields, valid choices, or semantic date types.
- **A registry with automatic lens updates.** Adds availability, versioning,
  and update policy before static JSON distribution has demonstrated a need.
