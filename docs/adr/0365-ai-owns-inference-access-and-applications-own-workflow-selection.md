# 0365. AI owns inference access and applications own workflow selection

- **Status:** Proposed
- **Date:** 2026-09-08
- **Amends:** [ADR-0398](0398-every-transcription-destination-speaks-the-openai-wire.md) at client ownership: independent inference handles replace the App lifetime; SDK operations and wire compatibility remain.
- **Unbuilt:** Metadata-only catalog reads, explicit saved-access acquisition, direct runtime transcription, and page/operation consumer migration. Independent network constructors and native endpoint routing already exist.

## Context

Independent inference constructors exist in `packages/app/src/ai.ts`. Saved
catalog reads in `connection-catalog.ts` still materialize cached SDK clients.
A settings snapshot therefore carries live execution access, and page startup
still couples catalog acquisition to unrelated resources.

A saved connection and an acquired client have different lifetimes. Reading
configuration must not acquire execution access. Closing access preserves its
saved configuration.

## Decision

**Each inference source has a constructor with its own required inputs.**

Network constructors exist. The runtime transcriber in this example is the
target in [ADR-0424](0424-runtime-transcription-calls-the-host-directly.md); verify
its final subpath and signature against implementation:

```ts
import {
  openEpicenterInference,
  openRuntimeTranscriber,
  openEndpointInference,
} from '@epicenter/app/ai';

const epicenter = await openEpicenterInference({ account });
const runtime = await openRuntimeTranscriber();
const endpoint = await openEndpointInference({
  baseURL: 'https://inference.example/v1',
  getAuthHeaders: () => ({ Authorization: `Bearer ${providerKey}` }),
});
```

| Constructor | Destination and authority |
| --- | --- |
| `openEpicenterInference({ account })` | The captured Account's Epicenter gateway, including self-hosted deployments |
| `openRuntimeTranscriber()` | The native transcription capability supplied by this environment |
| `openEndpointInference({ baseURL, getAuthHeaders? })` | The supplied OpenAI-compatible endpoint and captured HTTP authentication header source |

A successful network opening returns `{ client, signal, close }` with an actual
SDK client. Native transcription exposes direct model-listing and transcription
operations. Each source has a stable destination identity without exposing
credentials. Runtime absence returns `null`; an available provider's failures
remain failures. Empty successful discovery means no installed models.
Constructors never choose a fallback. Opening does not require discovery or
prove future model support. Network client presence does not promise every SDK
endpoint; the native transcriber makes its narrow operations explicit.

Epicenter access requires an Account and captures its identity and transport
before asynchronous acquisition. Same-owner credential refresh may continue
through that transport; account replacement never retargets it. Direct endpoint
access requires no Epicenter login and never borrows Account credentials. Runtime
authentication belongs to the supplied capability. Opening any of these handles
saves nothing.

These functions need no application ID, data definition, mode flag, tagged owner
union, or optional-account aggregate. Separate implementations are allowed.
Extract a private helper only after the constructors demonstrate the same
mechanic; do not unify their ownership or inputs to obtain shared code.

**Endpoint authentication has one captured header source.**

