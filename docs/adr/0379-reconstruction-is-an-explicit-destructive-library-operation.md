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

The 2026-09-17 cleanup removed the unmounted backup coordinator, journals,
catalog, restore attempts, backup-specific S3 wrapper, and structural JSON
archives with their dedicated tests. Authority construction no longer creates
restore-attempt schema or exposes backup, attempt, or receipt-query methods.
Ordinary `capture()` still supplies startup baselines.

Activation keeps its persisted `_restore_receipts` table and transactional
position/digest checks. A retry after a lost response or authority restart still
returns the committed outcome, including after a later activation. Existing
backup/attempt tables and stored objects are left untouched; removing their
code performs no persisted-data cleanup.

The Honeycrisp retirement fixture now authors valid notes in a fresh memory
store for each replacement and asserts that its writers are disjoint from the
current captured lineage. It preserves cross-device retirement, stale-upload
refusal, invalidation, and ordinary reload coverage without archive semantics.

Preserved evidence lives in the data package's checkout, current-open,
store-retirement, and current-generation authority/hub tests; the server's
current-retirement Worker and library-ownership fixtures; and the Honeycrisp
browser journey. The whole-document Markdown `readArtifact` API remains
separate from structural archives and ordinary Push.

The cleanup plan is retired. Its caller audit and historical evidence remain
in Git at `16f8d418f4`; earlier probes remain at `db70c7833b`. No recovery
transport, new recovery UI, automatic blob synchronization, or data deletion was
introduced.

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
