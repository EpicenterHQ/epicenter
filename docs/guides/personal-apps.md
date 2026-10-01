# Building a personal app

> **Design guide.** This page describes the target workflow for an app over a file-based data folder. It is not an executable SDK quickstart. The file-based foundation it describes is not built.

The [root README](../../README.md) describes the finished product. This guide follows one app through that description and records, at each stage, what a builder should observe and which interface is still undecided. These scenarios become executable instructions only after each one links to tracked tests or worked examples that exercise the actual implementation; an accepted ADR does not mean the behavior is built.

ADR links are evidence of the target contract, not of implementation. [ADR-0456](../adr/0456-a-markdown-row-owns-at-most-one-same-stem-attachment.md) is accepted; the other records cited here are proposed. Each lists its unbuilt work.

## Current contracts: Yjs stores and resources

Applications using the current shared application package declare a store and open Yjs-backed stores beside separately owned resources. [apps/README.md](../../apps/README.md) documents composition and [packages/app/README.md](../../packages/app/README.md) documents the resource contract. `@epicenter/app` is a private monorepo package. These documents describe applications built inside this repository, not a verified package-installation path for an independent repository.

The package's artifact export and import render Markdown from a Yjs store and apply file edits back to it. That is not a file-source API. In that flow the store holds the saved data and the Markdown is a copy.

## The journey

You decide what the app keeps. The app saves each item as a Markdown file in a folder you selected. You edit one of those files in a text editor, save it, and reopen the app to find the change. Later you redesign the interface, or build a second one, and it works with the same files because it reads the same format.

The layout below is illustrative only. The folder name, table name, IDs, and field names are not normative.

```text
my-notes/
  kv.json          optional: present only when the app saves settings
  index.sqlite3    optional: generated snapshot for SQL tools
  notes/
    a1.md
    a1.png         the one attachment owned by a1.md
    b2.md
```

```markdown
---
title: Garden plan
started: 2026-04-12
---

Tomatoes go in the south bed.
```

Frontmatter holds fields and the body holds content. The filename stem is the row's ID; the title is a field ([ADR-0457](../adr/0457-a-row-filename-is-its-exact-id-and-a-title-is-a-field.md)).

## Stages

### 1. Describe the data

Outcome: the app's definition interprets files that already exist. Opening a folder with a newer or older app rewrites nothing.

Unresolved: how a definition is declared for file-backed data, and whether today's store declaration carries over ([ADR-0450](../adr/0450-current-files-own-portable-document-data.md) leaves both open).

Evidence: not yet established for the file-based foundation.

### 2. Edit and save through the app

Outcome: a typed edit changes the intended field or body and nothing else. A save checks the source version it read and reports when that source changed in between.

Check: add a field the app does not declare, edit a different field in the app, and confirm the unknown field and the body are byte-for-byte intact. Then change the file between the app's read and its save, and confirm the save detects it. A native program outside Epicenter's file operations can still race that check.

Unresolved: the save interface, how a detected change is presented, and what merge choices exist.

Evidence: not yet established for the file-based foundation.

### 3. Edit a file, save, reopen

Outcome: the app shows the external edit after reopening, with no import step. A file the app cannot interpret stays in place, unmodified and inspectable.

Check: break one file's frontmatter. The app reports it by path, keeps the bytes, and refuses a typed edit until someone repairs it.

Unresolved: how issues are reported and repaired, and when a running app notices outside edits.

Evidence: not yet established for the file-based foundation.

### 4. Attachments and complete copies

Outcome: a row owns at most one sibling file with the same stem. A complete copy of the folder includes that file's actual bytes and opens without the original app, account, or service.

Check: copy the folder and compare attachment bytes. Remove an attachment and confirm its absence remains visible without rewriting the source. Remove a row's Markdown and confirm the remaining attachment is preserved. Add a second same-stem candidate and confirm the app reports ambiguity and refuses its own deletion of that row.

Unresolved: how a copy is taken and verified, and interruption recovery when a row and its attachment are created or deleted together.

Evidence: not yet established for the file-based foundation.

### 5. Query with SQL

Outcome: an optional generated `index.sqlite3` at the folder root lets SQL tools read interpreted rows ([ADR-0463](../adr/0463-a-data-folder-exposes-a-generated-root-sqlite-index.md)). The Markdown stays the source. SQL writes to the index do not edit Markdown.

Check: delete the index and regenerate it; source files are unchanged and queries return equivalent results. Edit a file after generation; the index still describes the earlier snapshot and is not presented as current.

Unresolved: the generator, the SQL schema, and how a reader learns a snapshot's freshness.

Evidence: not yet established for the file-based foundation.

A private SQLite database for a provider cache or transactional state is a different thing ([ADR-0459](../adr/0459-sqlite-is-a-local-capability-for-derived-or-transactional-state.md)). It lives outside the folder, has its own retention and recovery, and does not participate in data folder synchronization. Regenerating the index does not recover it.

Unresolved: that database's opener and lifetime in a file-based app.

Evidence: not yet established for the file-based foundation.

### 6. Change the interface, then add a second one

Outcome: a redesigned or second interface that uses the same format opens the same folder with no conversion. Fields it does not declare survive its edits. A different format requires an explicit migration that retains the originals.

Unresolved: what establishes that two interfaces are compatible, what happens when their definitions differ, and where a migration keeps the originals.

Evidence: not yet established for the file-based foundation.

### 7. Release the software

Outcome: each person who runs the released app uses separate data that they explicitly selected. The release contains none of its author's files ([ADR-0470](../adr/0470-epicenter-helps-people-make-software-that-is-unmistakably-theirs.md)).

Distribution does not supply data access, permissions, synchronization, or trust. Each needs its own contract.

Unresolved: the build, runtime, and publication interfaces for an app in its own repository ([ADR-0449](../adr/0449-epicenter-connects-independent-applications-through-personal-data.md)), and how an independently published browser app reaches a person's folder.

Evidence: not yet established for the file-based foundation.
