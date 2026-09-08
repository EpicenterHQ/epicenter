# Durable hosted account deletion

Status: Draft

One hosted lifecycle owner inventories every allocated resource and durably
erases it after retiring the account's ability to write.

The endpoint currently refuses before deletion. The
[storage map](../apps/api/worker/account/README.md) records the historical blocker.
The [refusal decision](../docs/adr/0359-account-deletion-refuses-until-owned-storage-can-be-erased.md)
records why the old synchronous sequence was removed. The workflow below is a
candidate design, not implemented behavior.

## Prerequisite

Resolve historical ownership through verified empty namespaces, a complete
historical manifest, or separately authorized retirement of old namespaces.
Do not deploy or reset storage as part of implementing this plan. No conditional
flag may silently relabel an incomplete inventory as complete.

## Smallest candidate

Use one hosted Durable Object per principal to own an append-before-allocation
inventory, an irreversible deletion state, captured external deletion inputs,
and step checkpoints. Its alarm retries independently of authentication. Keep
Better Auth, store authorities, ledgers, and the billing service as separate
owners of their mechanics. Do not proxy all application bytes through one
account object.

Register every authority and ledger before first access, including read-created
objects and arbitrary socket generations. Failed imports remain in the inventory
whether admitted or not. Stop registration atomically with accepting deletion.
Reopening a known object must still check retirement: registration is not a
perpetual write grant. Seeded historical inventory must include all reservations
and all prior object names or IDs; a browse list is never its source of truth.

Persist the job, minimal external inputs, and next wake-up before acknowledging
acceptance or revoking auth. Process bounded batches. Checkpoint successful
operations; retry an ambiguous result idempotently. Schedule the next alarm
before fallible external work and reschedule failures explicitly: Cloudflare's
[automatic alarm retries stop after six attempts](https://developers.cloudflare.com/durable-objects/api/alarms/).
Persist progress without a foreign key cascading from the auth user. A receipt
must remain usable after auth revocation without granting access to other data;
persist its verifier and return its secret only to the initiating fresh session.
Receipt recovery after a lost acceptance response needs a defined contract.

Retire each inventoried authority durably before erasing its bytes. Check its
tombstone before upgrade, read, message, catch-up/send, and after asynchronous
body reads immediately before seed. Close hibernated and active sockets. Do not
erase the tombstone with `deleteAll()`. Retire ledger allocation and admission
at their mutation boundary. Completion waits for all inventoried owners to
acknowledge retirement and erasure, so work authorized before acceptance cannot
recreate storage afterward.

Direct presigned PUTs need a controlled final-commit boundary. A candidate is
registered multipart upload IDs whose parts go directly to storage but whose
completion passes the account fence; deletion aborts incomplete uploads. Verify
provider support and races before choosing it. Existing presigned direct PUTs
still require a proven drain. [R2 expiry documentation](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
does not establish a bound on completion of an already-started upload. A fixed
300-second wait plus one sweep cannot establish complete erasure.

Fence customer creation, checkout, and usage settlement, including GET paths and
after-response work. In-flight external calls need durable reconciliation;
expiring a local lease does not cancel an external request. Capture the Stripe
identity before deletion if Autumn disappearance could lose the only pointer.
Verify provider idempotency and retention before treating not-found as success.

Attribute verification records at creation without replacing Better Auth.
Ground historical handoff, OAuth linking, and passkey challenge formats in the
installed version. Removing sessions makes handoff redemption fail, but does not
erase the handoff record. Prevent concurrent ceremonies from creating owned
records after their final sweep. Clear observations after writers retire.

## Endpoint contract to implement

- `202`: the irreversible request and retry mechanism are durable; return a
  receipt and status URL. Do not say data is already gone.
- Status reports pending retirement or erasure, retryable failure, and completed
  hosted erasure. Deletion continues after sign-out and auth-user removal.
- Completion requires proven inventory coverage, all writers retired or drained,
  all owned resources erased, and external outcomes reconciled. State retained
  tombstone/receipt metadata and provider-retention limits explicitly.
- Device copies and exports remain on devices. No “everywhere” promise.

## Isolated acceptance fixtures

Use isolated workerd storage, an isolated relational database, and local external
service fixtures. Assert actual contents, not callback order. Required cases:

1. Arbitrary data ID, socket-only generation, unadmitted reservation, failed import,
   historical manifest entry, ledger-only read allocation, and unrelated principal.
2. Pause registration and writes around acceptance. Resume already-authorized
   imports, delayed bodies, ledger admission, blob completion, customer-creating
   GETs, metering, and auth ceremonies; none may leave data after completion.
3. Active and hibernated sockets close and refuse subsequent frames after object
   restart. Retired objects never recreate their erased data.
4. Crash after durable acceptance, after each external success before its
   checkpoint, after auth revocation, and across more than six failed attempts.
   Restart using the same isolated storage and observe autonomous progress.
5. Repeat acceptance and each deletion step. Inject partial provider deletion,
   lost responses, missing resources, unavailable storage, and unavailable auth.
6. Seed every relational owner, including verification values for all installed
   plugins. Verify the other principal's records survive.
7. Retain device fixtures and prove hosted completion does not claim to erase
   them. Test receipt access after auth removal and response-loss recovery.

The blocker cannot be tested away with invented historical fixtures. A fixture
proves the mechanism for an inventory; production coverage requires evidence.
