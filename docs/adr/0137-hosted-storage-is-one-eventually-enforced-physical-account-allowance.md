# 0137. Hosted storage is one eventually enforced physical account allowance

- **Status:** Accepted
- **Date:** 2026-07-17
- **Amended:** 2026-07-17: enforcement moves entirely to capability issuance.
  The allowance gates creation of new storage-producing capabilities (replica
  enrollment, hosted workspace creation, new blob upload grants) and never
  participates in row synchronization or semantic row folding (ADR-0131).
- **Implementation note:** 2026-07-22: the Scalar V1 clean break removed the
  old Workspace enrollment and creation service. No current Scalar V1 route
  enforces this allowance. The policy remains accepted, but implementation is
  deferred until a current account-lifetime capability boundary is designed;
  the deleted Workspace service must not be restored as a shortcut.
- **Relates:** [ADR-0075](0075-self-host-is-a-single-partition-instance-behind-one-operator-supplied-bearer.md), [ADR-0076](0076-the-relational-auth-substrate-is-a-cloud-only-layer-the-instance-composes-neither.md), [ADR-0089](0089-the-blob-store-is-a-presigned-s3-kernel-and-the-bucket-is-its-only-index.md), [ADR-0131](0131-row-sync-folds-sealed-row-intent-rounds-without-refusal.md)

## Context

Epicenter Cloud must offer permanent hosted storage on Free without requiring a
card or turning quota enforcement into a distributed accounting protocol.
Logical user-owned bytes would require format-aware attribution, while exact
account quotas across independent workspace authorities and object storage
would require reservations, debt, or a central write coordinator.

## Decision

Epicenter Cloud meters one physical storage quantity per account: the sum of
the latest absolute `databaseSize` observation for every hosted workspace plus
the hosted blob bytes under that account.

Free has one account-wide included allowance with no overage, debt, expiry, or
automatic deletion. The allowance is enforced at exactly one kind of moment:
when Cloud is about to create a new storage-producing capability. The current
Scalar V1 implementation does not yet expose that account-lifetime admission
boundary, so it does not claim quota enforcement. When that boundary lands,
Cloud refreshes every registered authority's absolute `databaseSize`, combines
those values with the hosted blob observation, and refuses the capability when
the total has reached the allowance. An unseen target is not contacted or
registered before that decision. Once admitted, Cloud registers the unseen
source at zero bytes and only then creates the capability. A later issuance
refreshes its absolute authority size. Refusal or a failed registry write
leaves no target authority, source observation, or replica receipt.

Row synchronization never consults storage state. An enrolled replica's
structurally valid durable RowIntents always enter authority order
(ADR-0131); honest offline backlog may exceed the allowance without a fixed
local ceiling, and an over-allowance account may at most receive an
informational warning, never a mutation gate. Reads, downloads, exports,
workspace deletion, record deletion, and blob deletion are always available.
Falling below the allowance (through deletion or upgrade) restores capability
issuance at the next attempt, because admission reads current absolutes
rather than a cached projection.

Enforcement is eventually consistent. Epicenter accepts the overshoot an
already-issued capability can create between issuance checks. It does not
build distributed reservations, byte-perfect quota checks, pending-byte
accounting, quota leases, or customer debt to recover that overshoot. Abuse
suspension and authorization revocation remain separate operational
controls.

Paid plans use the same physical meter and the same capability boundary with
larger included allowances and overage. A downgrade may leave an oversized
account unable to create new capabilities, but it never deletes data, gates
synchronization, or creates retroactive debt.

Allowance sizes, paid-plan grants, overage prices, reconciliation cadence, and
operation ceilings are mutable catalog or implementation values, not parts of
this decision. The policy is Cloud-only; a self-hosted instance does not compose
Epicenter billing or account quota policy.

## Consequences

- One absolute meter serves enforcement, billing, and the dashboard. There are
  no logical-byte, per-workspace, per-app, per-table, or per-replica balances.
- The sync request path carries no storage policy: no per-exchange
  observation, no eagerly maintained projection row, and no billing-provider
  call. The billing provider is consulted once per issuance attempt.
- The retained `storage_observation` table is the account's source registry and
  last-observed cache for the future gate. Current account deletion still uses
  it to find and remove owned authorities; no current request reads it as quota
  enforcement.
- If the issuance decision cannot be computed, enrollment fails closed and
  retryably; nothing else depends on it.
- Physical usage is page-granular. A small record deletion need not lower
  `databaseSize` immediately, so issuance may stay refused until a later
  attempt observes the lower total.
- Paid plans use the same capability boundary with larger included allowances
  and overage; pushing reconciled usage to the billing provider for overage
  billing is a later, non-request-path concern.
- Exact enforcement, overshoot debt, automatic cleanup, paid hard caps, and
  storage expiration are deliberately refused.

## Considered alternatives

- **Meter logical user-owned bytes.** Rejected because every format and storage
  owner would need durable attribution and agreement on what counts.
- **Bill physical bytes but enforce a logical Free quota.** Rejected because two
  meters would create customer disagreement and reconciliation machinery.
- **Reserve account bytes before every write.** Rejected because exactness would
  require a distributed coordinator across workspace authorities and blobs.
- **Recover overshoot as debt or deletion.** Rejected because Free's permanent,
  no-surprise storage promise is more valuable than byte-perfect enforcement.
- **Enforce the allowance inside synchronization (binary delete-only state).**
  Built, then deleted by the 2026-07-17 amendment. Gating sealed rounds
  required a per-exchange growth decision, an eagerly maintained
  `growth_allowed` projection, an after-exchange observation hook with one
  billing call per sync, and a protocol refusal-and-recovery family
  (ADR-0131's deleted submission watermark). Capability issuance is the
  narrower door: it bounds new growth surfaces while every enrolled replica's
  durable edits keep their unconditional path to the authority.
