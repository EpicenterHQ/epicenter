# 0365. AI owns inference access and applications own workflow selection

- **Status:** Proposed
- **Date:** 2026-09-08
- **Amends:** [ADR-0398](0398-every-transcription-destination-speaks-the-openai-wire.md) at client ownership: independent inference handles replace the App lifetime; SDK operations and wire compatibility remain.
- **Unbuilt:** Independent inference constructors, separate catalog openers, consumer migration, and the signed-out invitation UI; `createAppAi` still depends on App cancellation.

## Context

`packages/app/src/ai.ts` combines runtime inference, the captured account's
Epicenter gateway, and a saved custom-connection catalog. App supplies its abort
signal and operation fence. Calling this factory's close alone does not retire
its SDK clients. The browser and desktop catalog bindings ignore the app ID and
partition saved endpoints by account, including a separate no-account catalog.

A caller opening one endpoint should not need an App, a saved record, or an
`owner: { kind: ... }` option. A saved endpoint and an open inference client also
have different lifetimes: closing a client must not remove its configuration.

## Decision

**Each inference source has a constructor with its own required inputs.**

These are target APIs, not implemented exports:

```ts
import {
  openEpicenterInference,
  openRuntimeInference,
  openEndpointInference,
} from '@epicenter/app/ai';

const epicenter = await openEpicenterInference({ account });
const runtime = await openRuntimeInference();
const endpoint = await openEndpointInference({
  baseURL: 'https://inference.example/v1',
  apiKey: providerKey,
});
```

| Constructor | Destination and authority |
| --- | --- |
| `openEpicenterInference({ account })` | The captured Account's Epicenter gateway, including self-hosted deployments |
| `openRuntimeInference()` | The inference capability supplied by this environment |
| `openEndpointInference({ baseURL, apiKey? })` | The supplied OpenAI-compatible endpoint and optional bearer credential |

A successful opening returns `{ client, signal, close }` with the actual SDK
client. Each source also exposes its captured destination identity for exact
workflow selection without exposing credentials. `openRuntimeInference` returns `null` when the environment supplies no
runtime capability. Failure to initialize an available runtime reports failure;
network or model errors do not become absence. No constructor selects a fallback
destination. Model discovery and a successful inference request are not opening
requirements, and client presence does not promise every SDK endpoint.

Epicenter access requires an Account and captures its identity and transport
before asynchronous acquisition. Same-owner credential refresh may continue
through that transport; account replacement never retargets it. Direct endpoint
access requires no Epicenter login. An absent or blank endpoint key sends no
bearer credential. It never borrows Account credentials. Runtime authentication
belongs to the supplied capability. Opening any of these handles saves nothing.

These functions need no application ID, data definition, mode flag, tagged owner
union, or optional-account aggregate. Separate implementations are allowed.
Extract a private helper only after the constructors demonstrate the same
mechanic; do not unify their ownership or inputs to obtain shared code.

**Every inference handle owns its request lifetime.**

Close is terminal and idempotent. It immediately fences retained clients,
cancels interruptible requests, and waits for response bodies and
noninterruptible native work to settle. It does not stop an external server or
unload a shared native engine. Opening owns rollback. Closing one client does
not retire unrelated clients. The public handle owns its abort controller;
exporting `createAppAi` unchanged does not satisfy this contract.

The client stays bound to its destination and credentials. Redirects or SDK
request options cannot redirect captured credentials to a different destination.
Applications use SDK operations and protocol types. This decision adds no
completion, dictation, or transcription wrapper; the separate proposal for
`connection.transcribe` is not a prerequisite for these constructors.

**Saved connection catalogs open separately from inference destinations.**

```ts
import {
  openLocalConnectionCatalog,
  openAccountConnectionCatalog,
} from '@epicenter/app/ai-connections';

const localCatalog = await openLocalConnectionCatalog();
const accountCatalog = await openAccountConnectionCatalog({ account });
```

