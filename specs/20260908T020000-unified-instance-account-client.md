# Hosted and instance client convergence

- **Status:** In Progress
- **Date:** 2026-09-08

One client connects to a selected server through a verified Account, whether
its credential came from hosted sign-in or operator token entry.

The design is recorded in ADR-0361. This document tracks delivery; the server
composition and public-shell resilience checkpoint is already committed.

## Execution

- [x] Share the credential owner behind concrete hosted and instance constructors.
- [x] Verify static-token enrollment, offline restore, cancellation, replacement,
  local-only disconnection, and foreign-origin refusal alongside hosted lifetime tests.
- [x] Remove the unused instance authority after the replacement tests pass.
- [ ] Add client server selection and token entry. Select one server before
  constructing auth; keep acquisition inside the cancellation boundary.
- [ ] Persist selection and credentials under the selected server identity.
  Coordinate with the active authority-address and desktop-installation work.
- [ ] Integrate desktop selection without sending remote credentials to WebViews.
  Reopen on server changes; do not migrate data or borrow a successor Account.
- [x] Verify which self-host backend can support store sync and mount it before
  presenting self-host as a full hosted replacement. Do not introduce a Bun
  backend implicitly or claim server composition alone provides convergence.
- [ ] Verify the full connection UI and both entry paths, update current-facing
  documentation, and delete this execution document when delivered.

## Verification boundary

The shared-core checkpoint does not ship client connection UI. Keep this
limitation explicit. Account deletion and packaged native callback verification
remain separate tasks. Do not deploy or reset a shared database.

## Store backend checkpoint

The self-host Worker mounts the shared Durable Object store backend. Runtime
profile tests cover token gating and constant instance addressing; workerd
proves generation-byte roundtrip and preservation after operator token rotation.
The Bun entry has no store backend. Nine focused workerd tests and the self-host
typecheck pass. Independent review found no backend blocker.

Client startup selection, scoped persistence, and both UI entry paths are
implemented in the working tree. Browser/desktop lifecycle tests and Chromium
against the local Worker pass. Their checkpoint awaits the concurrent shared
authority-ID contract commit; those unrelated hunks are not included here.
