# 0115. Local Photos deletes only from local tombstones, not source absence

- **Status:** Proposed
- **Date:** 2026-07-09
- **Relates:** [ADR-0114](0114-local-photos-is-an-import-ledger-not-a-google-photos-sync-client.md) (Local Photos is the archive owner, not a Google Photos mirror), [ADR-0061](0061-local-books-reads-facts-from-the-mirror-reports-live-and-writes-through-one-approved-verb.md) (contrast with provider-owned mirror semantics), [ADR-0098](0098-local-mail-state-round-trips-through-gmail.md) (contrast with human state that round-trips through the provider)
- **Spec:** [Local Photos: a Takeout-native import ledger, not a Google Photos sync client](../../specs/20260709T000000-local-photos-import-ledger.md)

## Context

A provider-owned mirror can treat upstream disappearance as a meaningful event when the upstream sends a delete or tombstone through a real changefeed. Google Photos Takeout does not provide that signal. Full Takeout exports are snapshots, scheduled incremental Takeout is additive, and neither source is documented as a deletion or album-removal feed. Because Local Photos is intended to own the local archive, treating absence from a later export as deletion would risk destroying the user's only durable copy based on a non-signal.

## Decision

Local Photos deletes only from explicit local tombstones. A source no longer mentioning an asset, album, sidecar, or metadata claim is never a delete command. It means only that the claim is stale, unobserved in that import, or absent from that source's latest evidence.

Imports create evidence, not destructive mutations. They may add blobs, import items, claims, albums, album-membership claims, and normalized asset updates derived from claims. They must not hide, unlink, purge, or delete an asset because a later import failed to mention it. Read models hide assets only when a local tombstone exists; blob purging is a separate local retention decision after tombstoning.

## Consequences

- Deletion has one owner: the local user action or local policy that creates a tombstone. Google Photos, Takeout, Picker, folder scan, or device import absence cannot create one implicitly.
- Source status is a report, not a mutation. Local Photos may say an asset was last observed in a given import, or that a configured source is stale, but those facts do not change archive membership.
- Album membership is provenance. If album A contains asset X in one Takeout and does not mention X in a later Takeout, both facts can be recorded, but the later absence does not remove the earlier membership claim.
- The archive is safer than a mirror but less faithful to remote deletion. A photo deleted from Google Photos will remain in Local Photos until the user deletes it locally.
- Resolver improvements can change normalized asset fields, but they cannot convert source absence into deletion. The invariant belongs below the resolver.
- Any future provider that supplies explicit tombstones needs a new decision before those tombstones can become local tombstones. The default remains evidence first, destructive action only by local authority.

## Considered alternatives

- **Treat absence from a later Takeout as deletion.** Rejected: Takeout is not a changefeed, and scheduled incrementals are additive. Absence is ambiguous and too dangerous to map to deletion.
- **Mirror album membership exactly from the newest import.** Rejected: album omission may reflect export shape, source limitations, or incremental semantics rather than a user removal. Membership must remain a claim with provenance.
- **Allow source-specific delete rules.** Rejected for v1: this recreates deletion reconciliation before any source has earned that authority. A future source with explicit tombstones can propose a narrower rule.
- **Soft-delete locally when all configured sources stop mentioning an asset.** Rejected: multiple weak absences do not become a tombstone. The local archive is the system of record.
