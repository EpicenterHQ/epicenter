# Local Photos

Local Photos owns a private photo and video archive on your machine. Google
Photos is one import source; it is not the system of record.

```txt
Extracted Google Takeout
  -> immutable import manifest
  -> content-addressed blobs
  -> provenance claims
  -> resolved, queryable assets
```

An import only adds evidence. If a later Takeout does not mention a photo,
Local Photos keeps it. Only a future explicit local tombstone can hide or purge
an asset.

## Current checkpoint

The first checkpoint imports extracted Takeout directories. It streams SHA-256
hashing, deduplicates blobs, matches common old and supplemental sidecar names,
keeps unmatched evidence with warnings, and resolves sidecar timestamps and
coordinates into SQLite.

Zip ingestion, album metadata, EXIF claims, live-photo pairing, and the gallery
are still open V1 or later work. The design and refused promises live in
[ADR-0114](../../docs/adr/0114-local-photos-is-an-import-ledger-not-a-google-photos-sync-client.md)
and
[ADR-0115](../../docs/adr/0115-local-photos-deletes-only-from-local-tombstones-not-source-absence.md).

## Use it

Run from the repository root:

```bash
bun run --cwd apps/local-photos local-photos import ~/Downloads/takeout-extracted
bun run --cwd apps/local-photos local-photos status
bun run --cwd apps/local-photos local-photos query \
  "SELECT hash, taken_at FROM assets ORDER BY taken_at DESC LIMIT 20"
```

The default archive home is `~/Library/Application Support/local-photos` on
macOS and `$XDG_DATA_HOME/local-photos` or `~/.local/share/local-photos` on
Linux. Pass `--data-dir` or set `LOCAL_PHOTOS_DIR` to override it.

The database is `photos.db`; blobs use `blobs/<first-two-hash-chars>/<sha256>`.
Directories are mode `0700`, and the database and blob files are mode `0600`.
