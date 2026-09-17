# 0376. Application authors declare data and the opened App owns resources

- **Status:** Proposed
- **Date:** 2026-09-08
- **Unbuilt:** One `open(account)` returning the hub of ADR-0392; complete desktop Local Mail workflow verification.
- **Implementation:** Runtime composition, App-owned saved recording, and the three separate openers are implemented. Real browser capture, App reads/playback, transcription, Polish, and reopen passed in all three libraries. Native file inference passed a real WebView. Complete desktop Local Mail verification remains separate.

## Context

`packages/app` exports `defineApplication`. Its build-condition leaves select
SQLite and secret implementations. Honeycrisp and Vocab use this declaration;
Whispering selects a complete runtime for recording and blobs, with an independent
AI binding for its transport requirements. Local Mail uses the same declaration and reads SQLite and secrets from its opened App.

`Application` exposes `openLocal()`, `openPersonal(account)`, and
`openShared(account)`, so the caller picks one library before opening. Authors
do not assemble platform resources.

The App now coordinates SQL, secret, blob, and recording owners as described in
ADR-0380. It exposes each resource's actual operation object and retains cleanup
controls. The data document owns its operations, persistence, and sync. An
opened App owns the resources its caller uses.
That ownership is capability access and resource lifetime. It does not make a
row an owner of blob bytes, synchronize local and remote bytes automatically, or
delete bytes when a row or reference is deleted.

## Decision

**An application declares its identity and data; defaults or an explicit runtime
select compatible resources, and opening fixes their scope for one App.**

The target caller is:

```ts
import { defineApplication } from '@epicenter/app';

const application = defineApplication({
  appId: 'so.epicenter.local-mail',
  definition: mailDefinition,
});

const app = application.open(account);
const ready = await app.ready;
if (ready.error !== null) throw ready.error;

// Product operations borrow app.account.personal.tables, app.device.sqlite,
// and app.device.secrets.
// The caller stops those operations before awaiting app.close().
```

`defineApplication` describes construction. Opening returns a handle
synchronously; `app.ready` reports whether acquisition succeeded. A module import
is not evidence of readiness. A SPA starts its primary opening from mounted
application bootstrap; consent callbacks and auxiliary routes open no library.

There is one opening method, `open(account)`, and it returns the two scopes of
ADR-0392: `device` always, and `account` with `personal` and `shared` when the
signed-in person can reach them. One application page holds one App for one auth generation and
ends it by close and navigation when the account changes. Shared access still
requires server authorization.

**Platform selection, resource scope, and shutdown have distinct owners.**

| Owner | Responsibility |
| --- | --- |
| Application declaration | App ID, data definition, and an existing AI settings key when required |
| App runtime | Compatible blob storage and saved recording, plus SQLite and secret implementations |
| Opened App | Capture the actor and selected library, expose capabilities, coordinate shutdown |
| Resource implementation | Perform its operations and enforce the lifecycle its resource needs |
| Product workflow | Complete or cancel its sequence across storage and network calls before departure |

Standard application authors do not inject SQLite or secret stores.
`defineApplication` is the single declaration entrypoint. It replaces
`createEpicenter` and `bindApplication`; `openApp` retains lifecycle ownership.

**A runtime selects recording and blob access together so every successfully
saved recording is readable through the same App.**

The browser recorder currently writes to browser blob storage. The desktop
recorder publishes through Epicenter's native host. Combining desktop capture
with browser blob access can return an audio ID whose bytes the App cannot
read. A recorder-only override therefore does not express a valid platform
choice.

The proposed explicit selection is:

```ts
import { defineApplication } from '@epicenter/app';
import { epicenterHost } from '@epicenter/app/epicenter-host';

const application = defineApplication({
  appId: 'so.epicenter.whispering',
  definition: whisperingDefinition,
  runtime: epicenterHost,
});
```

`runtime` and the `epicenterHost` export are implemented. The explicit browser
runtime is `browser` from `@epicenter/app/browser`.
An explicit runtime supplies the complete storage and capture binding; missing
members are not filled from another runtime. A dual-platform app selects the
value through one build-time import. No string registry, mutable global
registration, or environment detection is needed.

Omitting the runtime preserves today's defaults: build-selected SQLite and
secrets, with browser blobs and recording even in host-served WebViews.
Selecting a host build alone must not redirect existing blob storage.
Explicit native selection requires Epicenter's host commands and blob routes;
it is not a generic Tauri adapter.

AI is an independent optional override. An omitted AI binding uses the standard
configuration; an explicit binding replaces it as a whole. `settingsKey`
continues to select the default AI settings namespace. A supplied AI binding
owns its own configuration and does not inherit `settingsKey` implicitly.

Dictation composes capture from the machine's runtime with inference reached
through a connection (ADR-0396). It creates no second microphone owner. In the
native runtime, recording and dictation from every App reach the same host
owner. That owner reserves inputs per session under
[ADR-0366](0366-recording-is-an-app-scoped-portable-capability.md).

The Application declaration remains inert. Each opened App owns its issued
Recording and DictationSession handles and their cleanup. A shared host engine
outlives any one App; its existence neither grants a signed-out App account
inference nor requires temporary dictation audio to enter permanent blob
storage.

