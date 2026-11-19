# 0003. Stored entries reconcile to three visible states

- **Status:** Accepted
- **Date:** 2026-06-15

Supersedes ADR-0002. It also amends the
bucket list in ADR-0001: `scan()` now
returns three buckets, not four.

Every stored table entry resolves to exactly one of three states (conforming,
nonconforming, newer-writer), and `storedCount()` equals the sum of the three
`scan()` buckets. The fourth state from ADR-0002, `unreadable`, is gone.

`unreadable` only ever existed because of encryption: a row whose key version
was missing from the keyring decrypted to nothing, so it had to be surfaced
rather than silently skipped. The trusted-relay change removed the entire
workspace encryption layer (`@epicenter/encryption`, the keyring, and the
encrypted key-value wrapper), so a stored entry is now either valid bytes or a
schema mismatch. There is no undecryptable row left to model, and the
`ObservableKvStore` tri-state read (`read()` / `present` / `absent` /
`unreadable`) collapses to plain `get()`, `has()`, `entries()`, and `size`.

## Consequences

The write guard simplifies. The `UnreadableRefusal` on `set()` / `bulkSet()` /
`clear()` and the `UnreadableRow` report on `get()` / `update()` are removed; the
newer-writer refusal stays, because a stale binary still must not clobber a row
written by a newer one. `delete()` remains unguarded.

The sum identity still holds with one fewer term: `storedCount()` equals
conforming plus nonconforming plus newer-writer. The point of the identity is
unchanged: the model has no gap, so no row can sit in storage invisible to every
read.
