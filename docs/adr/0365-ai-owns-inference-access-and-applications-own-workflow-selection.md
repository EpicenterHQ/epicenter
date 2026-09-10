# 0365. AI owns inference access and applications own workflow selection

- **Status:** Proposed
- **Date:** 2026-09-08
- **Revised:** 2026-09-10
- **Unbuilt:** A unified account/runtime/custom access view and the signed-out invitation design; the portable `app.ai.dictation` service. Shared desktop custom connections and application-owned selections are implemented. Real native capture acceptance remains separate.

## Context

The App supplies actual OpenAI SDK clients and binds their requests to its
readiness and retirement. Custom connection records and workflow selections
previously shared one configuration owner and persisted envelope.

Whispering's UI adapter combined connection editing, model discovery, and
workflow routing. Completion and transcription operations repeated its matching.
Vocab used the adapter for conversations while choosing account inference
separately for dictation.

These uses identify the boundary: a connection supplies access to inference;
an application decides which connection and model a particular job uses.
Core AI does not need to know what `completion`, `transcription`, or a
conversation ID means.

## Decision

### Settled user experience

The user confirmed this experience on 2026-09-10:

> In a browser, I can sign in to use Epicenter inference, or add my own
> endpoint. Inside Desktop, I get those same choices plus native inference,
> and custom endpoints I configure there are available to the other desktop
> apps. Each app remembers its own model choices.

An SPA remains an independent product that can be hosted in a browser and
integrated into Epicenter Desktop. The available inference access comes from
its environment. Custom connections stay local to that environment:

- Desktop shares one custom catalog across its apps for the local desktop
  profile. Adding an endpoint there does not select it for every app.
- A standalone browser app keeps its custom catalog in origin-local storage,
  with product scoping where needed. Different origins need not share settings.
- Applications retain their own explicit connection-and-model choices. A
  shared catalog does not create shared workflow defaults.

The Epicenter section can remain visible without authenticated access and offer
sign-in. That invitation is presentation, not a usable connection. Once the App
has account access, the person can choose its models. Custom and supplied native
inference do not inherently require Epicenter sign-in; an app can separately
require identity for its library or product workflow.

Native inference appears when its binding supplies it. Connecting a custom
OpenAI-compatible endpoint requires its URL and optional bearer key; it does
not require Epicenter to install or manage the server. A failed or removed
destination never silently changes the selected server.

This experience does not require synchronizing custom catalogs through an
account server or uploading custom keys there. Closing an app preserves saved
connections. Switching libraries preserves environment configuration while
the application follows its own selection and lifetime rules.

### Catalog ownership and observation

`app.ai.connections` exposes the environment's custom catalog. Desktop stores
metadata in `ai/connections.json` under its profile data directory. One host
owner serializes writes, persists by atomic replacement, and broadcasts committed
snapshots to its apps over SSE. Browser bindings use `localStorage` under the
product's settings key, with Web Locks for writes and notifications for other
owners. Neither catalog belongs to a library or synchronizes across devices.

The public mutation names are `add`, `update`, `remove`, and `reorder`. Their
promises resolve after persistence and local snapshot publication. `get(id)`
returns one current entry or `null`; `getAll()` returns the ordered local snapshot.
`subscribe(listener)` immediately supplies that snapshot and then each update,
returning an unsubscribe function. Apps await `app.ready` before using this API;
desktop readiness includes opening its subscribed catalog view.

Desktop credentials remain in the OS keychain. Snapshots expose `hasApiKey`
without exposing the key. The host brokers custom requests against the captured
connection ID and access version. URL or credential changes retire previous
access; rename, model-list changes, and ordering preserve it. Metadata changes
retain keychain references without retrieving their values. Explicit replacement
or removal can repair a missing keychain entry while preserving the saved ID.

### Structural decisions still open

The picker currently composes account, runtime, and custom access. A unified
core view remains a separate design choice. The signed-out invitation also
needs reconciliation with the captured-Account rule: a Local App currently has
no account inference despite ambient sign-in. This catalog change does not alter
that authentication or opening lifecycle.

