# 0385. Initial generation selection is a server commit

- **Status:** Proposed
- **Date:** 2026-09-09
- **Implementation:** The current-authority transaction and Worker adapter exist. The library-ownership execution spec tracks integration and runtime verification.

## Context

Two devices can both observe an empty library, create separate seeds, and cache
different histories. A browser lock coordinates tabs within one profile, not
independent devices.

The first proposal reserved an initial number in a separate generation ledger,
seeded another authority, then admitted it. That protocol overlapped the single
current authority in [ADR-0379](0379-reconstruction-is-an-explicit-destructive-library-operation.md).
The user selected one current generation per stable library and reopening through
normal bootstrap after a full document reload.

## Decision

**The stable library authority atomically ensures one current generation.**
It owns the generation number, baseline, update log, and generation-bound socket
admission in one serialization domain. Initialization creates the complete first
baseline and its current number in one transaction. A retry or concurrent caller
receives the existing canonical state. No separate initial-generation owner or
publication ledger participates in startup.

The response binds snapshot bytes to their generation and snapshot position.
The socket supplies any later log entries. A client installs the returned bytes,
never its submitted seed; the losing initializer must not retain a different
state under the winning number. Nonempty input and a streamed 16 MiB ingress
limit are checked before the transaction.

An established replica opens from its local cache before network access. An
absent usable cache calls ensure-current directly. A failed request does not
prove that a remote library is empty, authorize a new history, or select Local.
The cache atomically installs its generation header and baseline. Generation
admission precedes sending pending edits.

The library address distinguishes the application and Personal versus Shared.
Personal ownership comes from the authenticated actor; Shared uses the same
remote address for admitted actors on that deployment. Local replicas additionally
retain the actor so account replacement cannot submit another person's queue.

This is a fresh-library integration, not a migration. Historical numbered
libraries remain untouched. The Personal startup route refuses an existing
admitted historical ledger rather than selecting its largest number or silently
opening an empty replacement. Historical `instance` data is not assigned to a
named user. Rollout and explicit migration remain separate decisions.

## Consequences

Initialization, write admission, and future replacement share one transaction
owner. A restore can retire the current generation without coordinating a
separate pointer and independently writable authorities. Backup/restore
orchestration remains the work described by ADR-0379 and ADR-0386.

The old ledger remains only as historical storage and a migration-refusal check;
it is not a second production initialization protocol. Library selection and
restoration both return through ordinary page bootstrap after their respective
preserve or invalidate departure paths.

## Considered alternatives

- Client-side locks: cannot coordinate independent browser profiles or devices.
- List history and select its largest number: silently chooses a migration policy.
- Reserve, seed, and admit across a ledger and another authority: duplicates
  current-generation ownership and requires distributed publication.
- Cache the submitted seed under the returned number: losing clients retain
  bytes the authority did not select.
- Keep every imported generation writable: reintroduces history selection;
  verified backups are the recovery surface.
