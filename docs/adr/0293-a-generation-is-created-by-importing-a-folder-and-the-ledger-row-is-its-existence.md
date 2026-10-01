# 0293. A generation is created by importing a folder and the ledger row is its existence

- **Status:** Accepted
- **Date:** 2026-08-29
- **Amended by:** [ADR-0407](0407-app-owns-the-declaration-and-data-engine.md) at the public client listing/import/erasure helpers, which are removed. Existing historical bytes and the server refusal of fresh current Personal initialization over admitted history remain. The implementation account below records the earlier protocol, not a current client API.
- **Amended by:** [ADR-0336](0336-an-authority-mints-every-generation-so-every-store-has-an-account.md) at the no-account branch: "the device assigns `n` by reading its own addresses" is withdrawn. A client never chooses the number.
- **Supersedes:** [ADR-0286](0286-every-generation-is-minted-from-an-artifact-and-compaction-is-an-export-then-an-import.md) and [ADR-0290](0290-a-mint-is-a-foreground-job-the-client-owns-and-it-cannot-outlive-a-page.md) at the upload and publication protocol. The folder as the source, client-owned codecs, and one foreground path are retained.
- **Amends:** [ADR-0283](0283-a-generations-collection-is-a-ledger-that-allocates-admits-and-sweeps.md) at allocation timing and the request body; [ADR-0287](0287-the-authority-does-not-delete-a-generation-and-erasure-is-an-account-operation.md) at its per-object economics, which no longer apply.
- **Relates:** [ADR-0289](0289-the-folder-is-where-a-generation-is-minted-from-not-a-surface-kept-current-for-its-own-sake.md), [ADR-0292](0292-a-database-opens-an-exact-generation-cache-first-and-bootstraps-account-misses.md), [ADR-0295](0295-a-database-is-one-yjs-document-and-a-row-holds-its-rich-content.md), [ADR-0296](0296-rich-content-is-a-declared-field-and-a-table-owns-its-file-codec.md)
- **Unbuilt:** the ledger's tombstone-sever-sweep half. `DELETE` is not
  implemented and a generation is never removed, which is the safe half to be
  missing. Everything else is built: `createGeneration` posts one whole state,
  `GenerationsLedger` allocates and admits, and the blob is stored in the
  generation's own authority as its first snapshot.

## Context

The folder is the human-readable source of a new generation: `kv.json` and one
Markdown file per row. Uploading those files individually needs a temporary
upload identity, a manifest, a completion protocol, and a cleanup path for
partial generations. The client already owns the codecs, and a database is one
Yjs document, so the client can parse the folder, build that document, and send
its state as one binary body the authority stores without interpreting.

The vocabulary here is `import` and `export`, and the noun is a folder. "Mint"
named the same act when the number was the interesting part; the number is
assigned, which is what `publish` used to describe, and neither word survives.

## Decision

**Importing a folder is the only way a generation comes into being, and the
client never chooses the number.**

```txt
folder or zip
      │  client parses it with the application's own codecs
      │  and builds ONE fresh Yjs document
      ▼
  encodeStateAsUpdateV2(doc)          one call, one blob
      │
      ├─ with an account ─▶ POST it; the authority assigns n
      └─ no account ──────▶ the device assigns n by reading its own addresses
      │
      ▼
  write the blob to IndexedDB at that generation's address
      ▼
  redirect to the generation's URL; openDatabase finds a cache hit
```

Both paths end identically. The only asymmetry is who assigns `n`. A local-only
database is not a second feature: it is the same operation with the network step
removed, which is what makes a device without an account able to create one at
all.

The local write happens strictly *after* the number is known, because the
address contains it.

**On the authority: store the blob, then write the ledger row. A generation
exists if and only if its ledger row exists.** The row is the last write, and
nothing before it is observable, not by the bootstrap GET and not by the
generations list. There is no publication step, no completeness marker, and no
application-document-written-last convention: those were artifacts of a
multi-request upload where no single party saw the whole thing.

The blob is stored **whole**, as one object. The authority does not unpack it,
does not run an application codec, and does not interpret a field. Bootstrap
serves those same bytes verbatim.

**Recovery is by listing, not by an idempotency key.** If a response is lost
after a generation was created, the client lists generations and compares the
maximum with what it held before the request. Higher means the import landed and
that is its number; unchanged means it did not. The rule is therefore: **never
retry an import blindly; list first.** The uncovered case is two devices
importing to the same account in the same moment, which is accepted as known.

## Consequences

- A partial upload cannot create a usable generation. The complete request is the
  upload boundary and the ledger row is the truth.
- Import and bootstrap share one representation, so there is no second snapshot
  format, no zip on the wire, and no per-file upload loop.
- The client runs the codec exactly once. The authority stays application-blind
  while still able to store and serve state.
- The number is monotonic authority state. It is never selected by a device,
  inferred from client ids, or kept in a synchronized document.
- A crash after the blob is stored and before the ledger row leaves one nameless
  object. That is the whole orphan story, because there is one object rather
  than one per row.
- ADR-0287's economics no longer apply: a generation is one object, not 30,001,
  so the per-object overhead it priced at 8.2 times the content disappears along
  with the object-creation rate limit it flagged as unquantified.
- The body is the whole database in one request. The edge caps a request at
  100 MB and an isolate at 128 MB, and the ceiling that binds first is the
  authority's hydration budget (ADR-0295). Measured since: an 8 MB state,
  nearly four times the enforced SQLite value cap, imports and serves back with
  its bytes intact inside `workerd`, so the transfer is not what binds
  (`evidence/workerd/results.md`, experiment 5). A staged transport, if it is
  ever needed, must preserve the same rule: the number is assigned only after
  the complete state has been accepted.

## Considered alternatives

- **Allocate the number first and upload into it.** Refused. It exposes a number
  before the state is complete and requires the client to manage ordering,
  pacing, partial failure, and abandoned generations.
- **Upload the folder's files individually.** Refused. It creates a temporary
  upload protocol that buys nothing over one request.
- **Upload a zip for the authority to parse.** Refused. The authority does not
  run application codecs.
- **Unpack the state into per-document objects at rest.** Refused with the
  N-document model itself (ADR-0295). It would make an import N+1 writes, scatter
  a crash into N orphans, and force bootstrap to reassemble what it could have
  served verbatim.
- **A client-generated import id for idempotency.** Refused for now. Generations
  are monotonic and a person is effectively the only writer, so listing already
  answers the question a key would answer, without a new field.
