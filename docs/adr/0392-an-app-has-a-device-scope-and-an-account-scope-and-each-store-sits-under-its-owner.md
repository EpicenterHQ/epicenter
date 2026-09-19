# 0392. An App has a device scope and an account scope, and each store sits under its owner

- **Status:** Proposed
- **Date:** 2026-09-12
- **Scope:** The flat declaration, common schema, and account-owned local storage are accepted separately in ADR-0405, ADR-0406, and ADR-0404. The remaining connection protocol proposals in this record are not accepted by those decisions.
- **Unbuilt:** The unified connection protocol and remaining preference/selection persistence migrations.
- **Supersedes:** [ADR-0389](0389-the-open-call-decides-the-app-s-type-and-a-local-app-has-no-account-members.md) at the opener shape: there is one `openApp(definition, account)` and one object, so there is no `App` union discriminated by a `library` member and no account-only App type. Its rule that a store with no authority answers `sync.status()` with `undefined` stands as the behavior of `app.device`.
- **Amends:** [ADR-0369](0369-an-application-page-owns-one-library-and-changing-it-ends-the-page.md) at "one library": a page owns one auth generation, not one library, and close-before-replacement on an account change stands; [ADR-0355](0355-local-and-account-sessions-share-the-application-data-api.md) at the opening API: one open returns every library the person can reach, and the common data API, readiness, and closure remain; [ADR-0388](0388-the-app-owns-what-a-library-scopes-and-the-package-s-modules-supply-what-the-device-supplies.md) at the spelling of an App capability: a capability reads under the scope that owns it, so `sqlite` and `secrets` read as `app.device.sqlite` and `app.device.secrets`; [ADR-0390](0390-the-app-is-the-unit-of-ownership-and-a-capability-is-the-unit-of-sharing.md) at the spelling of the shared surface: shared code takes `app.device.connections` and `app.account?.connection` instead of `Pick<App, 'ai' | 'account'>`; its ownership rule stands.
- **Relates:** [ADR-0365](0365-ai-owns-inference-access-and-applications-own-workflow-selection.md) (the access surface, revised in place to `app.device.connections` and `app.account.connection`), [ADR-0375](0375-library-ownership-is-local-personal-or-shared-within-one-deployment.md) (Local and Personal ownership), [ADR-0399](0399-moving-data-into-an-account-is-a-row-copy.md) (optional application-owned copying), [ADR-0404](0404-the-opened-account-owns-application-local-storage.md) (how local storage is owned), [ADR-0401](0401-a-record-names-its-destination-at-creation.md) (how a write picks a store), [ADR-0396](0396-a-connection-transcribes-and-owns-the-four-rules.md) (the one verb a connection carries), [ADR-0363](0363-an-inference-selection-identifies-the-connection-and-model.md) (the selection `device.kv` stores)
- **Amended by:** [ADR-0412](0412-app-data-addresses-name-scopes-not-libraries.md) removes library metadata and names runtime addressing by data scope. [ADR-0416](0416-defer-server-wide-shared-data.md) removes Shared and defers server-wide sharing.
- **Implementation checkpoint, 2026-09-18:** `openApp(definition, { account? })` from `@epicenter/app/open` now returns device and account scopes together. All App callers use the new opener. The current App exposes device data and optional personal data; public operations share App readiness and lifetime. At that checkpoint SQLite and secrets used app-only scope; ADR-0404 replaces that decision with account-owned local storage. The ready-only App exposes retirement through `app.signal`; cleanup failure is terminal and there is no public replacement or close-retry facade. Page departure must quiesce producers before releasing resources. `device.connections` currently groups `runtime` and `custom` SDK capabilities; the unified connection protocol and remaining Whispering preference/selection migrations below are still proposed. ADR-0406 rejects the separate device data declaration. ADR-0407 makes that declaration platform-free, separates opening, and removes public runtime overrides.

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
a store: Local or Personal. Compute happens on a machine or a server:
this device's native runtime, a custom endpoint, or the account's gateway. The
account gateway uses the same captured Account as Personal data.
The native runtime transcribes a recording whichever library it was saved to. A
custom endpoint is shared across the same account's desktop apps and belongs to no library. A
design that lists libraries and connections as peers at the root, then splits
the connections again by machine versus account inside an `ai` member, states
the second gradation twice and the first one once.

Locality and ownership are separate. A microphone and native runtime are
device capabilities. Stored rows, credentials, files, and custom endpoints
belong to the account captured at opening, even when they never synchronize.
Opening without an account selects a separate namespace (ADR-0404).

## Decision

**One open captures an owner and returns device and account capabilities.
`device` always exists and holds that owner's local data. `account` is defined
when the opener receives an Account; otherwise its value is `undefined`.
The return type preserves which argument was supplied.**

