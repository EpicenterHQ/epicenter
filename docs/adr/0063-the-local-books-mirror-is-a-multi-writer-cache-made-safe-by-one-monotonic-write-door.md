# 0063. The Local Books mirror is a multi-writer cache made safe by one monotonic write door, not single-writer discipline

- **Status:** Accepted
- **Date:** 2026-06-25

## Context

ADR-0061 gave the Local Books mirror a write-back verb (`recategorize_expense`): it writes through to QuickBooks and folds the authoritative response into the mirror. That left the mirror with two writers on one SQLite file, in two separate OS processes: the data daemon (which runs `recategorize`) and `local-books sync` (the CDC refresh command, typically a cron job). The daemon is explicitly designed to serve reads while sync runs.

The write path was written as if it were the only writer. Two failure modes followed, neither covered by the existing tests (which exercise the write-back single-process, single-connection, with no sync running):

- No `busy_timeout` was set, so SQLite defaults to 0: a writer that meets another writer's lock fails instantly with `SQLITE_BUSY`. A `recategorize` whose QuickBooks POST had already committed could then throw on the mirror fold-back, report the *successful* write as a failure, and invite a retry that hits a 409 on the now-bumped `SyncToken`.
- The upsert was a blind last-writer-wins. A stale fold-back landing after a concurrent sync had already ingested a newer bookkeeper edit would overwrite the newer row with older data. Because the CDC cursor had already advanced past that edit, the next sync would not re-emit it, and the mirror would stay diverged from QuickBooks until a full pull.

The bug class was not "two writers" (SQLite supports that). It was "two writers without a shared write contract."

## Decision

The mirror is a multi-writer SQLite cache, and correctness comes from one write contract that is safe for N writers, not from pretending there is one writer.

1. **One concurrency contract, set on every connection** in `openBooksDb`: WAL (readers never block the writer), a `busy_timeout` (a writer waits for a concurrent lock instead of failing instantly), and write transactions run `IMMEDIATE` (the write lock is taken at `BEGIN`, so contention is a bounded wait, never a mid-transaction lock failure). `synchronous = NORMAL` is safe here because the mirror is a re-pullable cache: a lost last-commit on power loss re-pulls, it cannot corrupt the ledger, which QuickBooks owns.

2. **One write door, `ingest`, used by both writers.** `local-books sync` and the `recategorize` fold-back both call `db.ingest(def, { objects, syncedAt, cursor? })`. "A QuickBooks object becomes mirror rows" lives in exactly one place; there is no second write path to make safe. Sync passes a `cursor` to advance `_sync_state` in the same transaction as the rows it accounts for; the write-back omits it.

3. **Every write is monotonic.** A row only ever moves forward by QuickBooks `LastUpdatedTime`: the upsert and soft-delete apply only when the incoming object is at least as new as the stored one, falling back to last-writer-wins only when a timestamp is absent on either side. A stale write cannot regress a newer row, regardless of which writer commits last.

4. **The write-back is best-effort.** QuickBooks is the source of truth, so once its POST commits the operation has succeeded. The mirror fold-back is a latency optimization (a read right after the write sees the change without waiting for the next sync). If it cannot write, the failure is swallowed and the next monotonic sync reconciles the row; it is never reported as the operation failing.

## Consequences

- The two corruption / false-failure modes are now unrepresentable, not merely unlikely: a stale write physically cannot win, and a contended writer waits rather than failing.
- `recategorize` no longer knows the mirror's table layout. It reads through `getLiveRaw` and writes through `ingest`; `db.ts` owns both directions of row access. The agent's read-only SQL surface keeps its own separate connection.
- The mirror's self-heal guarantee now holds even when a fold-back is dropped, because ingest is monotonic and a periodic full-pull backstop already exists.
- The test-only `now` injection on the write-back is gone; `ingest` stamps `synced_at` itself.
- The cost is that `busy_timeout` makes a contended writer wait up to its bound; for the mirror's write volume this is invisible, and it is strictly better than the instant failure it replaces.

## Considered alternatives

- **Make the daemon the single writer (route `local-books sync` through it).** Rejected: it fights the lean standalone CLI (the compiled binary must sync without the agent layer), couples a background-refresh lifecycle to an agent-serving one, and still cannot stop a stray `local-books sync`. The honest topology is N writers; make N writers correct.
- **A `busy_timeout` patch alone, without monotonicity.** Rejected: it fixes the false-failure but not the stale-overwrite divergence.
- **Re-pull the object after the write instead of folding the response.** Rejected: an extra QuickBooks round-trip when the authoritative object is already in hand; folding it through monotonic ingest is both cheaper and correct.
- **Propagate a fold-back failure as the tool's result.** Rejected: it reports a committed QuickBooks write as a failure and invites a 409 retry. The cache is allowed to lag; the source of truth has already moved.

## Reference

- Implemented in `before-0891-layout:apps/local-books/src/db.ts` (`ingest`, `getLiveRaw`, the monotonic upsert/delete, the connection pragmas), `src/sync.ts`, and `src/agent/recategorize.ts`. Builds on ADR-0061 (the write-back verb) and ADR-0047 (the mirror as a data daemon). Committed in `7f577fb293`.