### Inference access and the current API

**The App supplies clients bound to destinations and credentials. The caller
chooses a client, supplies a model, and makes a request.**

The current namespace exposes three sources of access:

| Member | Source and owner |
| --- | --- |
| `app.ai.account` | Fixed nullable client capability using the App's captured Account transport |
| `app.ai.runtime` | Fixed nullable client capability supplied by the AI binding |
| `app.ai.connections` | Custom connection management and client access, nullable when the binding supplies no custom connection store |

Account and runtime connections retain their own management and authentication.
They are not editable records in the custom collection. A runtime connection
can use a native bridge; a custom connection can reach a local HTTP server.
The source names do not classify where computation physically occurs.

The implemented custom API combines management and requests in one entry:

```ts
if (!app.ai.connections) return showCustomConnectionsUnavailable();

const id = await app.ai.connections.add({
  name: 'My server',
  baseUrl: 'https://inference.example/v1',
  apiKey: providerKey, // Optional; omit for endpoints without bearer auth.
  models: ['chosen-model'],
});

const connection = app.ai.connections.get(id);
if (!connection) return showMissingConnection();

await connection.client.chat.completions.create({
  model: 'chosen-model',
  messages,
});
```

Call sites write `app.ai.connections` directly rather than aliasing the
namespace to a local variable. The full path keeps ownership visible. A workflow
can retain a selected connection or client to fix its destination for that run.

**The current custom API has one namespace for management and use.**

`add({ name?, baseUrl, apiKey?, models? })` persists a connection and returns its
immutable generated ID after persistence. It does not perform inference or select
a workflow. Desktop management requests cross the host bridge.
`get(id)` returns the current custom entry or `null`; `getAll()` returns the
current ordered snapshot. Entries include their saved connection fields and
their actual SDK client. `update`, `remove`, and `reorder` edit saved custom
connections. `subscribe` supplies the initial snapshot and subsequent updates.
`preview({ baseUrl, apiKey? })` supplies an App-bound client for an unsaved form
candidate without creating a record.

Snapshots contain detached configuration values. SDK clients retain identity
until their endpoint or credentials change. Reading or constructing a client
performs no network discovery. Model lists are suggestions for the picker;
an explicit model does not need to appear in discovery results.

IDs survive rename, reorder, credential rotation, and reload. Two entries may
use the same URL with different credentials. Removing and recreating an entry
produces a new ID. Editing an endpoint or key retires its previous client rather
than retargeting a client already retained by a workflow.

**Optional custom bearer credentials are part of the connection contract.**

An absent or blank key sends no bearer credential. A custom connection never
borrows the current Account's credentials. Account requests obtain credentials
through the captured Account transport; runtime authentication belongs to its
binding. Connection settings remain local to their environment and never enter
synchronized library data. Browser entries may contain their explicit key;
desktop entries contain only its presence flag. Applications pass the client to
inference work and never serialize or log client-bearing entries.

Omitting `apiKey` from an update retains its existing value. An explicit blank
key removes it. Desktop explicit key assignment creates a new access version,
even if the supplied string matches the old key. Preview only discovers models
for an unsaved candidate and never persists its credentials.

**Applications own workflow selection, its persistence, and its validation.**

Core AI exposes no scope-indexed selections, default workflow model, `select`,
`target`, or `resolve(scope, model)`. A lookup in `app.ai.connections.get(id)` addresses
one custom connection; it does not choose a workflow or source.

Applications remember explicit connection-and-model pairs. A shared plain
TypeScript helper outside `@epicenter/app` may persist those choices and match
them against available clients. Its caller owns the scopes, initial default,
and model consistency policy. Svelte observes that application-layer owner;
product operations use the same owner without importing reactive UI state.

Saved account references identify the concrete authority and principal. Runtime
references identify the supplied destination. Custom references use the immutable
connection ID. A missing reference must not resolve to another source, a new
account, or a connection advertising the same model. A workflow captures its
client and model together before sending data.

