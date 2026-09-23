# 0412. App data addresses name scopes, not libraries

- **Status:** Accepted
- **Date:** 2026-09-18
- **Amended by:** [ADR-0417](0417-a-data-address-holds-one-document.md) withdraws document-generation retirement propagation while retaining App cancellation and existing address bytes. [ADR-0423](0423-app-resources-open-as-independent-handles.md) withdraws nested App handle and aggregate lifetime assumptions while preserving existing durable address bytes.
- **Amended by:** [ADR-0416](0416-defer-server-wide-shared-data.md) removes Shared from supported data scopes; personal addressing and durable identities remain.
- **Amends:** [ADR-0375](0375-local-and-personal-data-preserve-named-account-ownership.md) and [ADR-0392](0392-product-boundaries-provide-required-resource-handles.md) at terminology and public data metadata.

## Decision

An App exposes device data and the captured Account's personal and applicable
shared data. Each exposes tables, KV, and capabilities. There is no separate
library entity or public selection handle. Application UI names its content,
such as notes, rather than describing a storage implementation.

Acquisition uses `scope: 'device' | 'personal' | 'shared'`. Server addressing
uses `scope: 'personal' | 'shared'`; the server resolves the authenticated
actor and enforces whether Shared is available. Current-data acquisition is
`POST /api/apps/:appId/:scope/data/:dataId/current`; synchronization carries
`scope` in its query. Browser clients, the desktop credential broker, and
server endpoints change together. There is no legacy protocol alias.

Returned data handles do not repeat their scope as metadata. Callers already
select `app.device`, `app.account.personal`, or `app.account.shared` explicitly.
Retirement uses the App's abort signal. The unused replacement promise is
removed; public opening returns only ready Apps and cleanup failure remains
terminal.

`openApp` owns cross-document admission through `claimApp` and reports
`AppClaimError`. One component-owned App does not exclude another browser tab.
Admission stays held when cleanup cannot prove resources safe to release.

Physical storage prefixes and exclusion tokens retain their existing bytes.
They are opaque identities, not runtime vocabulary. Renaming them would open
a different data location or permit concurrent ownership by an already-open
window. This decision neither migrates nor deletes existing data.

## Consequences

The active API has one ownership model: App lifetime, data scopes, and their
tables and KV. Storage-engine terminology remains accurate inside persistence
and replication code. Generic software-library prose, license text, historical
records, and unrelated applications' UI policies are outside this terminology
change.

A deployment updates both protocol ends together. Older clients do not gain a
compatibility path. Preserving storage identity does not preserve the old API.
