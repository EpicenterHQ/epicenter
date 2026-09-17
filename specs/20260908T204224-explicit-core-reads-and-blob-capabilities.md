# Make core reads explicit and derive remote behavior from App capabilities

**Date:** 2026-09-08
**Status:** Draft
**Owner:** The implementing agent owns core API integration; the active Whispering composition work owns its consumer migration.

## One sentence

Core callers explicitly read state and query collections, while Whispering derives remote behavior from the capabilities of its opened App.

## Current and target shape

The user approved this plan after two independent design reviews. Implementation
has not started in this task. The relevant baseline commit is `5b8304a015`,
which composes Whispering's recording workflow over an opened App. Concurrent
fixed-library and inference work must be preserved and re-read before editing.

| Current core surface | Target |
| --- | --- |
| Auth client and departure `state` | `getState()` |
| Auth connection `status` | `getStatus()` |
| Table `rows` | `list()` |
| Table and KV `nonconforming` | `getNonconforming()` |
| Recordings backup `pending` | `getPendingCount()` |
| Recordings `remoteAvailable` | Remove; derive behavior from App-owned remote capability |
| Public Recording `endedReason` | Remove after verifying late `onEnded` notification coverage |

Svelte adapters retain reactive properties. Fixed facts remain ordinary readonly
values. This is a focused API migration, not a ban on JavaScript getters.
The proposed durable decisions are recorded in
[ADR-0371](../docs/adr/0371-core-observations-and-queries-use-explicit-methods.md)
and [ADR-0372](../docs/adr/0372-an-account-app-exposes-explicit-blob-hosting.md).

## Real caller translations

Honeycrisp `src/lib/application.ts` captures auth once:

```ts
// Before
const state = authClient.state;
// Target
const initialState = authClient.getState();
```

Update the subsequent Account selection to use `initialState`. Reading does
not subscribe and does not select a replacement Account after opening.

`packages/svelte/src/from-data.svelte.ts` seeds its unreadable-row map:

```ts
// Before
for (const row of table.nonconforming) unreadable.set(row.id, row);
// Target
for (const row of table.getNonconforming()) unreadable.set(row.id, row);
```

Whispering `src/lib/state/recordings.svelte.ts` retains its UI property:

```ts
// Before, inside the reactive pending getter
return recordings.backup.pending;
// Target, after the existing tracking read
return recordings.backup.getPendingCount();
```

## Remote capability belongs to composition

Today `createWhisperingDomains` passes `remoteConfigured: account !== null` to
recordings despite already receiving `openedApp.blobs`. The blob factory knows
whether a remote exists, but the store hides absence behind methods that return
`RemoteNotConfigured`. A custom factory need not agree with the Account check.

Target: `openedApp.blobs.remote` is a fixed remote capability or `null`. This is
a proposed core contract change; checking for null against today's wrapper
would always report a capability. Keep actual remote methods under the store's
readiness, operation admission, and close/drain boundary.

Whispering still supports `openLocal()`. Local recording must work without
remote storage. An account library that becomes offline or needs
reauthentication retains its configured capability; operations report failures.
Capability presence is not a reachability or authorization promise.

## Implementation checkpoints

- [ ] Migrate core auth, connection, departure, table, KV, and backup reads to
  the agreed methods with their consumers and contracts. Deliberately update
  adapter types: the reactive auth type currently extends the core type.
- [ ] Preserve reactive Svelte properties and explicit subscriptions. Remove
  descriptor-copying machinery where it exists only to avoid executing core
  query getters, after checking all remaining members.
- [ ] In the active composition work, expose the nullable remote blob capability
  from the opened App. Compose Whispering over that same App; do not create a
  second opener, singleton, auth observer, or capability boolean.
- [ ] Remove `remoteConfigured` from the recordings constructor and remove
  `remoteAvailable` from its contract, implementation, and Svelte adapter.
  Migrate pipeline uploads, backup reconciliation, backup status, storage
  actions, recording settings, and deletion preflight to the owned capability.
- [ ] Replace unconditional `requireRemote` success and stub-error translations
  where capability narrowing makes them unnecessary. Retain precise errors for
  real remote failures and whole-selection deletion preflight.
- [ ] Remove public Recording `endedReason` and forwarding getters after
  preserving late notification behavior. Keep the internal reason and native
  wire field used for reconciliation and recovery.
- [ ] Verify the replacement consumers before removing obsolete aliases,
  comments, and fixtures. Update package explanations and auth guidance to the
  final signatures. Finish with no compatibility aliases for the old reads.

The naming migration can proceed independently of remote composition. The
remote flag removal depends on the new blob contract and must land with its
consumer migration. Re-read concurrent changes instead of repeating completed
composition work.

## Verification and completion

- [ ] Core typechecks and affected application platform typechecks pass.
- [ ] Auth retains Account identity through same-owner reauthentication and
  permanently retires old Accounts on replacement. Plain reads do not subscribe;
  Svelte reads still update, including connection status and nonconforming rows.
- [ ] Table queries preserve validation results and lifetime refusals.
- [ ] Local libraries expose no remote capability and keep recording locally;
  account libraries retain their capability while offline. A custom factory's
  actual capability, rather than Account presence, determines remote behavior.
- [ ] Remote work remains admitted and drained by the opened App. Failed purge,
  upload, or download never authorizes unsafe local audio deletion. Preserve
  partial-deletion reporting and backup policy behavior.
- [ ] Recorder tests cover late notification, unsubscribe before replay,
  desktop registration-gap reconciliation, and stop/cancel after capture ends.
- [ ] Search for obsolete core reads and recordings capability flags; distinguish
  allowed Svelte properties and native protocol fields from stragglers.
- [ ] After implementation acceptance, delete this spent spec and index it in
  spec history. Do not claim the existing review ran implementation tests.

## Deferred work

Do not rename `store.persistence` or rebuild recording admission as part of this
plan. The former is a guarded capability; the latter owns necessary teardown
behavior. Do not bundle Whispering's cached collection getters into a new
`getState()` object without evidence that it removes duplicate computation.