**App owns saved-recording integration; the recorder package owns portable
microphone and voice activity detection primitives.**

The saved-recording contract lives at `@epicenter/app/recorder`, with browser
and host implementations internal to App's runtime composition. Native imports
stay outside browser builds' static import graphs.
`@epicenter/recorder` retains device vocabulary, microphone streams, VAD, and
VAD assets. Existing transient dictation consumers keep that independent API.
The move preserves native publication boundaries; it does not funnel native
audio through the WebView or create a recovery promise for unfinished capture.

The shutdown composition exposes actual capabilities. The data engine
owns document operations, persistence, and sync. The App coordinates its known
resources in dependency order. It does not grow a generic cleanup registry or
require a synthetic close method on a resource with nothing to release.
Resource checks remain necessary where a retained method could reach closed
storage. Ordinary failures already represented as Wellcrafted Results pass
through unchanged; throwing platform APIs are adapted at their owning boundary.

**Secrets remain local to the captured application.**

`app.device.secrets` has `put`, `get`, and `delete` over labeled strings. Browser
secrets last within the document; desktop secrets use the keychain. They never
enter table synchronization or queryable SQLite. Closing does not delete them.
A secret is addressed by application id and label (ADR-0400). Sharing rows in a
Shared library does not share Gmail credentials, because credentials are not in
a library at all.

Product operations read the App when invoked. Multi-step mail work keeps its
own admission and drain accounting: reading a token, fetching mail, and writing
messages is one workflow, including the time between resource calls. This
accounting neither opens another App nor duplicates physical storage ownership.

Local Mail uses `app.account.personal.tables.savedQueries` for synchronized
definitions, `app.device.sqlite` for the downloaded Gmail cache and pending
intentions, and `app.device.secrets` for credentials. Sharing one App does not merge these
storage semantics. SQL's permitted table names refer to physical cache tables,
not to `tables` collections.

### How the related proposals compose

These proposals cover separate decisions and retain their own implementation gaps:

| Record | Decision |
| --- | --- |
| [ADR-0375](0375-library-ownership-is-local-personal-or-shared-within-one-deployment.md) | Account identifies the actor; Local, Personal, or Shared selects the library |
| ADR-0365, the separate AI boundary proposal | App exposes inference access; applications compose capture and inference and own workflow selections |
| [ADR-0366](0366-recording-is-an-app-scoped-portable-capability.md) | App owns saved recording; one native owner admits sessions on distinct input devices |
| [ADR-0380](0380-the-caller-owns-when-to-close-and-the-app-owns-resource-shutdown.md) | Caller chooses when to close; App orders shutdown; resources implement cleanup |
| [ADR-0377](0377-a-table-may-omit-its-content-codec-while-every-row-owns-a-node.md) | A fields-only table can omit its content codec |
| [ADR-0378](0378-local-mail-saves-sql-definitions-and-queries-cached-gmail-facts.md) | Saved SQL synchronizes; execution reads one selected Gmail cache |
| [ADR-0381](0381-user-authored-sql-runs-through-a-bounded-read-only-operation.md) | The application fixes permitted tables; SQLite enforces restricted execution |

## Consequences

An ordinary app supplies its ID and definition and receives the standard
capabilities. Repeated per-app runtime and SQLite leaf modules disappear.
Whispering's distinct native resources and existing AI settings keys remain;
constructor consolidation does not change their storage destinations.

Whispering selects resources through
one runtime selection. Its distinct AI transport remains independent. Runtime
authors take responsibility for storage/capture compatibility; implementing
arbitrary factories is not proof that their returned blob IDs are readable.
The implementation must exercise recording publication through App blob reads.
Execution checkpoints for this bounded change live in the
[application runtime spec](../../specs/20260909T085106-application-runtime-composition.md).
The integrated implementation preserves explicit Local, Personal, and Shared
opening and each library's resource scope.

Local Mail starts fresh in the account-owned scope. Old local caches,
credentials, registries, and intentions are not adopted. Subsequent saves must
persist and reopen offline. The clean break requires no physical deletion of
old user files and changes no other application's resource destinations.

Resource shutdown now lives outside the data engine. Product operations still
use `app.device.sqlite` and `app.device.secrets`. The resource owners preserve closure, partial
acquisition, producer drain, and failed-cleanup exclusion guarantees.
The implementation sequence and verification gates remain in the
[Local Mail execution spec](../../specs/20260908T233656-local-mail-app-and-saved-queries.md).

## Considered alternatives

- Repeat `bindApplication` in every app: makes consumers assemble identical platform bindings.
- Register a mutable runtime globally: introduces initialization order and replacement state.
- Override recording independently of blobs: permits publication into a store the App cannot read.
- Select a runtime with a string: adds a registry and obscures native import requirements.
- Automatically select native blobs in every host build: redirects existing applications' storage.
- Move all microphone code into App: couples transient VAD consumers to saved-library integration.
- Put secrets on the unopened declaration: leaves their actor scope and retirement unbound.
- Give every capability the same promise tracker: does not capture recording sessions, response streams, or multi-step product work.
- Treat Shared as a shared Account: loses the actor and can expose provider credentials with shared rows.
