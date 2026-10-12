# 0508. Folder opening overwrites root definition.json

- **Status:** Proposed
- **Date:** 2026-10-07
- **Remaining:** a decision and repair for Todos browser remote bootstrap. Real-OPFS run/reload and Honeycrisp browser/native note creation, editing, and reopening passed on 2026-10-08; see [computer-use evidence](../../packages/folder/evidence/definition-publication/computer-use-20261008/README.md). Declaration formatting, all three opener paths, diagnostics, and history regressions are implemented and checked. This ADR remains Proposed.
- **Relates:** [ADR-0517](0517-a-data-folder-can-live-inside-any-repository.md) renamed the published file to `epicenter.json` (`DECLARATION_PATH`). Where this record says root `definition.json`, read `epicenter.json`; an old `definition.json` is now an ordinary file.

## Context

`@epicenter/folder` opens files through a caller-supplied definition. The
definition declares `title`, `kv`, and `tables`; it names no dataset. Different
tools can interpret the same files through different definitions. Before this change,
opening saved no description for a person or tool that clones the dataset
without its application source.

`folder.files.overwrite(path, content)` already creates or replaces an ordinary
file through the accounted storage boundary. A complete save requests local
history, as every save does. A checkpoint captures the included
files in the whole folder and creates no commit when its tree matches the
parent. Saving, local history, and remote transfer have separate owners.

## Decision

**Every successful `openFolder` acquisition attempts to overwrite root
`definition.json` with its caller's prepared definition before returning.**
The automatic entry selects its adapter; browser, Bun, and Tauri openers share
the publication behavior. After assembling the handle, serialize the portable
definition and await `folder.files.overwrite('definition.json', text)`. Handle
the result before returning. Do not read or compare the existing file first.
Do not acquire a retained editor or bypass the ordinary file boundary.

```text
dataset/
  definition.json     generated description of the opening caller's schema
  kv.json             saved settings, when present
  <table>/<stem>.md   saved rows
  .git/               local history
```

**Application declarations remain authoritative for application behavior.**
The saved JSON is what `formatDeclaration` writes: the prepared definition's
`title` when present, `kv`, and `tables`, in the shape ADR-0517 defines,
including validation keywords and editor hints. It adds
no dataset ID or credentials. Use deterministic JSON formatting with two-space
indentation, declared property order, and a trailing newline; do not add timestamps
or other opening-dependent values. Opening does
not read this file to configure the application. A later opener can replace a
manual edit or another application's description, including a newer version's
description. The file describes the last successful publication, not every
possible interpretation of the dataset.

**Publication is best effort and reports failures without refusing an otherwise
usable folder.** A failed publication is reported through
`wellcrafted/logger` with `definition.json` as the destination.
`formatDeclaration` cannot fail: every prepared field is already JSON
(ADR-0525), so no constraint is lost in serialization. Report an
uncertain write as uncertain. Do not roll back a landed save, retry in a loop,
or claim the previous file is current after a failed attempt. A subsequent
opening makes a new attempt.

**Definition publication uses the existing automatic-history policy.**
Do not call `git.commit()` or `commitAndPush()` from the publication step.
With automatic history enabled, the complete save requests a background
whole-folder checkpoint; opening waits for file publication, not that checkpoint.
With automatic history disabled, it requests no commit. Neither case pushes.
Do not promise a definition-only commit, one commit per opening, or a commit
before the handle is returned.

## Consequences

A folder copy carries the last successfully published definition for discovery.
Generic readers can inspect its field schemas and editing hints without the
original source. Building a generic editor or importing definitions is separate
work.

Repeated openings pay for serialization and a write, and successful writes emit
change hints and may request checkpoints even when bytes are identical. Tree
equality prevents empty commits. A checkpoint can record other uncommitted
source files; it does not infer the application action that triggered it.

An empty folder opened before downloading an existing remote is no longer a
clean bootstrap destination. With automatic history disabled, the generated
file blocks incoming updates as dirty. With automatic history enabled, its
initial commit creates unrelated local history. The current Todos browser
startup follows this order and cannot complete its first pull. Repairing that
startup requires a separate bootstrap operation or an explicit decision about
combining histories. Publication does not relax Git's incoming protections.

Opening is a mutating operation. Concurrent openers and different application
versions can replace each other's descriptions. A malformed or manually edited
`definition.json` can also be replaced. Saved rows and settings are not migrated
by publishing their description. Failed publication leaves discovery missing,
stale, or uncertain while the application can continue using its declaration.

## Considered alternatives

- Compare bytes before writing: avoids repeated publication and checkpoint
  attempts, but adds a read and comparison to every opening. Start with
  unconditional overwrite; revisit deduplication for demonstrated cost.
- Publish a definition-only commit: introduces separate history behavior and
  makes opening depend on Git rather than reusing the save policy.
- Store the description in hidden metadata or application installation files:
  makes discovery less direct or separates the description from copied data.
- Let the saved JSON configure the application: changes declaration ownership
  and requires an import and compatibility contract beyond discovery.