OpenAI-compatible request bodies do not imply one authentication scheme. The
[OpenAI SDK authentication guide](https://github.com/openai/openai-node/blob/main/docs/authentication.md)
documents refreshable bearer credentials. The
[Cloudflare gateway example](https://developers.cloudflare.com/ai-gateway/usage/providers/openai/)
uses a gateway credential header alongside upstream authorization. The target
endpoint constructor therefore uses one optional function:

```ts
type EndpointInferenceOptions = {
  baseURL: string;
  getAuthHeaders?: (options: { signal: AbortSignal }) =>
    HeadersInit | Promise<HeadersInit>;
};
```

For a static credential, the function returns the same headers. For expiring
credentials, it obtains a token for the identity captured at opening:

```ts
const endpoint = await openEndpointInference({
  baseURL,
  getAuthHeaders: async ({ signal }) => ({
    Authorization: `Bearer ${await credentials.getToken({ signal })}`,
    'cf-aig-authorization': `Bearer ${gatewayToken}`,
  }),
});
```

Omitting the function means no constructor-supplied authentication. There is no
second `apiKey` option, static-header alternative, or public `auth.kind` union
with competing precedence. The function may refresh credentials but must not
resolve a mutable global current account or change the endpoint's owner.

For each request attempt, the handle validates the destination before resolving
authentication. It copies
the returned headers and applies them after SDK request headers, so per-request
options cannot override captured credentials. It suppresses SDK placeholder or
environment-derived authentication, omits ambient cookies, and refuses
redirects. The request is admitted before the callback runs, and its signal
combines handle and caller cancellation. Header resolution belongs to that
request's cancellation and drain:
closure prevents a delayed resolver from dispatching a request, even if that
resolver cannot be interrupted immediately. A failed resolver fails the request;
it does not trigger unauthenticated fallback.

This contract covers HTTP header credentials and token refresh. Request signing,
mTLS, and endpoint-specific URL or protocol transformations require an explicit
transport integration when a concrete consumer needs them. A raw `fetch` option
is not the default public abstraction: arbitrary transport code could bypass
routing, credential fencing, and cancellation. No constructor per provider or
per authentication scheme is introduced.

Desktop endpoint requests use the host path, including ephemeral headers,
destination checks, cancellation, and supported multipart operations.
Using browser fetch in a WebView is not a substitute for native routing parity.
Neither headers nor token callbacks become persisted settings through opening.

**Every inference handle owns its request lifetime.**

Close is terminal and idempotent. It immediately fences retained clients,
cancels interruptible network requests, and waits for response bodies to settle.
The native transcriber separately settles admitted host work. Closing access
does not stop an external server or unload a shared native engine. Opening owns rollback. Closing one client does
not retire unrelated clients. The public handle owns its abort controller;
exporting `createAppAi` unchanged does not satisfy this contract.

The client stays bound to its destination and credentials. Redirects or SDK
request options cannot redirect captured credentials to a different destination.
Applications use SDK operations and protocol types for network requests.
Native transcription calls the typed host boundary directly. Application
operations compose those paths; no universal `Connection.transcribe` object or
second API for every SDK method is introduced. Page-root handles may live until
document replacement. Temporary previews and operation-owned access still close.

**Saved connection catalogs open separately from inference destinations.**

```ts
import {
  openLocalConnectionCatalog,
  openAccountConnectionCatalog,
} from '@epicenter/app/ai-connections';

const localCatalog = await openLocalConnectionCatalog();
const accountCatalog = await openAccountConnectionCatalog({ account });
```

Saved catalogs retain their existing optional bearer API key contract. They do
not persist arbitrary authentication headers, refresh callbacks, or login flows.
Adding those would require a separate stored-secret format, host broker, editing
semantics, and access-version contract; the endpoint constructor does not expand
the catalog promise.

Both catalogs persist on this device. Local uses the no-account partition.
Account requires a captured Account and uses its authority/principal partition.
Neither takes an app ID or synchronizes through Personal data. Desktop apps
share their account's catalog within the host profile; browser apps share it
within the origin/profile. Sign-in does not adopt Local entries, and account
replacement does not merge keys or retarget an existing catalog.

Catalogs retain `add`, `update`, `remove`, `reorder`, `get`, `getAll`, and
`subscribe`. Reads and subscriptions expose saved descriptions, without creating
clients. Mutation resolves after persistence and snapshot publication. Opening
resolves after hydration and subscription setup.

A separate explicit acquisition, illustrated as `catalog.open(id)`, returns
live access to the selected saved connection. The caller owns that access for
its operation or page. A missing metadata `get(id)` returns `null`; acquiring a
missing entry rejects with a distinguishable cause, never another destination.
Acquisition follows the rejecting Promise contract of resource openers; expected
request failures retain their operation contracts. Verify final method and error
types against the implementation.

Entries retain stable IDs. Acquired access captures its destination and credential
revision. A URL or credential change, deletion, or catalog closure retires old
access rather than retargeting it. Rename, model-list edits, and ordering preserve
access. Removing and recreating an entry creates a new ID. Retirement cancels and
drains admitted requests according to their resource contract.

The catalog must still enforce revocation of acquired access. Moving from a
client cache to tracked active access does not erase this obligation. The goal
is inert reads and explicit acquisition, not an unverified claim of fewer
lifetime checks. Model discovery updates metadata only if its captured entry
and access revision still match; object identity of an SDK client is not the
persistence concurrency token.

Desktop snapshots expose key presence, not key material. The host uses the
saved connection ID and access version to broker requests with keychain
credentials. A desktop entry cannot be reconstructed by passing its public
snapshot to `openEndpointInference`. Browser records can hold their explicitly
supplied key. Neither catalog uploads custom credentials to Epicenter inference.
Omitting a key from an update retains it; an explicit blank key removes it.

Public endpoint arguments use `baseURL`, matching the SDK. Existing serialized
catalog records use `baseUrl`; changing a public name does not authorize a
persistence migration. Adapt the existing field at the serialization boundary.

Unsaved endpoint preview uses `openEndpointInference` and closes that handle
when the form is discarded. The target catalog has no `preview` method. Preview
saves nothing and has no access to an existing hidden key unless it uses that
saved entry's explicitly acquired brokered access. Model discovery takes the
selected client:
`discoverModels(client)`. Remove the mixed `discover(baseUrl, apiKey?, savedId?)`
shape, where a saved ID silently makes the other arguments irrelevant.

**Applications choose a concrete connection and model for each workflow.**

The picker displays source descriptions and saved connection metadata. It
acquires access only for discovery or execution, not merely to render the list.
A signed-out Epicenter invitation is UI, not an unusable connection. Custom endpoint access
remains available without Epicenter sign-in. Runtime absence is a platform fact,
not a reason to silently select the hosted gateway.

Selections retain destination identity: Epicenter authority and principal,
runtime destination, or catalog owner and immutable entry ID, plus the chosen
model. A saved selection must not match another account or an endpoint merely
because it advertises the same model. Capture the selected destination, acquired
access, and model before sending data. Applications own defaults, validation, and persistence of
those choices; inference constructors neither read product settings nor choose
models. Credentials and live clients must not enter synchronized rows or logs.
Saved workflow selections retain only the source identity and model they need.

## Consequences

A product can make one inference request without opening storage or a catalog.
The public owner union and `app.device.connections`/`app.account.connection`
access paths disappear. Distinct constructors make authentication requirements
visible while preserving runtime absence and ordinary request failures.

Catalog ownership remains explicit because saved keys need isolation even when
their storage is local. The local/account constructor pair costs two names and
avoids a tagged public option. Page roots retain acquired access for their
document. Temporary form and workflow owners release their access. Catalog snapshots remain inert; listing
settings cannot allocate request owners.

Existing catalog paths and keychain identities stay unchanged. This decision
neither migrates credentials nor adopts legacy catalogs. Whispering and other
products still need catalog and runtime caller migration. Read current code for
implemented signatures; target examples do not claim completion.

## Considered alternatives

- `openConnections({ owner: { kind, ... } })`: requires callers to classify an
  owner before opening a resource with already known requirements.
- An API-key-only endpoint contract: confuses OpenAI-compatible operations with
  one credential format.
- Separate bearer, OAuth, and provider constructors: multiplies entrypoints
  without changing inference ownership; a captured header source covers the
  supported credential differences.
- One nullable runtime/account/custom bundle: preserves App's optional branches
  and starts unrelated catalogs for direct endpoint calls.
- Require every endpoint to be saved: turns previews and one-off requests into
  persistent settings changes.
- Rebuild saved clients from public metadata: requires exposing desktop keys or
  loses the broker's credential-version fence.
- Duplicate a wrapper verb for every SDK operation: creates a second protocol
  surface without adding destination or lifetime guarantees.

## Verification

Check independent client closure through response-body completion and delayed
authentication resolution, caller-header override refusal, redirected credential
refusal, account retirement, endpoint credential isolation, runtime absence
without fallback, and explicit model selection. Verify account-separated catalog reopen, signed-out
custom access, desktop broker requests without exported keys, access retirement
on URL/key changes, and preview leaving persistence untouched. Verify unsaved
native inference beyond model discovery without logging or persisting ephemeral
authentication headers. Physical native capture and provider compatibility
remain separate acceptance evidence.
