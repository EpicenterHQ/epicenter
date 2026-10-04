# 0147. Cross-plane transfer and recovery use logical coordination, not atomic snapshots

- **Status:** Superseded
- **Date:** 2026-07-17
- **Superseded by:** [ADR-0161](0161-each-person-has-one-epicenter-replicated-on-each-adapter-boundary.md), [ADR-0167](0167-a-portable-epicenter-is-an-identity-free-export-of-one-authority-cut.md), [ADR-0170](0170-one-live-epicenter-has-sealed-backups-and-restore-creates-a-fresh-authority-lifetime.md), and [ADR-0171](0171-every-durable-local-write-leaves-an-automatic-authority-obligation.md)
- **Amends:** [ADR-0122](0122-logical-records-are-portable-sqlite-files-and-views-are-runtime-state.md), [ADR-0142](0142-bootstrap-history-gaps-and-lineage-mismatches-have-distinct-recovery.md), [ADR-0143](0143-account-open-never-consumes-device-data.md)

## Context

Scalar rows and row documents now have independent client persistence owners.
The existing recovery and Device Add contracts describe one SQLite capture and
one atomic admission of document-bearing row intents, which no longer exists.
Users still need safe logical export, explicit Device-to-Account consent, and a
non-destructive response to divergent restored scalar replicas.

## Decision

Device mode is a permanent first-class mode, not temporary guest storage.
Account open still never consumes Device data automatically. After sign-in an
application may non-mutatingly detect an existing device-local workspace and
offer to copy it into the account; copying is optional, and the Device source
remains after a copy by default. Scalar rows and KV transfer through ordinary
scalar intents. Documents transfer through the document provider under the
same row addresses only after the destination row is locally admitted. The
copy is idempotent (first-create-wins scalar admission, idempotent Yjs
import), so the recovery path for an interrupted copy is simply running it
again.

Deleting the Device source is a separate, explicit, destructive user action
with its own confirmation, never a consequence of a copy. No automatic
delete-after-copy exists, so no verification machinery gates it: a create the
authority silently refuses (for example at a retained deletion marker) leaves
that row absent from the account while the Device source still holds it.

Logical export and recovery coordinate the two planes but do not claim one exact
cross-plane instant. An export captures one scalar cut plus one compact state for
each included document and records which documents were unavailable. It contains
no SQLite pages, replica identity, receipt, checkpoint, provider database, or
network state.

A scalar lineage mismatch still stops scalar networking while preserving local
reading and editing. Recovery exports the visible scalar replica and every
locally available document into a separate reviewable copy, starts a fresh
scalar lineage only after that copy is preserved, and recreates selected content
through ordinary scalar and document operations. Epicenter never merges private
SQLite histories or provider databases automatically.

Fresh scalar acquisition and long-offline scalar rebuilding remain automatic.
They do not acquire every row document. A document becomes locally offline-ready
when opened or explicitly downloaded. An export that requires a document absent
from the device must fetch it while online or report it as unavailable.

## Consequences

- No global transaction or settlement barrier spans SQLite rows and every lazy
  document provider.
- Device Add is crash-safe through source preservation and idempotent logical
  retries, not one destination SQLite transaction.
- Device deletion has no automatic trigger and no verification gate; it is an
  explicit destructive user action, and the copy's safety comes from the source
  remaining in place.
- A device may hold a complete scalar workspace without holding every document.
- Complete offline export of never-opened documents is refused; the export
  result reports incompleteness instead of silently omitting it.
- Restored runtime stores remain internal artifacts rather than portable backup
  formats.

## Considered alternatives

- **Hydrate every document on every device.** Rejected because it recreates a
  document acquisition protocol and defeats lazy document storage.
- **Present export as an atomic snapshot.** Rejected because independent
  persistence and network owners cannot provide that promise without freezing
  editing or adding distributed snapshot machinery.
- **Copy provider databases during Add or recovery.** Rejected because it
  transfers private lifecycle and format state rather than logical content.
- **Automatic delete-after-copy, gated on a canonical-liveness verification.**
  Rejected: Device mode is permanent, so a successful copy authorizes nothing;
  the verification family (settled confirmed snapshots, document containment
  checks, missing-address outcomes) existed only to make automatic source
  deletion safe and was deleted with the promise it served.
