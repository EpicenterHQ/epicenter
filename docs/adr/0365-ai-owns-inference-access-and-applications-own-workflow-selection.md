# 0365. AI owns inference access and applications own workflow selection

- **Status:** Proposed
- **Date:** 2026-09-08
- **Revised:** 2026-09-10
- **Unbuilt:** `app.device.connections` and `app.account.connection` as the two access members; the signed-out invitation design; `connectionFor`, `connection.transcribe`, and selections as declared `app.device.kv` fields. Shared desktop custom connections are implemented, and selections are persisted today by `createInferenceSelections` in `packages/app-shell/src/inference-selections.ts`. Real native capture acceptance remains separate.

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
The App does not need to know what `completion`, `transcription`, or a
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

- Desktop shares one custom catalog across an account's apps in the local
  profile. Changing accounts selects another catalog (ADR-0404).
- Browser apps on one origin share an account-scoped custom catalog.
  Different origins do not share storage.
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

`app.device.connections` exposes the environment's custom catalog beside the
host-supplied native runtime. Desktop stores
metadata in `ai/<owner>/connections.json` under its profile data directory. One host
owner serializes writes, persists by atomic replacement, and broadcasts committed
snapshots to its apps over SSE. Browser bindings use `localStorage` under the
account's storage key, with Web Locks for writes and notifications for other
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

### The access view is decided; the signed-out invitation is not

ADR-0392 settles how access is sorted: by owner, into two scopes. The machine
owns the native runtime and the custom endpoints in `app.device.connections`;
the signed-in person owns one server gateway at `app.account.connection`. The
picker composes its list from those two members and needs no third view.

The signed-out invitation still needs a design. A person with no account has no
`app.account`, so the Epicenter group in the picker is an invitation rather than
a connection, and what that group says and offers is undecided. This catalog
change does not alter the authentication or opening lifecycle.

### Inference access and the current API

**The App supplies connections bound to destinations and credentials. The caller
chooses a connection, supplies a model, and makes a request.**

Access sits under the scope that owns it (ADR-0392):

| Member | Source and owner |
| --- | --- |
| `app.device.connections` | The machine's catalog: the host-supplied native runtime plus the custom endpoints a person added, with management and client access |
| `app.account?.connection` | One gateway for the signed-in person's server, using the App's captured Account transport, absent when no account opened the App |

The account gateway keeps its own authentication and is not a record in any
catalog. The native runtime appears in the machine's catalog but is
host-supplied, not an editable entry. A runtime connection can use a native
bridge; a custom connection can reach an HTTP server on this machine. The scope
names say who owns a connection, not where computation physically occurs.

The implemented custom API combines management and requests in one entry:

```ts
const id = await app.device.connections.add({
  name: 'My server',
  baseUrl: 'https://inference.example/v1',
  apiKey: providerKey, // Optional; omit for endpoints without bearer auth.
  models: ['chosen-model'],
});

const connection = app.device.connections.get(id);
if (!connection) return showMissingConnection();

await connection.client.chat.completions.create({
  model: 'chosen-model',
  messages,
});
```

Call sites write `app.device.connections` directly rather than aliasing the
member to a short variable. The full path keeps ownership visible. A workflow
can retain a selected connection to fix its destination for that run.

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

The App exposes no scope-indexed selections, default workflow model, `select`,
or `target`. A lookup in `app.device.connections.get(id)` addresses one entry in
the machine's catalog; it does not choose a workflow or a scope.
`connectionFor(app, selection)` is the exception the platform does own: a free
function that takes the explicit `{ connectionId, model }` the caller supplies
and stores nothing. [ADR-0396](0396-a-connection-transcribes-and-owns-the-four-rules.md)
records that surface.

Applications remember explicit connection-and-model pairs. Each pair is a
declared field in that application's `app.device.kv`, the machine's store, so it
survives sign-out and never syncs. No owner outside `@epicenter/app` persists
it. The application owns the field names, the initial default, and which
workflow reads which field. Svelte observes `app.device.kv`; product operations
read the same field without importing reactive UI state.

Saved account references identify the concrete authority and principal. Native
runtime references identify the supplied destination. Custom references use the
immutable connection ID. A missing reference must not match another scope, a new
account, or a connection advertising the same model. A workflow captures its
connection and model together before sending data.

**The opened App owns inference access for its lifetime.**

`defineApplication` is inert composition. `open(account)` returns an App
synchronously; the caller awaits `app.ready` and stops product work before
`app.close()` (ADR-0392).

The account supplied at opening determines both the account libraries and
account inference. `open(null)` has no `app.account`, so no account inference,
even if authentication elsewhere is signed in. An App opened with an account
uses that captured actor for inference. There is no independent
inference-account selector. Same-owner credential refresh preserves access
through the captured transport; account replacement closes the App and opens
another.

The storage and native inference bindings are selected independently at
application declaration. Selecting native storage or running inside Tauri does
not itself supply native inference. An absent native runtime means no capability
was supplied, not that a request failed or a model needs downloading.

Retained clients reject premature or retired use. Closing cancels or drains
admitted requests, including streamed response bodies and noninterruptible
native work. It does not stop external servers or unload a shared native engine.
Resource cleanup remains owned by App, not by individual consumers.