**The opened App owns inference access for its lifetime.**

`defineApplication` is inert composition. `openLocal()`, `openPersonal(account)`,
and `openShared(account)` return an App synchronously; the caller awaits
`app.ready` and stops product work before `app.close()`.

The account supplied at opening determines both library actor and account
inference. Local opening has no account inference, even if authentication
elsewhere is signed in. Personal and Shared opening use the captured actor for
inference. There is no independent inference-account selector. Same-owner
credential refresh preserves access through the captured transport; account
replacement closes the App and opens another.

Runtime and AI bindings are selected independently at application declaration.
Selecting native storage or running inside Tauri does not itself supply native
inference. Null means no capability was supplied, not that a request failed or
a model needs downloading.

Retained clients reject premature or retired use. Closing cancels or drains
admitted requests, including streamed response bodies and noninterruptible
native work. It does not stop external servers or unload a shared native engine.
Resource cleanup remains owned by App, not by individual consumers.

**The SDK owns inference operations and protocol types.**

Applications call `client.chat.completions.create`,
`client.audio.transcriptions.create`, and `client.models.list` where supported.
Epicenter does not add a second set of core completion or transcription verbs.
Application workflows can translate SDK exceptions into their existing Results.

A native adapter can translate supported SDK requests into Tauri commands
through custom fetch without opening an HTTP socket. The current adapter
implements model listing and file transcription. Client presence does not
promise all SDK endpoints, full protocol parity, successful model loading, or
reachability. Native use requires evidence for real audio, explicit model
selection, result mapping, authorization, and cancellation or drain.

**The App also supplies microphone-to-text sessions through `app.ai.dictation`.**

App construction composes this capability alongside inference access. The custom
connection collection owns neither capture nor dictation configuration. Dictation
owns microphone acquisition, transcript updates, and session completion; it
does not duplicate the SDK's file-transcription API. Products own text insertion,
record creation, and subsequent workflows.

The proposed `start({ onUpdate, onError })` returns a `DictationSession` in a
Wellcrafted Result. Its `finish()` stops listening and returns `{ text }` in a
Result; `cancel()` discards the session. Saved audio remains
[`app.recording`](0366-recording-is-an-app-scoped-portable-capability.md), whose
returned Recording stops into a blob. Dictation does not publish a permanent
recording merely because it captured audio. Each returned handle addresses its
original session; a delayed finish or cancel cannot act on a newer one.

Desktop dictation settings supply the input selection and inference route.
Standalone browser composition supplies the same logical settings per
application. Dictation captures these settings before acquisition and resolves
the route against the opened App's actual capabilities. Missing or unavailable
destinations fail without borrowing another Account or choosing another source.
This dedicated configuration does not add generic workflow scopes to core AI
or move application completion and transcription choices into `connections`.

Local, Personal, and Shared Apps expose the same dictation contract. Local still
has no account inference. Native recording and dictation reach one host capture
owner, which admits concurrent sessions on distinct input devices under
ADR-0366. Releasing a microphone does not wait for transcription to complete;
the original session retains its inference work and result until it settles.
App closure cancels or drains its sessions without shutting down other Apps'
captures or the shared native engine.

## Consequences

The API groups connection editing and client lookup. The environment chooses
the catalog owner, and the App owns its subscribed view and SDK request lifetime.
Applications use the SDK for requests.
Whispering and Vocab retain their workflow choices without requiring those
concepts in core App types.

Browser connections and selections have separate version-1 stores under the existing
application prefix: `.app-ai-connections` and `.app-ai-selections`. The
application coordinator validates destination stores first, then imports missing
stores under one exclusive Web Lock. An existing empty destination still wins.
Pre-ID settings first become one committed combined envelope so every retry and
document uses the same ID mapping. Each successful destination write survives a
later write failure. Old bytes remain recovery data; live owners neither observe
nor write the old keys.

