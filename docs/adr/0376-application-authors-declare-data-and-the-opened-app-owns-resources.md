# 0376. Application authors declare data and the opened App owns resources

- **Status:** Proposed
- **Date:** 2026-09-08
- **Unbuilt:** Complete desktop Local Mail workflow verification remains separate from the browser acceptance evidence.
- **Implementation checkpoint, 2026-09-18:** Runtime composition and App-owned saved recording are implemented. `openApp(definition, account?)` from `@epicenter/app/open` now returns device and account scopes together (ADR-0392); it replaces the three separate openers described in this record. ADR-0405 replaces the nested declaration with `defineApp`. ADR-0407 separates that platform-free declaration from opening and removes public runtime/AI overrides. Real browser capture, App reads/playback, transcription, Polish, and reopen passed in all three libraries. Native file inference passed a real WebView. Complete desktop Local Mail verification remains separate.

## Context

`packages/app` exports the platform-free `defineApp`. Its build-condition leaves select
SQLite and secret implementations. Honeycrisp and Vocab use this declaration;
Whispering uses those same package-selected resources for recording, blobs,
and inference. Local Mail uses the same declaration and reads SQLite and secrets from its opened App.

`openApp(definition, account?)` returns device and account scopes together.
Authors select a store for each workflow and do not assemble platform resources.

The App now coordinates SQL, secret, blob, and recording owners as described in
ADR-0380. It exposes each resource's actual operation object and retains cleanup
controls. The data document owns its operations, persistence, and sync. An
opened App owns the resources its caller uses.
That ownership is capability access and resource lifetime. It does not make a
row an owner of blob bytes, synchronize local and remote bytes automatically, or
delete bytes when a row or reference is deleted.

## Decision

**An application declares its identity and data; the package selects compatible
resources for the build, and opening fixes their scope for one App.**

The target caller is:

```ts
import { openApp } from '@epicenter/app/open';
import { mailDefinition } from './data.js';

const app = openApp(mailDefinition, account);
const ready = await app.ready;
if (ready.error !== null) throw ready.error;

// Product operations borrow app.account.personal.tables, app.device.sqlite,
// and app.device.secrets.
// The caller stops those operations before awaiting app.close().
```

`defineApp` declares and validates the platform-free schema. Opening returns a handle
synchronously; `app.ready` reports whether acquisition succeeded. A module import
is not evidence of readiness. A SPA starts its primary opening from mounted
application bootstrap; consent callbacks and auxiliary routes open no library.

There is one public opener, `openApp(definition, account?)`, and it returns the two scopes of
ADR-0392: `device` always, and `account` with `personal` and `shared` when the
signed-in person can reach them. One application page holds one App for one auth generation and
ends it by close and navigation when the account changes. Shared access still
requires server authorization.

**Platform selection, resource scope, and shutdown have distinct owners.**

| Owner | Responsibility |
| --- | --- |
| Application declaration | App ID and one schema |
| App runtime | Compatible blob storage and saved recording, plus SQLite and secret implementations |
| Opened App | Capture the actor and available libraries, expose capabilities, coordinate shutdown |
| Resource implementation | Perform its operations and enforce the lifecycle its resource needs |
| Product workflow | Complete or cancel its sequence across storage and network calls before departure |

Standard application authors do not inject SQLite or secret stores.
`defineApp` is the single declaration entrypoint. It replaces
`createEpicenter` and `bindApplication`; `openApp` retains lifecycle ownership.

**A runtime selects recording and blob access together so every successfully
saved recording is readable through the same App.**

The browser recorder currently writes to browser blob storage. The desktop
recorder publishes through Epicenter's native host. Combining desktop capture
with browser blob access can return an audio ID whose bytes the App cannot
read. A recorder-only override therefore does not express a valid platform
choice.

The package selects recording and blob access together through its build
conditions. ADR-0407 removes the public runtime and AI override paths and the
per-target runtime exports. Native resources require Epicenter's host commands
and blob routes. ADR-0403 proposes replacing build selection with a runtime
check; that selector remains unbuilt.

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
The package owns recording/blob compatibility and AI resource selection.
The implementation exercises recording publication through App blob reads.
Remaining hardware acceptance lives in the
[application runtime spec](../../specs/20260909T085106-application-runtime-composition.md).
One App exposes Local, Personal, and Shared under their owning scopes.

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
