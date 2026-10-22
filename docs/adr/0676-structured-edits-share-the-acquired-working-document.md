# 0676. Structured edits share the acquired working document

- **Status:** Accepted
- **Date:** 2026-10-22
- **Amends:** [ADR-0668](0668-one-folder-owned-source-orders-file-publications.md) at table edits, source acquisition, and failed structured publications. Synchronous disposal remains independent.

## Context

A table set previously composed a separate publication from held text, or read
and composed inside the path lane when no text was known. Its failed payload
was not accepted into the working document. Meanwhile list, get, and raw reads
fed source acquisition through their own ordering and invalidation bookkeeping.
Ordinary structured edits therefore differed from typing followed by save.

## Decision

`table.set(id, change)` patches an acquired working document immediately. It
captures and admits that exact publication before notifying observers. Later
edits build on the accepted patch; a failed publication retains it and its
save error. The awaited result reports the captured publication, even when
newer input is pending. Before acquisition, set refuses with `NoContent`.

`table.write(id, document)` publishes a complete row from fields and body,
creating or replacing the file unconditionally. Omitted content is empty.
It accepts no pending input on failure. This is the creation path: a failed
submission with a newly chosen ID cannot later autosave into an orphan file.
Raw file writes and deletes keep the same detached command behavior.

Lists, gets, and raw reads return stored data without populating or updating
working documents. A subscribed editor acquires its own source. An action on
an unopened or inactive document explicitly awaits `edit.refresh()` before
patching. Refresh preserves dirty input. A fresh list must not be overlaid
with a clean inactive editor's stale retained text; only dirty input overrides
stored rows in relationship decisions.

All publications still share one FIFO lane per path. Success acknowledges only
the input captured at admission. Outside changes follow clean observed sources;
accepted dirty input remains local until publication or discard. Full local
publication remains last-write-wins across independent writers. Neither set nor
write provides create-only or conflict detection.

## Consequences

Cold asynchronous patch composition and read-side source ingestion disappear,
along with their cross-read observation counters and hints. The app must choose
complete submission or an acquired-document edit; cold actions perform one
explicit read. Visible editors can read a row that a list already returned.

The distinction protects failed creation retries while giving ordinary edits
one acceptance, autosave, failure, and retry workflow. It does not remove path
ordering, intent identity, atomic storage publication, or synchronous disposal.