**The SDK owns inference operations and protocol types.**

Applications call `client.chat.completions.create` and `client.models.list`
where supported. Epicenter adds no second set of completion verbs, and no
Epicenter type restates a request or response body the SDK already declares.
The one Epicenter verb is `connection.transcribe`, which exists because four
rules around a transcription call are platform rules rather than product choices
(ADR-0396). Application workflows translate SDK exceptions into their existing
Results everywhere else.

A native adapter can translate supported SDK requests into Tauri commands
through custom fetch without opening an HTTP socket. The current adapter
implements model listing and file transcription. Client presence does not
promise all SDK endpoints, full protocol parity, successful model loading, or
reachability. Native use requires evidence for real audio, explicit model
selection, result mapping, authorization, and cancellation or drain.

**There is no dictation capability on the App.**

Microphone-to-text is `app.device.recording` (ADR-0366) followed by
`connection.transcribe` (ADR-0396), and an application composes the two calls
itself. Each call already carries what a shared member would have carried:
capture is bound to the App's lifetime and the machine's input selection, and
the connection is bound to the App's signal and the caller's explicit
`{ connectionId, model }`. A dictation member would capture nothing that
`open()` fixed beyond what those two already capture, so under ADR-0388 it
does not join the App. Vocab's dictation is one `transcribe` on
`app.account?.connection` over its own VAD-segmented capture; Whispering's
saved recording is one `start()` and one `stop()`.

A shared helper over the two calls is promoted, into `@epicenter/app-shell`,
only when a second application needs more than the two calls, for example
streaming partial transcripts during capture. It is not promoted on intention.

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
connection CRUD forwarding and independent routing logic. `connectionFor` in
`@epicenter/app` matches a selection across both scopes without flattening the
account gateway or the native runtime into the custom catalog.

## Considered alternatives

- Share catalogs through account sync: not needed for sharing apps on one desktop; would add cross-device credential and conflict policy.
- Use `read()` plus a change-only `onChange()`: makes each reactive caller assemble its initial snapshot and updates. `getAll()` and immediate `subscribe()` state that contract directly.
- Keep `configuration` beside `configured()`: separates editing from use with names that require explaining their grammatical difference.
- Put `resolve('completion', model)` on the App: combines application settings lookup, model consistency policy, and connection lookup in one capability API. `connectionFor(app, selection)` is the narrower shape that survived, because it reads no setting and knows no workflow scope.
- Remove optional custom credentials: excludes endpoints requiring bearer authentication for little reduction in the connection contract.
- Make every connection an editable custom record: misrepresents account authentication and native runtime ownership.
- Require `ai.client(id)` across every scope: the implemented custom lookup did not need it. A unified access view was reconsidered and then decided by ADR-0392, which sorts access by owner into `device` and `account`; neither owns a workflow scope or chooses a fallback destination.
- Select a server by discovered model name: can silently redirect data or billing when inventories or ordering change.
- Add a separate inference Account: creates a second identity selector and replacement lifetime.
- A dictation capability on the App with `start({ onUpdate, onError })`, `finish()`, and `cancel()`: proposed 2026-09-08 and withdrawn 2026-09-12. It captured nothing beyond what recording and the connection already capture, and one application needed it. Under ADR-0388 that is a composition, not a member.
- Put dictation on the unopened Application: leaves its Account, readiness, and cleanup outside the opened App's lifetime; it does not solve native sharing across SPAs.
- Make the custom connection collection own dictation: couples connection CRUD to microphone and transcript lifecycles.
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
`app.device.connections` API, waits for saves before selection, and supports replacing
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

`bun packages/app/scripts/shared-ai-catalog.native.mjs` closes the native
catalog acceptance gap with two installed test applications in real macOS
WebViews. It uses the existing Rust secret bridge and OS keychain, restarts
both host processes, preserves product selections and deleted import markers,
and verifies SSE reconnect and upstream cancellation at each closure boundary.
The [native procedure and evidence](../../packages/app/scripts/shared-ai-catalog-native/README.md)
state the fixture's isolation and limits.

The optional `--whispering` run also exercises the built desktop product's
transcription picker, audio import, and saved transcript after a new document
opens. Its authenticated fixture endpoint runs the real cached Whisper Tiny
engine through Tauri MockRuntime. The product's catalog, keychain, and WebView
paths remain native. Multipart forwarding preserves the encoded body and
boundary: passing a Request as RequestInit creates a stream upload that WebKit
rejects before it reaches the broker.

Cancellation preserves the distinction between an existing response error and
a failed cleanup operation. An errored stream repeats its stored error from
`cancel()` and `reader.closed`; an underlying cancellation failure leaves
`reader.closed` fulfilled. App closure only reports the latter as a cleanup
failure. At the host, an incoming request that already disconnected needs its
local response closed, while access retirement for a connected caller still
errors the response. Both paths cancel the upstream body.

Real native file-transcription acceptance continues in the
[runtime integration handoff](../../specs/20260909T171130-ai-runtime-integration.handoff.md);
concurrent native capture continues in the
[concurrent native capture spec](../../specs/20260912T122859-concurrent-native-capture.md).
