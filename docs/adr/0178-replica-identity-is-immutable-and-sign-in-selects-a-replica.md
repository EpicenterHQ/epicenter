# 0178. Replica identity is immutable and sign-in selects a replica

- **Status:** Proposed
- **Date:** 2026-07-23
- **Amends:** [ADR-0161](0161-each-person-has-one-epicenter-replicated-on-each-adapter-boundary.md) by withdrawing the mutable first-attachment model (`Bring`/`Discard`, pre-attachment choice, permanent attach-on-sign-in) and replacing it with immutable replica identity, explicit Lens import, and explicit retirement

## Context

ADR-0161 let one local replica begin unattached and become permanently bound
to whichever principal signed in first, after a whole-replica `Bring` or
`Discard` choice. Implementation proved that model wrong three ways:

- Carrier activation was not takeover-safe. Sign-out parked only the elected
  owner's in-memory supervisor; a replacement worker reconstructed from
  startup-only configuration and could resume synchronization while signed
  out. Worker-local memory had become a second owner of authorization state.
- The composition root opened with an active carrier and called `signIn()`
  before attachment identity was verified, so authorization and ownership
  raced at boot.
- The product decision required user consent before local data joined an
  account, but the only workable composition silently chose `Bring`.

The deeper fault is the ownership model itself: attachment made replica
identity a mutable function of authentication. Logging in could grant an
account access to whichever database happened to be open.

## Decision

Every local replica has an immutable identity, written once at creation:
either permanently unclaimed or permanently owned by one
`(deploymentId, principalId)` pair. No operation reassigns, adopts, clears,
or transfers that identity. There is no attach operation, no `Bring`, no
`Discard`, and no first-attachment choice.

The adapter resolves physical storage as a pure function of identity. The
unclaimed replica and any account replica coexist on the same adapter
boundary: in the browser, the SQLite pool, database file, blob directory,
Web Lock, and worker coordination channel are all derived from an identity
slot; on native adapters, the composition root selects a per-identity
directory. Opening is create-if-absent by identity, and opening an existing
store with a different identity fails; there is no recovery path. No replica
catalog, inventory, or discovery API exists.

Authentication selects and authorizes; it never changes ownership.
Synchronization authority is fixed for one runtime lifetime: an authority
carrier may be supplied only when opening an account-owned replica, and it
never changes afterward. An unclaimed replica refuses a carrier. The runtime
has no `signIn` or `signOut` operations. Signing in means the composition
root opens the account replica with a carrier; signing out means it disposes
that runtime and opens the unclaimed replica without one. Logout therefore
removes synchronization authority without changing replica identity or local
data, and an elected-owner takeover is correct by construction: every
candidate for one identity slot was opened with the same authorization
posture, so no worker-local sign-in memory exists to lose.

After sign-in, if the unclaimed replica contains data visible through the
application's Lens, the application may offer an explicit import. The user
confirms the selection; sign-in itself never imports anything. Import reads
through the source Lens and writes through ordinary destination record
operations, preserving source record keys so a retry rewrites identical
records and a crash resumes safely. It does not copy SQLite rows, replay raw
storage patches, merge databases, or retarget a replica. Ordinary plane laws
decide conflicts: patches compose, destination tombstones stay terminal,
documents join by ordinary exact-state admission, and blobs pass through
ordinary write-once capture.

Only after import success is durably established in the destination may the
application offer retirement: an explicit, destructive, adapter-owned removal
of the unclaimed replica's storage. Retirement refuses while any runtime
holds the slot. Sign-in never retires anything, and retirement never runs
implicitly.

This deliberately reopens ADR-0161's rejection of selective import: the
per-item choice returns as an explicit, Lens-shaped, user-confirmed
operation, because the alternative was a silent whole-replica adoption that
violated consent. It also restores ADR-0143's principle, at replica scope,
that account open never consumes device data.

## Consequences

- The runtime surface shrinks to open, bind, sync status, blocked records,
  and dispose. `attach`, `AttachOutcome`, `proceed`, choice parameters,
  `signIn`, `signOut`, carrier swapping, `attaching-first`, `signed-out`,
  and `unattached` states, worker sign-out memory, and principal-mismatch
  recovery are deleted rather than deprecated.
- A replica without a carrier reports one honest state: local-only. Durable
  obligations recorded while signed out drain on the next carrier-bearing
  open of the same replica.
- An unclaimed replica never synchronizes and never drains obligations; its
  data leaves only through Lens import, and its obligations die with
  retirement.
- Auth state changes are session boundaries. Applications rebuild their data
  session on login and logout instead of mutating a live runtime.
- Switching principals means opening a different replica. Every signed-in
  principal on an adapter pays its own full-replica storage cost; the
  unclaimed replica additionally persists until retired.
- Import cost scales with selected records, not database size, and partial
  import is legal: unselected records simply remain in the unclaimed replica.
- A buggy composition root that pairs an account replica with another
  principal's carrier is constrained by open-time identity verification plus
  the deployment refusing foreign credentials; the storage slot derivation
  makes such pairing require deliberate effort rather than an idle default.

## Considered alternatives

- **Keep mutable attachment but fix takeover safety with durable sign-out
  state.** Rejected: it preserves two owners of authorization truth and the
  entire attachment state machine to protect a model whose product sentence
  (login grants the account whatever was open) is wrong.
- **Runtime-level `signIn`/`signOut` carrier parking.** Rejected: mid-life
  authorization mutation is exactly what made takeover unsafe; a fixed
  carrier per runtime lifetime deletes the state instead of guarding it.
- **Whole-replica automatic import on sign-in.** Rejected: it is `Bring`
  under a new name and still converges data without consent.
- **A replica catalog or profile selector.** Rejected as in ADR-0161:
  opening is create-if-absent by identity; enumeration adds an inventory
  surface with no owner.
