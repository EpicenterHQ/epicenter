# 0508. A folder handle's first write publishes its declaration

- **Status:** Proposed
- **Date:** 2026-10-07
<!-- doc-path-check: ignore-next-line -->
- **Revised:** 2026-10-14: publication moved from opening to a handle's first write ([ADR-0532](0532-a-folder-is-the-directory-its-id-names-with-its-remote-in-git-configuration.md)), which also settles the Todos browser bootstrap this record left open. The real-OPFS harness (`packages/folder/evidence/opfs`) checks the new rule in Chromium. The 2026-10-08 computer-use evidence (`packages/folder/evidence/definition-publication/computer-use-20261008/README.md`, deleted; recover via `git log --all --full-history`) checked publication at opening.
- **Amended:** 2026-10-14: the first write reads `epicenter.json` and leaves it unwritten when it already holds the declaration's bytes.
- **Relates:** [ADR-0517](0517-a-data-folder-can-live-inside-any-repository.md) renamed the published file to `epicenter.json` (`DECLARATION_PATH`). Where this record says root `definition.json`, read `epicenter.json`; an old `definition.json` is now an ordinary file.

## Context

`@epicenter/folder` opens files through a caller-supplied definition. The
definition declares `title`, `kv`, and `tables`; it names no dataset. Different
tools can interpret the same files through different definitions. Before this change,
opening saved no description for a person or tool that clones the dataset
without its application source.

`folder.files.overwrite(path, content)` already creates or replaces an ordinary
file through the accounted storage boundary. A complete save requests local
history when `commitOnEdit` is enabled. A checkpoint captures the included
files in the whole folder and creates no commit when its tree matches the
parent. Saving, local history, and remote transfer have separate owners.

## Decision

**A folder handle publishes root `epicenter.json` with its caller's prepared
definition just before its first write, and never on open.** Every opener,
browser, Bun, and desktop, assembles the handle the same way: the storage
under its files, tables, and KV publishes once, through the ordinary file
boundary, before the first change the handle makes. Reads publish nothing. A
folder opened and never written to is left exactly as it was, and in a
browser it does not exist ([ADR-0532](0532-a-folder-is-the-directory-its-id-names-with-its-remote-in-git-configuration.md)).
Read the existing file through the same boundary first, and skip the write
when its bytes equal `formatDeclaration`'s output; a failed read falls
through to the write.

```text
dataset/
  epicenter.json      generated description of the last writer's schema
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
not read this file to configure the application. A later handle's first write
can replace a manual edit or another application's description, including a
newer version's description. The file describes the last successful
publication, not every possible interpretation of the dataset.

**Publication is best effort and reports failures without refusing an otherwise
usable folder.** A failed publication is reported through
`wellcrafted/logger` with `epicenter.json` as the destination, and the write
it preceded still runs.
`formatDeclaration` cannot fail: every prepared field is already JSON
(ADR-0525), so no constraint is lost in serialization. Report an
uncertain write as uncertain. Do not roll back a landed save, retry in a loop,
or claim the previous file is current after a failed attempt. The next handle
makes a new attempt.

**Definition publication uses the existing automatic-history policy.**
Do not call `git.commit()` or `commitAndPush()` from the publication step.
It is an ordinary save: it requests no commit and pushes nothing
([ADR-0529](0529-commits-happen-only-on-sync-or-when-a-person-saves-a-version.md)),
and the next version records it with the files written beside it. Do not
promise a definition-only commit.

## Consequences

A folder copy carries the last successfully published definition for discovery.
Generic readers can inspect its field schemas and editing hints without the
original source. Building a generic editor or importing definitions is separate
work.

Each handle that writes pays for one serialization and one read before its
first write. Only a missing or different declaration is written, and that
first write then announces `epicenter.json` with the file the caller wrote.
An unchanged declaration announces nothing and stays out of history.

A folder opened only to read, or to download an existing remote, stays clean:
an empty folder takes the remote's history as it is, and the remote's own
`epicenter.json` arrives with it.

Writing is the mutating operation. Concurrent handles and different
application versions can replace each other's descriptions. A malformed or
manually edited `epicenter.json` is replaced by the next handle's first write,
not by opening. Saved rows and settings are not migrated by publishing their
description. Failed publication leaves discovery missing, stale, or uncertain
while the application can continue using its declaration.

## Considered alternatives

- Publish on every open (this record's first decision): an empty folder opened
  before a download already held a local change the download refused, and a
  folder that was only read was still written.
- Publish with each commit: a folder with saves but no version would not
  describe itself, and a staged commit would miss it.
- Overwrite unconditionally (the decision until 2026-10-14): saves
  the read, but rewrites an identical file on every handle's first write and
  announces a change to `epicenter.json` that changed nothing.
- Publish a definition-only commit: introduces separate history behavior and
  makes opening depend on Git rather than reusing the save policy.
- Store the description in hidden metadata or application installation files:
  makes discovery less direct or separates the description from copied data.
- Let the saved JSON configure the application: changes declaration ownership
  and requires an import and compatibility contract beyond discovery.
