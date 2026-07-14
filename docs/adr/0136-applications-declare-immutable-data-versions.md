# 0136. Applications declare immutable data versions

- **Status:** Accepted
- **Date:** 2026-07-13
- **Supersedes:** [ADR-0134](0134-application-data-generations-own-immutable-workspace-namespaces.md)
- **Amends:** [ADR-0135](0135-new-builds-ask-before-initializing-a-new-data-generation.md)

## Context

ADR-0134 established the correct isolation boundary but named its
developer-authored ordinal a data generation. That term is harder to explain
beside the authority-minted records epoch, even though the two values have
different owners and lifecycles. The application identity has not been
published, so the clean-break implementation can choose one vocabulary and one
durable representation without aliases.

## Decision

An application declares a positive, increasing `dataVersion` for each immutable
durable contract it understands. The framework derives `<appId>-v<number>` as
the workspace ID. Records, synchronized KV, child-document identities, and
app-owned blobs all remain isolated by that derived namespace.

An append-only application data version lock records each published version,
its derived workspace ID, its records schema hash, and every other durable-plane
identity token. Its canonical format is
`epicenter.application-data-version-lock/1`; applications store it as
`data-version-lock.json`. Published entries may only gain a new tail entry.

`recordsEpoch` keeps its narrower protocol meaning. The records authority mints
it when one synchronized records history is created or replaced inside a data
version. Applications do not author it, and changing it does not create another
workspace namespace. The synchronization server remains unaware of application
data versions and predecessor relationships.

ADR-0135's boot state machine is unchanged. Its references to a generation mean
an application data version under this vocabulary.

## Consequences

- Developers author `appId` and `dataVersion`; they never author `workspaceId`
  or `recordsEpoch`.
- Data version N uses `<appId>-vN` consistently in OPFS, SQLite identity,
  synchronized KV, child documents, blobs, and records routing.
- Source directories use `src/versions/vN`, and lock tooling verifies that
  source layout against the committed lock.
- The old `dataGeneration`, `-gN`, generation-lock format, and generation source
  layout have no aliases or fallback readers.
- Product copy can say "version" without exposing the internal records epoch.

## Considered alternatives

- **Keep data generation.** Rejected: it is technically defensible but adds a
  second lifecycle noun where ordinary version language is clearer.
- **Call both values epochs.** Rejected: the developer-owned contract ordinal
  and authority-owned history fence do not share ownership or transition rules.
- **Rename `recordsEpoch` to `recordsHistoryId`.** Rejected: epoch precisely
  describes replacement and stale-history fencing in the records protocol;
  changing the app-facing term removes the ambiguity without weakening that
  protocol concept.