```ts
const app = openApp(application, account);        // account is Account | undefined

app.device                              // captured owner's data here; never synced
  .kv  .tables                         // Local rows
  .sqlite  .secrets                     // borrowed data and credentials
  .connections                          // native runtime and custom endpoints
  .recording                            // Stop saves app-local bytes; workflow retains its row destination

app.account?                            // the signed-in person; one auth generation
  .identity                             // authorityId, principalId
  .personal                             // store: kv, tables; ordinary blob references
  .connection                           // that server's inference gateway

app.blobs.local                         // app-local bytes, independent of libraries
app.blobs.remote                        // explicit hosting when signed in

app.signal  app.ready  app.close
```

The framework supplies libraries and safe storage primitives. An application
chooses which libraries to show and how writes select a destination (ADR-0401).
Opening several stores requires neither a destination picker nor an "Add to
account" feature (ADR-0399). These handles now exist. The remaining connection and declaration changes below
are separate from the opener migration.

**`device` is the captured owner's local store and device capabilities.** Its `kv` holds
device preferences and workflow selections: the microphone, the global
shortcuts, and the inference selection of ADR-0363. Its tables
hold data a person created without an account or chose to keep on this
machine; a person reads that library as "Local" (ADR-0375), and a developer
types `device`. Its `sqlite` holds borrowed or derived tabular data for any
library, opened by name (ADR-0306). Its `secrets` holds credentials
(ADR-0310). Its `connections` is the catalog of endpoints this machine can
reach without an account: the native runtime the host supplies and the custom
endpoints a person added, shared across that account's desktop apps (ADR-0365). Its
`recording` saves completed audio into `app.blobs.local` (ADR-0366). The
workflow captures its chosen library before starting, then creates an ordinary
row referring to the returned BlobId (ADR-0393). Sign-out preserves stored
values without making them available through another account's App.

Local means this application's storage on this device or browser profile.
Alice, Bob, and no account select separate local namespaces. Returning to an
account restores its storage. Signing in does not adopt no-account records.
Recording bytes use the same captured owner as the App's local tables.

**`account` is the person's personal store and inference access.** `personal`
is that person's synchronized data on the captured server.
`connection` is that server's inference gateway, reached with the same bearer
as Personal data, metered on Cloud and unmetered on a self-hosted instance
(ADR-0075). It is one connection, not a catalog, and it is not something the
person connected, so it does not sit in `device.connections`.

**The store has one implementation with two homes.** The
`device` instance has no authority, so its `sync.status()` answers `undefined`
and only rows synchronize in account libraries. Blob storage remains at
`app.blobs.local` and `app.blobs.remote` as specified by ADR-0349 and ADR-0372.
The latter exposes explicit hosting; neither library owns byte synchronization. One data definition supplies `kv` and `tables` to every store (ADR-0406).
Applications choose the destination; the type system does not prohibit
writing a device preference into a synchronized store.

**`sqlite`, `secrets`, `connections`, and `recording` exist only on `device`.**
Borrowed data, credentials, the endpoint catalog, and the microphone are
machine-bound by nature. A derived database for the personal library is still
a file on this machine and names its source itself.

**A page still owns one auth generation.** An account change closes the page
and opens the next one (ADR-0369). Local data persists in its owner's
namespace; the old App handle does not. Every capture, blob read, and
in-flight inference call is bound to one lifetime signal, and a live `account`
swap would turn that one-shot signal into a stream every consumer must observe
again.

## Consequences

- `bootstrap.ts` in Whispering and `application.ts` in Honeycrisp stop
  choosing a library as the App-opening step. Applications own their views
  and write-destination policy (ADR-0401). Honeycrisp and local-mail,
  which have no inference, type `openApp(definition, account)` and read
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
- The recording workflow captures its destination and lifetime before capture.
  It saves bytes first, then creates an ordinary row referring to their BlobId;
  no account or view change retargets its save or subsequent inference.
- A page opens device data and, when signed in, one personal replica. Only
  Personal synchronizes; the app-local blob store remains available to both.
- Remove the old opener's library discriminator and its unused wiring after
  callers move. An application's view or destination choice may remain, but
  it no longer chooses which App opens. Person-facing copy keeps "Local"
  for the library and says "this device" for the machine, so "remove local
  data" can no longer name two things (ADR-0399).

## Considered alternatives

- **Five peers at the root: `local`, `personal`, `account`, `ai`,
  `recording`.** Rejected because `ai` then re-splits by machine versus
  account inside itself, stating the ownership gradation twice while the
  library gradation appears once. Sorting by owner states each once.
- **`ai` under each library: `app.personal.ai`, `app.local.ai`.** Rejected
  because the account gateway uses the same Account as Personal data, the
  native runtime serves every library, and a custom endpoint belongs to none.
  A library owns rows, not reach.
- **Keep one library per page and add an `app.device` section beside it.**
  Rejected because a device preference scoped to a library forgets the
  microphone on sign-out, and moving a Local library into an account then
  needs a per-field exclusion list.
- **Two handles the application opens and manages itself, or one App per
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
- **Separate device and account declarations.** Rejected by ADR-0406. One
  schema applies to all stores; application code owns write placement.
- **`settings` instead of `kv`.** Deferred until the other applications' `kv`
  contents are checked; a `kv` that holds non-settings state would make the
  rename a lie in the other direction.
