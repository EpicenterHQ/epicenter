# 0392. An App has a device scope and an account scope, and each store sits under its owner

- **Status:** Proposed
- **Date:** 2026-09-12
- **Supersedes:** [ADR-0389](0389-the-open-call-decides-the-app-s-type-and-a-local-app-has-no-account-members.md) at the opener shape: there is one `open(account)` and one object, so there is no `App` union discriminated by a `library` member and no account-only App type. Its rule that a store with no authority answers `sync.status()` with `undefined` stands as the behavior of `app.device`.
- **Amends:** [ADR-0369](0369-an-application-page-owns-one-library-and-changing-it-ends-the-page.md) at "one library": a page owns one auth generation, not one library, and close-before-replacement on an account change stands; [ADR-0355](0355-local-and-account-sessions-share-the-application-data-api.md) at the opening API: one open returns every library the person can reach, and the common data API, readiness, and closure remain; [ADR-0388](0388-the-app-owns-what-a-library-scopes-and-the-package-s-modules-supply-what-the-device-supplies.md) at the spelling of an App capability: a capability reads under the scope that owns it, so `sqlite` and `secrets` read as `app.device.sqlite` and `app.device.secrets`; [ADR-0390](0390-the-app-is-the-unit-of-ownership-and-a-capability-is-the-unit-of-sharing.md) at the spelling of the shared surface: shared code takes `app.device.connections` and `app.account?.connection` instead of `Pick<App, 'ai' | 'account'>`; its ownership rule stands.
- **Relates:** [ADR-0365](0365-ai-owns-inference-access-and-applications-own-workflow-selection.md) (the access surface, revised in place to `app.device.connections` and `app.account.connection`), [ADR-0375](0375-library-ownership-is-local-personal-or-shared-within-one-deployment.md) (the three library names a person reads), [ADR-0399](0399-moving-data-into-an-account-is-a-row-copy.md) (optional application-owned copying), [ADR-0400](0400-device-sqlite-and-secrets-key-by-application-id.md) (how the device surfaces key), [ADR-0401](0401-a-record-names-its-destination-at-creation.md) (how a write picks a store), [ADR-0396](0396-a-connection-transcribes-and-owns-the-four-rules.md) (the one verb a connection carries), [ADR-0363](0363-an-inference-selection-identifies-the-connection-and-model.md) (the selection `device.kv` stores)
- **Unbuilt:** All of it. `defineApplication` still exposes `openLocal`, `openPersonal`, and `openShared`; the App is still flat (`app.kv`, `app.tables`, `app.blobs`, `app.sqlite`, `app.secrets`, `app.ai`, `app.recording`); Whispering still persists selections and device config in `localStorage`.

## Context

An App today is one library. `bootstrap.ts` in Whispering and `application.ts`
in Honeycrisp read a saved library name, call one of three openers, and the
page belongs to that library until it is closed. Device state has no home on
the App, so each app persists it beside the App with a different mechanism:
Whispering's inference selections in `localStorage` through
`createInferenceSelections`, its microphone and global shortcuts in
`localStorage` through `createPersistedMap`, and its API keys through
`app.secrets`. The only declared surface, `kv`, synchronizes, so a device-only
value has nowhere structural to live and a regex test guards the mistake.

Two gradations run through the App and they are not the same one. Rows live in
a library: Local, Personal, or Shared. Compute happens on a machine or a server:
this device's native runtime, a custom endpoint, or the account's gateway. The
account gateway serves both Personal and Shared on its server with one bearer.
The native runtime transcribes a recording whichever library it was saved to. A
custom endpoint is shared across desktop apps and belongs to no library. A
design that lists libraries and connections as peers at the root, then splits
the connections again by machine versus account inside an `ai` member, states
the second gradation twice and the first one once.

What every member does share is an owner. A microphone, a global shortcut, a
native runtime, a custom endpoint, a credential, and a recording made without
an account are true of this machine and stay true after sign-out. A personal
library, a shared library, and the server's inference gateway are true of the
signed-in person and end with the auth generation.

## Decision

**One open returns an App with two scopes. `device` is always present and is
everything true of this machine. `account` is present when a person is signed
in and is everything true of that person on one server. Each store sits under
the scope that owns it.**

```ts
const app = await open(account);        // account is Account | null

app.device                              // this machine; never synced
  .kv  .tables                         // Local; tables own attachments
  .sqlite  .secrets                     // borrowed data and credentials
  .connections                          // native runtime and custom endpoints
  .recording                            // capture; start() names the destination

app.account?                            // the signed-in person; one auth generation
  .identity                             // authorityId, principalId
  .personal                             // store: kv, tables; row-owned attachments
  .shared?                              // same store surface; self-hosted deployments only
  .connection                           // that server's inference gateway

app.signal  app.ready  app.close
```

The framework supplies libraries and safe storage primitives. An application
chooses which libraries to show and how writes select a destination (ADR-0401).
Opening several stores requires neither a destination picker nor an "Add to
account" feature (ADR-0399). These are proposed handles; the current openers
still return one flat library per App.

**`device` is the machine's store and the machine's reach.** Its `kv` holds
device preferences and workflow selections: the microphone, the global
shortcuts, and the inference selection of ADR-0363. Its tables and attachments
hold data a person created without an account or chose to keep on this
machine; a person reads that library as "Local" (ADR-0375), and a developer
types `device`. Its `sqlite` holds borrowed or derived tabular data for any
library, opened by name (ADR-0306). Its `secrets` holds credentials
(ADR-0310). Its `connections` is the catalog of endpoints this machine can
reach without an account: the native runtime the host supplies and the custom
endpoints a person added, shared across desktop apps (ADR-0365). Its
`recording` is the capture capability; `start()` takes an existing row's
attachment (ADR-0393). A device value set while signed in survives sign-out
because it never depended on the account.

