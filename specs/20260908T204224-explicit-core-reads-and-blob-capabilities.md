# Explicit core reads and recorder observation

**Date:** 2026-09-08
**Revised:** 2026-09-15
**Status:** Draft
**Owner:** The implementing agent owns the core API and adapter migration.

## Current execution contract

Core observations and queries use explicit methods; Svelte adapters retain
reactive properties. Fixed facts remain readonly values. This is a focused
migration under [ADR-0371](../docs/adr/0371-core-observations-and-queries-use-explicit-methods.md),
not a ban on JavaScript getters. Current source still has auth/departure state
getters, table rows/nonconforming getters, and public Recording `endedReason`.
Historical baseline commits in the retired transcript are not current proof.

`app.blobs.local` and account-scoped `app.blobs.remote` already expose independent
storage and explicit hosting (ADR-0349, ADR-0372, ADR-0393). Preserve those APIs;
this read-method migration does not introduce a nullable remote facade, automatic
byte transfer, or row-owned attachments.

## Core read migration

| Existing core surface, where it survives | Target |
| --- | --- |
| Auth client and departure `state` | `getState()` |
| Surviving connection `status` observation | `getStatus()` |
| Table `rows` | `list()` |
| Table and KV `nonconforming` | `getNonconforming()` |
| Existing backup runner `pending`, only while that runner remains | `getPendingCount()` |

ADR-0374 removes the unused auth connection abstraction. The server backup
product is deferred (ADR-0394, ADR-0395). Neither an unused auth abstraction nor
a backup runner must be recreated for this naming migration. Explicit remote
blob operations remain independent of row synchronization.

- [ ] Re-read current contracts and consumers, then migrate surviving core reads
  and their callers together. A plain read does not subscribe or replace the
  Account captured at opening.
- [ ] Adapt Svelte types deliberately instead of inheriting the old core property
  shape. Preserve reactive updates and explicit subscriptions.
- [ ] Remove descriptor-copying machinery only where it exists solely to avoid
  executing core query getters; inspect remaining members first.
- [ ] Verify validation results, Account identity, readiness and lifetime refusals,
  then remove old aliases and update current package explanations.

This lane proceeds independently of explicit blob hosting. It does not
change library selection, recording destinations, or account replacement.

## Conditional recorder observation cleanup

The public `Recording.endedReason` getter may be redundant with `onEnded`.
Do not infer that the internal reason or native wire field is redundant too.

- [ ] Inventory current getter and notification consumers in the recorder and
  its adapters before removing the public getter.
- [ ] Prove late `onEnded` replay, unsubscribe before replay, desktop event
  registration-gap reconciliation, and stop/cancel after capture ends.
- [ ] Preserve internal/native end reasons needed for live reconciliation and cleanup;
  durable capture recovery is withdrawn by ADR-0366.
- [ ] Remove the public getter and forwarding members only when that evidence
  establishes equivalent consumer behavior. Coordinate with the disposable-capture
  recorder migration rather than duplicating its contract work.

## Storage invariants retained elsewhere

Local remains valid without remote hosting; an offline account library remains
account-owned. Account presence does not prove remote audio availability, and
failed network operations do not authorize local audio loss. The App coordinates
resource shutdown. Existing generation admission and retirement safeguards remain
subject to ADR-0379's caller audit. Recovering content through ordinary Push
(ADR-0395) does not replace a generation.

Storage scope does not choose inference. Local audio can be sent to an
explicitly selected account inference connection without joining an account
library. This is not automatic attachment synchronization.

## Verification and completion

- [ ] Affected core and application platform typechecks pass.
- [ ] Auth retains Account identity through same-owner reauthentication and
  permanently retires old Accounts on replacement. Plain reads do not subscribe.
- [ ] Svelte observations still update; table queries preserve validation and
  lifetime behavior.
- [ ] Recorder notification/session-cleanup evidence passes before getter removal.
- [ ] Search surviving consumers for old reads without treating Svelte properties
  or native protocol fields as stragglers.
- [ ] After this lane is verified, delete the spent spec and record its history.
  Explicit hosting and hardware acceptance remain separate work.

Do not rename `store.persistence`, redesign recording admission, or combine
Whispering's cached collection getters into a new state object without evidence.
