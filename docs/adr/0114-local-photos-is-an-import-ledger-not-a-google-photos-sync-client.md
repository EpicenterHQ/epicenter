# 0114. Local Photos is an import ledger, not a Google Photos sync client

- **Status:** Proposed
- **Date:** 2026-07-09
- **Relates:** [ADR-0061](0061-local-books-reads-facts-from-the-mirror-reports-live-and-writes-through-one-approved-verb.md) (the mirror/write-through pattern Local Photos refuses), [ADR-0082](0082-local-mail-mirror-is-push-free-polling-collapsing-hosted-vs-self-host-to-one-oauth-client-id.md) (the Gmail CDC mirror pattern Local Photos cannot use), [ADR-0098](0098-local-mail-state-round-trips-through-gmail.md) (the upstream-as-truth rule Local Photos inverts)
- **Spec:** [Local Photos: a Takeout-native import ledger, not a Google Photos sync client](../../specs/20260709T000000-local-photos-import-ledger.md)

## Context

Local Books and Local Mail use disposable local mirrors because their upstreams expose the surfaces a mirror needs: an authoritative provider, a cursor or CDC feed, provider-owned state, and enough API coverage to rebuild local state. Google Photos no longer has that shape. After March 31, 2025, the Library API is app-created-media focused, broad readonly access no longer backs a full-library archive, Picker is a human-selected import flow with short-lived URLs, and Google Takeout is the official export rail. A Local Photos design that promises to sync Google Photos would have to fake a missing changefeed, infer deletes without tombstones, or automate the web UI as its backbone.

## Decision

Local Photos is an import ledger and local archive, not a Google Photos sync client. The local archive owns the durable photo and video collection; Google Photos is one import source among several. V1 imports Google Takeout exports as immutable evidence batches, stores media as content-addressed blobs, preserves raw import evidence, records provenance claims, and derives normalized assets from those claims.

Local Photos refuses the promise to keep a live, exact copy of a Google Photos library. It does not build browser automation as a backbone, does not use the narrowed Library API as a backup path, does not emulate a CDC cursor, and does not introduce a generic provider-sync abstraction until a real provider supplies both a cursor and tombstones. The database is precious, not a disposable cache: schema changes must preserve data rather than drop and rebuild from Google.

## Consequences

- The smallest useful system is one Takeout import command that can hash media, match sidecars, write an import manifest, record claims, and query the resulting archive.
- The asymmetric win is explicit: refusing live Google Photos sync deletes browser automation, the dead full-library OAuth/API path, CDC emulation, deletion reconciliation, and write-through machinery.
- Google Photos parity is not a product contract. Memories, sharing state, exact ordering, face groups, and remote album behavior are outside the v1 promise unless a later source provides honest evidence for them.
- Future sources such as Picker sessions, local folder scans, and device imports feed the same manifest model. They are new `source_kind` values, not new sync backbones.
- Scheduled incremental Takeout, when available, is only another append-only import batch. If it is missing or unreliable, a fresh full Takeout can be re-imported and deduplicated by hash.
- The implementation must treat raw evidence as durable. Import items, sidecars, archive paths, and provenance claims are kept so resolver improvements can recompute normalized assets without re-importing bytes.

## Considered alternatives

- **Build a Google Photos sync client around the Library API.** Rejected: the API no longer exposes full-library read access for backup. Building around it would preserve the sync promise while failing the archive requirement.
- **Use Picker as the v1 backbone.** Rejected: Picker is user-selected import with short-lived URLs, not background library sync or full archive export. It can become an additive source later.
- **Automate photos.google.com.** Rejected: web UI automation depends on login flows, passkeys, DOM details, and attended browser behavior. It is too fragile to own the archive backbone.
- **Start with a generic provider CDC abstraction.** Rejected: no current Google Photos source supplies the cursor and tombstones such an abstraction needs. The abstraction would encode a fiction before one concrete provider earns it.
