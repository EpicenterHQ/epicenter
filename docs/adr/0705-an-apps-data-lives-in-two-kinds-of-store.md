# 0705. An app's data lives in two kinds of store

- **Status:** Accepted (2026-11-03)
- **Date:** 2026-11-03
- **Amends:** [ADR-0534](0534-data-folders-are-the-only-data-model.md) at "Data folders are the one data model": a document synced through the person's account is a second store; the removal of the Yjs store's packages, its `StoreAuthority` and `GenerationsLedger` Durable Objects, and the apps built only on them stands; [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) at an app's data being a layout of files: an app whose contract declares the document store keeps a document instead, and the Variants table gains document apps.
- **Relates:** [ADR-0525](0525-a-field-is-plain-json-schema.md) (a field is plain JSON Schema), [ADR-0706](0706-a-browser-variant-runs-the-desktop-code-with-weaker-guarantees.md) (browser variants), [ADR-0707](0707-an-app-that-needs-co-editing-is-a-document-app.md) (co-editing), [ADR-0708](0708-a-namespace-holds-documents-beside-repositories-under-one-resource-grant.md) (resources), [ADR-0709](0709-a-document-is-rebuilt-into-a-fresh-generation-by-copying-its-current-state.md) (rebuild).
- **Unbuilt:** all of the document store: the document client, its contract, the document sync service on the hosted server and the self-hosted server, the local copy on desktop (`~/.epicenter/documents/<namespace>/<name>/`, [ADR-0718](0718-epicenters-machinery-on-a-machine-lives-in-a-hidden-home-every-program-reads.md)) and in the browser, and export and import between a document and Markdown notes; the field builders that compile one field declaration to JSON Schema, a Yjs shape, SQL columns, and UI controls (`text`, `select`, `multiSelect`, `date`, `url`, `ref`, `body`).

## Context

ADR-0534 made data folders the only data model. Every app opens a contract
(`defineContract`, `@epicenter/definition/contract`) whose collections are
Markdown paths with plain JSON Schema fields, as in
`apps/messages/static/contract.json`:

```json
"replies": { "path": "replies/{id}.md", "fields": { "status": { "enum": ["draft", "ready"] } } }
```

The store is a folder: on desktop through `openDevice` from
`@epicenter/folder/tauri`, in a browser through `openDevice` from
`@epicenter/folder/browser`, or a hosted repository through `openRemote` from
`@epicenter/folder/remote` (ADR-0700).

A tab manager does not fit. It runs as a browser extension, keeps a few
hundred saved tabs, and is edited from several browsers, offline on a plane
and online later. A browser folder never syncs (ADR-0700), and an online
variant needs a connection for every write. The Yjs store ADR-0534 removed
held this kind of data well; it failed as the record for every app, with
Markdown files as a read-only copy that agents could not edit without an import
back into Yjs, tombstones that grew on every replica, and one root per row
loading 20,000 rows in 5,417 ms (ADR-0295).

## Decision

**An app's data lives in two kinds of store: folders and documents.** An app
opens the stores it needs by composition. Most apps open exactly one, usually
one folder; an app may also open several, for example one folder and a few
documents. Nothing limits the count.

| | Folder | Document |
| --- | --- | --- |
| Record | Markdown notes and attached files, history in Git | One Yjs document synced through the person's account |
| Where it lives | A directory on disk, a browser's private storage, or a hosted repository | The account's server, with one local copy per desktop machine in `~/.epicenter/documents` and one per browser that opens it |
| Read | Asynchronous, from files | Synchronous, from the local copy |
| Size | Large: thousands of notes, attached audio | No cap; Tabs holds a few hundred saved tabs |
| Edited by | Any program that writes the layout | The app, and agents through the `epicenter` CLI ([ADR-0716](0716-agents-edit-a-document-through-one-shot-cli-commands.md)) |
| Requires | Nothing; Git sync is optional | An account on Epicenter's server or a self-hosted Epicenter server; a plain Git host cannot hold a document |

**Both stores speak one field vocabulary.** A field is declared once with a
field builder (`text`, `select`, `multiSelect`, `date`, `url`, `ref`, or
`body`) and compiles to four outputs: plain JSON Schema for checking files
(ADR-0525), the key and Yjs type a document stores it under, an SQL column,
and the UI control that edits it. A `select` means the same values in every
output.

**Contracts differ per store.** A folder contract carries layout: the path
template per collection (`recordings/{id}.md`) and attached files beside each
note. A document contract carries structure a document holds well and Markdown
holds poorly: ordered lists, nesting, a body whose type is the app's own. Only
the field vocabulary is shared.

**Markdown notes are the export format of every store.** A folder's working
form is that format. A document exports to it and imports from it: each item
becomes a note at the path its contract names, fields in front matter, body as
Markdown. A custom body must convert to Markdown and back; the conversion may be
imperfect.

**An app moves between stores by export then import.** Two live stores for the same
data never run at once, and no bridge keeps a document and a folder in
step.

**A document accepts its tombstones.** Deleted content stays in the document
until a rebuild ([ADR-0709](0709-a-document-is-rebuilt-into-a-fresh-generation-by-copying-its-current-state.md)), which a person runs rarely, if ever.

The current assignment:

```txt
document  Tabs (saved tabs)
folder    Whispering, Bureaucracy, Capture, Vocab, Zhongwen, Mail, Photos, Messages,
          Invest, Ancestry, Geopolitics, Honeycrisp, Notes, Opensidian, The Ark,
          Tasks and Timebox (open: either may move to the document store)
```

## Consequences

- A browser-first app works offline and reads synchronously without a
  repository, a Git host, or a connection for each write.
- Epicenter runs two sync systems: Git over HTTPS with LFS, and a document
  sync service on the hosted server and the self-hosted server. The second
  needs its own authentication, quota, and deletion.
- "Your data is files" holds per app, not for the platform. A document app's
  data is files only after an export.
- Agents cannot use `grep` or file edits on a document; they go through
  `epicenter get` and `epicenter set` ([ADR-0716](0716-agents-edit-a-document-through-one-shot-cli-commands.md)).
- The field builders return, as one vocabulary, after ADR-0534 moved
  `@epicenter/app/field` to `@epicenter/definition/field` and that export was
  later deleted.

## Considered alternatives

- **A document as the record for every app, files projected from it.** The
  store ADR-0534 removed: two data models, agents editing files that needed an
  import back, tombstones on every replica.
- **A Yjs copy of a folder kept in step both ways.** Built twice and abandoned
  twice: the Yjs store with Markdown as a read-only projection, and the live
  engine on `claude/repository-v2` that ADR-0700 rejected as a second record
  stock tools and agents cannot read.
- **Folders only.** Every browser-first app stays either an island in one
  browser or online-only.
- **One contract for both stores.** Forces folder layout onto documents and
  document structure onto files; the shared part is the fields.