Both catalogs persist on this device. Local uses the no-account partition.
Account requires a captured Account and uses its authority/principal partition.
Neither takes an app ID or synchronizes through Personal data. Desktop apps
share their account's catalog within the host profile; browser apps share it
within the origin/profile. Sign-in does not adopt Local entries, and account
replacement does not merge keys or retarget an existing catalog.

Catalogs retain `add`, `update`, `remove`, `reorder`, `get`, `getAll`, and
`subscribe`. Mutation resolves after persistence and snapshot publication.
Subscription supplies an immediate snapshot and later changes. Opening resolves
after hydration and subscription setup. Close ends observation and retires
catalog-owned clients while preserving saved configuration.

Catalog entries retain stable IDs and client access. A URL or credential change
retires previous access instead of retargeting a client held by an operation.
Rename, model-list edits, and ordering preserve access. A missing `get(id)`
returns `null`; removing and recreating an entry creates a new ID. Catalog close
and access retirement cancel and drain the requests they own.

Desktop snapshots expose key presence, not key material. The host uses the
saved connection ID and access version to broker requests with keychain
credentials. A desktop entry cannot be reconstructed by passing its public
snapshot to `openEndpointInference`. Browser records can hold their explicitly
supplied key. Neither catalog uploads custom credentials to Epicenter inference.
Omitting a key from an update retains it; an explicit blank key removes it.

Unsaved endpoint preview uses `openEndpointInference` and closes that handle
when the form is discarded. The target catalog has no `preview` method. Preview
saves nothing and has no access to an existing hidden key unless it uses that
saved entry's brokered client.

**Applications choose a concrete connection and model for each workflow.**

The picker composes available inference handles and catalog entries. A signed-out
Epicenter invitation is UI, not an unusable connection. Custom endpoint access
remains available without Epicenter sign-in. Runtime absence is a platform fact,
not a reason to silently select the hosted gateway.

Selections retain destination identity: Epicenter authority and principal,
runtime destination, or catalog owner and immutable entry ID, plus the chosen
model. A saved selection must not match another account or an endpoint merely
because it advertises the same model. Capture the selected client and model
before sending data. Applications own defaults, validation, and persistence of
those choices; inference constructors neither read product settings nor choose
models. Catalog entries and clients must not enter synchronized rows or logs.

## Consequences

A product can make one inference request without opening storage or a catalog.
The public owner union and `app.device.connections`/`app.account.connection`
access paths disappear. Distinct constructors make authentication requirements
visible while preserving runtime absence and ordinary request failures.

Catalog ownership remains explicit because saved keys need isolation even when
their storage is local. The local/account constructor pair costs two names and
avoids a tagged public option. Direct clients add a close obligation; form and
workflow owners must release them. Catalog clients remain owned by their catalog
rather than requiring another opener for every saved entry.

Existing catalog paths and keychain identities stay unchanged. This decision
neither migrates credentials nor adopts legacy catalogs. Whispering and other
products need caller migration; these examples do not describe shipped APIs.

## Considered alternatives

- `openConnections({ owner: { kind, ... } })`: requires callers to classify an
  owner before opening a resource with already known requirements.
- One nullable runtime/account/custom bundle: preserves App's optional branches
  and starts unrelated catalogs for direct endpoint calls.
- Require every endpoint to be saved: turns previews and one-off requests into
  persistent settings changes.
- Rebuild saved clients from public metadata: requires exposing desktop keys or
  loses the broker's credential-version fence.
- Duplicate a wrapper verb for every SDK operation: creates a second protocol
  surface without adding destination or lifetime guarantees.

## Verification

Check independent client closure through response-body completion, account
retirement, endpoint credential isolation, runtime absence without fallback, and
explicit model selection. Verify account-separated catalog reopen, signed-out
custom access, desktop broker requests without exported keys, access retirement
on URL/key changes, and preview leaving persistence untouched. Physical native
capture and provider compatibility remain separate acceptance evidence.
