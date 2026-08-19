# 0064. The Local Books mirror keeps one realm CDC cursor; table existence is the per-entity init latch

- **Status:** Accepted
- **Date:** 2026-06-25
- **Amended by:** [ADR-0250](0250-the-local-books-mirror-artifact-is-the-schema-authority-and-browse-is-a-generic-sqlite-inspector.md): the per-entity init latch is a `full_pulled:<Entity>` key in `_meta`, not table existence (tables now exist from open); the one-realm-cursor decision stands.

## Context

QuickBooks CDC is a high-water-mark protocol: `changedSince` is a single
timestamp for a multi-entity call, and one request returns a per-entity change
map. The mirror nonetheless keyed its sync state by entity (`_sync_state`, one
`cdc_cursor` per type), so an incremental pass over the 16-entity posting set
stored 16 bookmarks for what CDC treats as one value and fired 16 sequential
`/cdc` calls where one would do. The mirror is box-local and re-pullable, so it
carries no durable contract and a cleaner shape costs only a one-time resync.

## Decision

The **realm** owns one cursor. Move `cdc_cursor`, `last_full_pull_at`, and
`last_synced_at` into `_meta`, delete `_sync_state`, and run one batched
`/cdc?entities=<all>` call per incremental pass that advances the single cursor
in the same transaction as the rows it accounts for.

"Has this entity had its first full pull?" is answered by **whether its table
exists** (`isInitialized = tableExists`), so there is no per-entity sync-state at
all: the tables are the latch. An incremental pass backfills any configured
entity with no table (a full query of its history) before the batched CDC, then
CDCs the rest. A `--full` / window-expiry / staleness pass full-pulls every
entity (each its own query endpoint, an honest asymmetry) and resets the cursor.
The cursor advances only on a clean pass, so any failure re-pulls its window next
time rather than skipping it. A `SCHEMA_VERSION` mismatch drops the derived
tables and clears the cursor, forcing one full resync instead of carrying a
migration reader for a re-derivable cache.

`--entity <name>...` becomes a targeted FULL repair of those tables that
deliberately does **not** move the realm cursor (advancing it would skip the
entities the repair did not touch).

## Consequences

- The model shrinks to two sentences: the mirror is caught up to time `T`; each
  pass pulls everything changed since `T` in one call and advances `T`. One
  cursor, one call, no `min()` reconciliation, no redundant bookmarks.
- Adding an entity to `ENTITY_DEFS` backfills **only that entity** on the next
  sync (its table is missing); the rest stay incremental. No operator step, and
  no whole-mirror rebuild.
- A partial full pull self-heals: the entity that failed has no table, so the
  next pass backfills it through the same latch.
- Failure isolation on the incremental path moves from per-entity to per-batch.
  Acceptable: CDC is one HTTP call capped at 1000 objects/entity, so re-pulling
  the batch is cheap and idempotent.
- `status` shows the cursor, last full pull, and last synced once at the realm
  level; per-entity it shows row counts and flags only the uninitialized case.
- Forecloses per-entity cadence and per-entity incremental failure isolation. We
  do not want them: one cron drives the whole sync, and "re-pull" is the only
  recovery either way.

## Considered alternatives

- **Per-entity cursor + min-fetch hybrid.** Sixteen owners for a one-owner value;
  the divergence it modeled never happens except when we force it.
- **Realm cursor + a stored entity-set hash.** Detects a set change but cannot
  say *which* entity is new, so it rebuilds the whole mirror to add one table;
  and a partial full pull leaves a silent hole (the hash still matches) until the
  staleness backstop fires. Table existence is both cheaper and more precise.
- **Realm cursor + a shrunk `_sync_state(entity, initialized_at)` latch table.** A
  whole table for one boolean the entity tables already imply. The tables are the
  latch; storing it twice earns nothing here (the one write-back path,
  `recategorize`, reads-before-writes, so it cannot forge a table for an
  un-pulled entity).