Local means this application's device storage or browser profile. Alice,
Bob, and the signed-out state reach the same Local data within that boundary;
separate profiles and devices do not. Local is not private to an Epicenter
account. Signing in does not adopt Local records. An account recording cached
on the device remains account data, not a record in Local.

**`account` is the person's stores and the person's reach.** `personal` and
`shared` are the two libraries a signed-in person reaches at once on one
server; Shared is never reachable without Personal, so it nests here.
`connection` is that server's inference gateway, reached with the same bearer
for either library, metered on Cloud and unmetered on a self-hosted instance
(ADR-0075). It is one connection, not a catalog, and it is not something the
person connected, so it does not sit in `device.connections`.

**The store has one implementation with three homes.** The
`device` instance has no authority, so its `sync.status()` answers `undefined`
and its attachments do not transfer over the network. Account libraries own
automatic attachment synchronization; app code uses row attachment handles
rather than `blobs.remote` (ADR-0393). The data definition declares the
synchronized `kv` and `tables` once and declares `device`'s separately, so a
key that belongs to this machine cannot be written into an account by mistake.

**`sqlite`, `secrets`, `connections`, and `recording` exist only on `device`.**
Borrowed data, credentials, the endpoint catalog, and the microphone are
machine-bound by nature. A derived database for the personal library is still
a file on this machine and names its source itself.

**A page still owns one auth generation.** An account change closes the page
and opens the next one (ADR-0369). The hub does not make a live swap
impossible; it removes the reason for one, since a person no longer loses the
machine's store or catalog by signing in or out. Local data persists; the old
App handle does not. Every capture, attachment read, and
in-flight inference call is bound to one lifetime signal, and a live `account`
swap would turn that one-shot signal into a stream every consumer must observe
again.

## Consequences

- `bootstrap.ts` in Whispering and `application.ts` in Honeycrisp stop
  choosing a library as the App-opening step. Applications own their views
  and write-destination policy (ADR-0401). Honeycrisp and local-mail,
  which have no inference, type `open(account)` and read
  `app.account?.personal.tables`.
- Whispering deletes `createPersistedMap` usage, the `createInferenceSelections`
  storage layer, the `secrets` facade over `deviceConfig`, the synced
  `transcriptionModel` setting, and `data.local-model-is-not-synced.test.ts`.
  Each value lands on one member above.
- `app.ai`, `app.ai.account`, `app.ai.runtime`, and `app.ai.connections` are
  gone. The picker assembles its list from `app.device.connections.getAll()`
  and `app.account?.connection`. A saved selection's `connectionId` already
  encodes which scope it names (ADR-0363), and `connectionFor(app, selection)`
  in `@epicenter/app` performs the lookup so no caller parses the id.
- Recording admission takes an existing row's attachment. The capture retains
  its library identity and lifetime; no account or view change retargets it.
- A page opens up to three replicas. Sync sockets and blob storage scale with
  that. This is the cost of showing a person's device, personal, and shared
  data at once.
- Remove the old opener's library discriminator and its unused wiring after
  callers move. An application's view or destination choice may remain, but
  it no longer chooses which App opens. Person-facing copy keeps "Local"
  for the library and says "this device" for the machine, so "remove local
  data" can no longer name two things (ADR-0399).

## Considered alternatives

- **Six peers at the root: `local`, `personal`, `shared`, `account`, `ai`,
  `recording`.** Rejected because `ai` then re-splits by machine versus
  account inside itself, stating the ownership gradation twice while the
  library gradation appears once. Sorting by owner states each once.
- **`ai` under each library: `app.personal.ai`, `app.local.ai`.** Rejected
  because the account gateway serves Personal and Shared with one bearer, the
  native runtime serves every library, and a custom endpoint belongs to none.
  A library owns rows, not reach.
- **Keep one library per page and add an `app.device` section beside it.**
  Rejected because a device preference scoped to a library forgets the
  microphone on sign-out, and moving a Local library into an account then
  needs a per-field exclusion list.
- **Three handles the application opens and manages itself, or one App per
  library plus a host `device` handle.** Rejected because every application
  would re-implement what closes on an account change and in what order, and
  would hold two handles with two lifetimes.
- **`local` as the machine scope's name.** Rejected because it collides with
  the Local library a person reads about and with "local" meaning on-device;
  `device` is the repo's word (`DeviceSqliteOwner`, ADR-0138) and a developer
  never types the library's person-facing name.
- **`machine` or `here` for the scope; `gateway` or `inference` for
  `account.connection`.** Rejected: `device` is already the word in code, and
  `connection` names the client's handle where `gateway` names the server's
  role.
- **A custom connection catalog as a `device.tables` declaration.** Rejected
  because desktop shares one catalog across apps (ADR-0365) and a per-app
  table would end that.
- **A live `account` swap instead of a page per auth generation.** Rejected
  for the reason above: the hub removed the need, and a swap costs every
  consumer a resubscription.
- **`sqlite` and `tables` on every scope for symmetry.** Rejected for
  `sqlite`: borrowed data has a different lifecycle from a person's own, and a
  visibly different surface is the signal.
- **One `kv` declaration instantiated three times.** Rejected because a
  microphone key would then exist on `personal.kv`, where a later write would
  sync it.
- **`settings` instead of `kv`.** Deferred until the other applications' `kv`
  contents are checked; a `kv` that holds non-settings state would make the
  rename a lie in the other direction.
