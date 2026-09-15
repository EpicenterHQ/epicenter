# 0394. A backup is the library's folder, kept by the authority

- **Status:** Proposed
- **Date:** 2026-09-12
- **Amends:** [ADR-0287](0287-the-authority-does-not-delete-a-generation-and-erasure-is-an-account-operation.md) at "erasure is the one sweep that remains": a second pass exists, and it deletes only bytes no copy and no row holds, after a person or the daily copy has un-named them. Generations are still never deleted.
- **Relates:** [ADR-0379](0379-reconstruction-is-an-explicit-destructive-library-operation.md) (`Proposed`, edited in place: a backup is the row and kv files of the ADR-0337 folder, not a structural archive, and there is no receipt), [ADR-0240](0240-an-application-declares-one-workspace-and-an-opened-runtime-holds-exactly-one-definition.md) (a table the definition no longer declares imports anyway), [ADR-0337](0337-the-folder-is-a-working-copy-and-pull-and-push-are-the-whole-cycle.md) (the folder layout), [ADR-0268](0268-a-row-exports-as-one-markdown-file-and-its-codec-is-mandatory.md) (a row is one file through a mandatory codec), [ADR-0393](0393-a-blob-is-addressed-by-its-row-and-the-account-holds-every-one.md) (why a copy names bytes by naming rows), [ADR-0395](0395-restore-is-one-request-that-carries-its-own-safety-copy.md) (how a kept copy replaces the library)
- **Unbuilt:** All of it. `packages/data/src/recovery.ts`, `recovery-journal.ts`, `store/idb-journal.ts`, `sync/backups.ts`, `sync/attempts.ts`, `artifact/archive.ts`, `artifact/archive-storage.ts`, and `packages/server/src/backup-storage.ts` implement the structural archive, the S3-backed catalog, and the attempt journal that this record retires. None is mounted, exported from a package barrel, or reachable from a screen. `apps/honeycrisp/scripts/library-retirement.ts` builds its test activation from `captureArchive` and is the one consumer to replace before `archive.ts` goes.

## Context

`packages/data/src/artifact/archive.ts` captures a library as a JSON envelope
holding every Yjs root as structural values, every referenced attachment as a
numeric byte array, the source generation and head, and a digest.
`sync/backups.ts` publishes it to object storage, reads it back, compares
bytes, then records a catalog row. A backup therefore has three homes that
cannot share a transaction, and `recovery-journal.ts` and `store/idb-journal.ts`
exist to carry bytes across the gap. Attachments were embedded because a
stored blob could be deleted out from under a backup, and embedding them costs
3.6 bytes of JSON per byte of audio.

ADR-0337 already defines a folder that is the library rendered whole, that a
person can read and edit, and that `readArtifact` turns back into a document
through each table's mandatory codec. Under ADR-0393 that folder also names
every attachment, because a row file at `<table>/<row-id>.md` is the name of
the object at `<table>/<row-id>`.

## Decision

**A backup is the text of the ADR-0337 folder at one moment: `kv.json` and one
`<table>/<row-id>.md` per row. It is kept by the authority as rows.**

```txt
_kept        (id, automatic)          id: time-ordered, minted by the authority
_kept_files  (kept_id, path, bytes)   one row per folder entry, text only
```

Both are written in one transaction. There is no zip in storage, no index, no
manifest, no `state.json`, no generation or head on the copy, and no
attachment bytes. `.epicenter/manifest.json` and `AGENTS.md` are absent: the
first records what a pull handed over and a backup hands over nothing, and the
second is generated from the definition. A folder entry above the Durable
Object's 2 MiB value limit is refused with its path.

**A copy names bytes by naming rows.** An object `<table>/<row-id>` is wanted
while any copy holds `<table>/<row-id>.md`, because under ADR-0393 a row keeps
its bytes for life and the cell never changes. The authority reads paths and
nothing else; it never opens a row file.

**Reclaim is eventual and must protect current rows and publication.**
Deleting a row or a kept copy does not immediately delete account audio.
An object remains wanted while a current row or any retained copy names it.
Uploads and imports in flight also require protection.

A backup-only sweep is withdrawn: a client can render a copy, another device
can create and upload a recording, and the earlier copy can then omit live
audio. A position check on the copy alone does not cover later publication,
and a finite grace period cannot protect an arbitrarily delayed operation.
The authority/publication coordination protocol is unresolved. Physical
reclamation must remain disabled until the implementation spec proves these
cases, including restore, interruption, and late uploads after row deletion.

**The application keeps its own copy on a clock, and the system may delete
what the system made.** On open, at most once a day, the app keeps a copy with
`automatic = 1`, and the same pass deletes automatic copies beyond the newest
seven. Manual copies and before-restore copies (ADR-0395) carry `automatic = 0`
and are deleted only by a person. On-open scheduling gives no wall-clock
deletion bound. Older automatic copies may retain audio across several days;
manual and safety copies retain it until deleted. Reclamation can remove
audio only after the last reference is gone and a safe cleanup pass runs.

**Export and import carry the attachments; the authority never does.**
`export(id)` reads the copy's entries, fetches the object for every row whose
cell is not null, and writes the zip a person downloads:

```txt
kv.json
<table>/<row-id>.md
<table>/<row-id>.<ext>       the row's bytes, extension from its MIME cell, `.bin` otherwise
```

