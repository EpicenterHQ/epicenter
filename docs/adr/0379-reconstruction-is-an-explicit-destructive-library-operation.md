# 0379. Storage maintenance does not require a restore product

- **Status:** Proposed
- **Date:** 2026-09-09
- **Amends:** [ADR-0276](0276-an-authority-holds-a-numbered-succession-of-generations-and-nothing-is-ever-overwritten.md) at product recovery: storage maintenance preserves live lineage, and no restore-over-live product is required. Existing generation mechanisms remain subject to a caller audit.
- **Relates:** [ADR-0385](0385-initial-generation-selection-is-a-server-commit.md) (initialization and admission), [ADR-0394](0394-a-backup-is-the-library-s-folder-kept-by-the-authority.md) (document-only materialization), [ADR-0395](0395-restore-is-one-request-that-carries-its-own-safety-copy.md) (recovering content through Push).
- **Implementation:** Current-generation startup, cache invalidation, authority activation, and App retirement exist. This decision changes the product direction; it does not remove those mechanisms.

## Context

The earlier draft coupled storage maintenance to a backup catalog and destructive
restore. It required a safety copy, generation replacement, and loss of old
unsynchronized work as parts of one recovery feature.

The selected recovery workflow instead brings old readable content into the
current working copy and applies ordinary edits through Push. A backup catalog,
restore route, and restoration UI are deferred. They are not prerequisites for
the independent local and remote blob APIs.

## Decision

**Ordinary storage maintenance preserves the live document lineage. Recovering
readable content uses the working copy, not generation replacement.**

Folding combines persisted updates representing the same CRDT lineage. The
acknowledged-log fold replays updates into a temporary `gc: true` document,
then encodes a complete update; unsynchronized outgoing updates are handled
separately. Replaying into a temporary document is not reconstruction into new
operation identities. Measure folded bytes, tail bytes, and cold-open costs
before introducing destructive maintenance.

Push applies normal row and setting changes. It neither retires other devices
nor discards their pending edits. Recovering a deleted record creates a new row;
it does not revive a deleted CRDT identity.

**Existing generation and retirement safeguards remain. Remove unused backup
orchestration only after separating its callers from those safeguards.**

The stable library authority owns initialization and admission. A usable local
cache permits offline opening; an absent cache needs a complete authority
baseline. Network failure never proves that the library is empty or retired.
Admission precedes sending pending edits on a connection.

Where the existing authority confirms retirement, the client fences old writes,
invalidates its cache under its ownership claim, closes producers and resources,
and reloads through ordinary bootstrap. These are constraints on existing code,
not a promised restore feature. Retiring row state does not delete independently
stored blobs.

Do not set every generation to a constant, remove admission checks, or delete
retirement handling merely because no restore UI is planned. Audit production,
fixture, and test callers first. A future destructive replacement needs its own
product decision and proof of its loss boundary.

## Implementation evidence

`packages/data/src/sync/authority.ts` contains activation and retirement.
`packages/data/src/store/current-cache.ts` owns durable cache state.
`apps/honeycrisp/scripts/library-retirement.ts` drives activation through a
test-only service binding and exercises stale devices, invalidation, and reload.
It is evidence for the mechanism, not an exposed recovery workflow.

The 2026-09-17 caller audit found no app mounting for
`packages/data/src/recovery.ts`, its recovery journal, or the backup-specific
S3 wrapper. These are removal candidates, not features awaiting transport.
The structural JSON archive still supports the retirement script; replace that
fixture dependency before deleting the format. Markdown rendering and checkout
are separate and remain live.

The authority exposes backup and attempt methods and creates restore-attempt
schema during production construction. Removal therefore requires a coordinated
authority edit, not just deleting unmounted files. Ordinary `capture()` supplies
the startup baseline and must remain. Activation receipts need a separate check
against fixture retry guarantees; no persisted-data deletion follows from this
audit.

The [implementation plan](../../specs/20260909T010040-current-generation-restore.md)
records callers, removal order, and preserved evidence. Do not mount recovery
transport or remove admission, offline-cache, retirement, or historical-data
guards to satisfy this record.

## Consequences

Storage performance work can proceed without a recovery product. The selected
folder workflow does not promise exact CRDT history, rollback of a whole library,
or restoration of missing blob bytes.

## Considered alternatives

- Build server backups and destructive restore first: adds retention, activation,
  and cross-device loss semantics the selected workflow does not require.
- Replace document identities during automatic maintenance: can discard offline
  edits and requires a separate authorization and admission protocol.
- Delete all generation code with the restore proposal: confuses an unused
  product workflow with implemented startup and synchronization safeguards.