Browser owners never convert legacy settings during synchronous construction. Connection-only callers can
initialize normalized records under the same lock without parsing selections;
pre-ID conversion belongs to the application coordinator. Keeping conversion
outside opening preserves the synchronous App contract and prevents an import
from overwriting another document's saved edits.

Desktop opening imports normalized browser records before App readiness. The
host records import sources in the same durable metadata commit as their records,
so retries and reopen preserve IDs and never resurrect a deleted connection.
Conflicting IDs fail import instead of retargeting saved workflow choices. Old
browser bytes remain available for recovery, while all new desktop writes go to
the shared owner. Product selections remain local and separate.

The Svelte adapter still earns observation and presentation. It loses custom
connection CRUD forwarding and independent routing logic. Account/runtime
matching can be shared at the application layer without flattening their
management into custom connections.

## Considered alternatives

- Share catalogs through account sync: not needed for sharing apps on one desktop; would add cross-device credential and conflict policy.
- Use `read()` plus a change-only `onChange()`: makes each reactive caller assemble its initial snapshot and updates. `getAll()` and immediate `subscribe()` state that contract directly.
- Keep `configuration` beside `configured()`: separates editing from use with names that require explaining their grammatical difference.
- Put `resolve('completion', model)` in core AI: combines application settings lookup, model consistency policy, and client lookup in a capability API.
- Remove optional custom credentials: excludes endpoints requiring bearer authentication for little reduction in the connection contract.
- Make all sources editable custom records: misrepresents account authentication and runtime ownership.
- Require `ai.client(id)` across every source: the implemented custom lookup did not need it. A unified access view is now being reconsidered for the shared-environment experience; it still must not own workflow scopes or choose fallback destinations.
- Select a server by discovered model name: can silently redirect data or billing when inventories or ordering change.
- Add a separate inference Account: creates a second identity selector and replacement lifetime.
- Put dictation on the unopened Application: leaves its Account, readiness, and cleanup outside the opened App's lifetime; it does not solve native sharing across SPAs.
- Make the custom connection collection own dictation: couples connection CRUD to microphone and transcript lifecycles.
- Expose only an unscoped dictation stop: a delayed action can stop a different session even when one microphone admits only one capture at a time.
- Require every native engine to expose an HTTP server: native custom fetch can implement the supported protocol over the existing bridge.

## Implementation

`packages/app/src/ai-connections.ts` owns browser records.
`packages/app/src/ai-connections.epicenter-host.ts` owns the desktop subscribed
view; the package selects its default AI binding through `#platform/ai`.
`apps/epicenter/src/ai-catalog.ts` owns profile metadata, keychain references,
and custom request forwarding. Its routes use the host's existing browser
session and mutation Origin checks. Metadata writes sync the file and attempt
to sync the containing directory after rename; if directory sync is unavailable,
retired key references are retained so a reverted directory entry can still
find its credential.

Whispering and Vocab retain selections through
`packages/app-shell/src/inference-selections.ts`. The picker uses the full
`app.ai.connections` API, waits for saves before selection, and supports replacing
or removing a hidden desktop key. The old combined configuration owner and
public aliases remain removed.

`bun packages/app/scripts/ai-connections.browser.mjs` verifies browser migration
and exact SDK routing. `bun packages/app/scripts/shared-ai-catalog.browser.mjs`
verifies two test SPA documents through real host routes, session and Origin
checks, SSE updates, import/reload, independent selections, credential isolation,
access retirement, and catalog reopen. It uses a process-memory secret owner;
Rust keychain access and host process restart are outside that harness. `bun packages/app-shell/scripts/inference-picker.browser.mjs`
verifies pending and failed saves, hidden key retention/removal, cross-window
updates, and suppression of late selection after the picker closes.

The dictation proposal above remains separate microphone-to-text work. Real native capture acceptance
continues in the [runtime integration handoff](../../specs/20260909T171130-ai-runtime-integration.handoff.md).