`import(zip)` puts each sibling at its row path, create-only, then posts the
text entries as a copy. An object already present keeps its bytes; the importer
must verify equal content before treating a repeated import as success.
Different content at the same address is an explicit conflict, never a silent
substitution. A row whose sibling is absent imports with
its cell intact and shows as missing audio; export writes no file for it, and
restore invents nothing. `readArtifact` reads the folder as it reads a checkout
(ADR-0240): an undeclared table imports with its rows, an unknown frontmatter
key is kept verbatim, and the one refusal is a row body with no codec
(`ImportError.UncodedBody`).

**Six verbs on one object bound to the account, the app, the library, and the
definition, needing no open App.**

```ts
const recovery = openLibraryRecovery({ account, appId, library, definition });

recovery.list();          // kept copies: id, automatic, text size
recovery.backup();        // render the current download as entries, keep it
recovery.export(id);      // the copy plus its attachments, as one zip
recovery.import(zip);     // put siblings by row path, keep the text as a copy
recovery.restore(id);     // ADR-0395
recovery.delete(id);      // drop the copy; unreferenced bytes await safe reclamation
```

Five routes beside `CURRENT_ROUTE` and the blob routes of ADR-0393, in
`packages/server/src/store-sync/mount.ts`, identical on both deployables:

```txt
GET    /api/libraries/:appId/:library/data/:dataId/backups
POST   /api/libraries/:appId/:library/data/:dataId/backups        entries; `automatic` flag
GET    /api/libraries/:appId/:library/data/:dataId/backups/:id    the entries
DELETE /api/libraries/:appId/:library/data/:dataId/backups/:id
POST   /api/libraries/:appId/:library/data/:dataId/restore        ADR-0395
```

The 16 MiB streaming refusal that `StoreAuthority.fetch` applies to a baseline
body applies to a posted copy. A local library has none of this: its backup is
the folder `pull` writes to disk under ADR-0337, and its restore is `import`.

## Consequences

A backup is one request and a few thousand rows. A library with hours of audio
backs up as fast as one with none, and ten copies hold ten copies of the text
and one of every object.

The Backups screen is a list of times, automatic copies greyed, each with
Export, Restore, and Delete. Explain: "Backups can preserve audio from deleted
recordings. Audio can be cleared after no recording or backup needs it."

A saved text copy does not establish that all its audio reached the account.
Backup/export results must distinguish saved rows from verified attachment
coverage and report unavailable audio. Eager synchronization under ADR-0393
reduces missing copies; it does not prove completeness.

Save the text copy even when some audio is unavailable. Show saved details
and audio coverage separately: verified available, unavailable, or not yet
checked. A check records what was observed at that time; a timestamp on a
synced row is not sufficient verification. Missing counts require an actual
check. Later uploads may improve coverage without changing the saved text.

Before restore, show coverage for the selected copy and the safety copy
separately. The safety copy describes captured account state, not every
device's latest local work. Unuploaded audio may be discarded when its device
adopts a restored generation (ADR-0395); an incomplete backup does not promise
to rescue it. Export must carry an explicit omission report with a partial
artifact so its limitations survive separation from the completion message.

The files a person exports are the ones they already edit under ADR-0337, so
one codec and one layout serve checkout, backup, export, and import. Fidelity
is what a table's codec writes; a value the codec cannot write is not backed
up, which is already the rule for the working copy. A folder from an older
build keeps its undeclared tables under ADR-0240, so a restore can bring back a
table the definition dropped.

There is no restore from a file: a file enters through `import` and is
restored as a kept copy, so the authority is the source of every restore.

A retried `backup()` after a lost response keeps a second identical copy. It
is harmless: the pass or the person removes it.

Deleted when this lands: the structural archive and its `references()` scan,
the S3 backups namespace and `createS3ArchiveStore`, `_backups` and read-back
publication, `_restore_attempts`, the client journal and its IndexedDB engine,
and the `attempts` namespace on the unmounted coordinator.

## Considered alternatives

- Keep the structural JSON archive with embedded attachments. Lossless below
  the codec, but 3.6× the audio in a body, a second format beside the working
  copy, and a regex over prose to find ids.
- Publish backups as objects in R2 with a catalog row in the authority. Two
  homes for one fact, so publication needs tickets, read-back verification, and
  a client journal to survive the gap.
- One zip per copy with every attachment inside. Ten copies of a 4 GB library
  are 40 GB, every backup streams every object through a Worker because R2
  has no server-side copy, and every restore puts every object back.
- A kept zip stored opaque, with a list of the blob ids it names stored beside
  it (`_cites`), or attachment marker rows with null bytes, so the authority
  could tell which bytes a copy wants. Both exist only when the blob's name
  is not the row's; ADR-0393 makes it the row's.
- Immediate reclaim: delete an object when its row is deleted unless a copy
  names it, and delete a copy's orphans when the copy is deleted by sending a
  render of current with the request. Three rules and a request that carries a
  list, against one pass that carries nothing.
- Retention as a count over every copy. A copy a person saved is theirs; only
  the system's daily copies are the system's to remove.
- Put table folders under `tables/`, or carry `.epicenter/manifest.json` and
  `state.json`. The folder would then differ from the ADR-0337 working copy.
