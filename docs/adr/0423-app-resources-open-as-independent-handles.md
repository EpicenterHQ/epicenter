# 0423. Stores own data, blobs, and SQLite while services open independently

- **Status:** Proposed
- **Date:** 2026-09-22
- **Unbuilt:** Complete application outcome propagation, Shared resource opening, and live SQLite projections. Page-root composition, direct runtime transcription, and store-owned blob acquisition are implemented in the current product paths; the generic composition surface remains incomplete.
- **Amends:** [ADR-0388](0388-the-app-owns-what-a-library-scopes-and-the-package-s-modules-supply-what-the-device-supplies.md) and [ADR-0390](0390-the-app-is-the-unit-of-ownership-and-a-capability-is-the-unit-of-sharing.md) at resource ownership; [ADR-0389](0389-the-open-call-decides-the-app-s-type-and-a-local-app-has-no-account-members.md) at aggregate App return types; [ADR-0404](0404-the-opened-account-owns-application-local-storage.md) at account-partitioned local resources; [ADR-0407](0407-app-owns-the-declaration-and-data-engine.md) and [ADR-0408](0408-one-app-opener-uses-a-complete-runtime.md) at aggregate opening and runtime injection; [ADR-0410](0410-an-app-is-returned-ready-and-page-teardown-owns-recovery.md), [ADR-0411](0411-honeycrisp-displays-data-from-one-app.md), [ADR-0412](0412-app-data-addresses-name-scopes-not-libraries.md), and [ADR-0413](0413-app-boot-owns-the-working-page-lifetime.md) at App-wide lifecycle and nested capability access.
- **Implementation note (2026-09-22):** Stores own `.blobs` acquisition and cleanup. Whispering opens Local, optional Personal, recorder, and inference resources from its page root; the direct runtime transcriber is implemented. Product integration remains incomplete outside those paths. See `packages/app/README.md` for the current public API.

## Context

The former aggregate opener acquired Local data, SQLite, secrets, recording,
blobs, and AI as one App. Independent constructors replace that dependency tree.
Store and blob acquisition repeat the same scope selection and product cleanup.
The target groups tables, KV, blobs, and local SQLite under a store while keeping
recording, inference, and secrets independently constructed. SQLite ownership is
implemented as specified in [ADR-0436](0436-stores-own-local-sqlite-namespaces.md).

## Decision

### Vocabulary and ownership

`@epicenter/app` is a toolkit for building applications. The desktop host loads
applications and supplies shared native capabilities. An application opens the
independent resources its workflows need; it may use several stores.

`defineStore({ id, title?, tables, kv })` declares a store's stable ID and schema
under [ADR-0430](0430-define-store-declares-data-and-products-compose-resources.md).
Its literal inference, validation, and schema-only consumers remain independent
of acquisition. Importing the definition opens no storage, captures no Account,
and selects no platform implementation. Schema inspection, artifacts, tests,
and live stores consume the same declaration. An application may open several
definitions; the definition ID names data, not the product's execution.

An opened structured store holds one Yjs data document containing its tables,
rows, and settings, and owns a blob namespace exposed as `store.blobs`. The
store additionally owns a local SQL namespace exposed as `store.sqlite`. Local and Personal stores opened from the
same definition are distinct datasets. Definitions can also differ by workflow.
Audio bytes live outside the structured document even though the store owns
these capabilities. Shared ownership does not make their writes atomic.

Use “document” for this data document in application architecture explanations.
Use “browser/WebView lifetime” explicitly when describing UI reload and handle
ownership. A main interface and an auxiliary overlay can communicate by messages
without the overlay opening another store. Window count does not determine
store count. No AppInstance, application-document, or library primitive is needed.

Root handles normally last for the browser/WebView lifetime. Reload replaces
JavaScript state and access handles; committed data survives. The host owns
shared native services and retirement of access belonging to a departed WebView.
Shorter-lived operations still release their temporary resources.

### Independent acquisition

**Each resource constructor captures its required inputs and owns its handle.**

The acquisition boundaries are listed here. Verify current signatures
against the resource subpaths and `packages/app/README.md`.

| Import | Constructor | Captured input |
| --- | --- | --- |
| `@epicenter/app/open` | `openLocal(definition)` | Definition; owns local tables, KV, blobs, and SQLite |
| `@epicenter/app/open` | `openPersonal(definition, { account })` | Definition and account; owns personal tables, KV, remote blobs, and account-scoped local SQLite |
| `@epicenter/app/secrets` | `openSecrets({ id })` | Device-local secret namespace |
| `@epicenter/app/recorder` | `createRecorder({ localBlobs: local.blobs })` | Borrowed Local blob destination |

Inference and saved-catalog constructors are specified in
[ADR-0365](0365-ai-owns-inference-access-and-applications-own-workflow-selection.md).
Blob transfer and recorder dependencies are specified in
[ADR-0372](0372-local-and-remote-blobs-open-independently.md) and
[ADR-0366](0366-a-recorder-captures-into-its-explicit-local-blob-destination.md).

Store definitions contain their ID and schema. The ID selects the document, blob, and SQL
namespaces; the opener fixes their ownership. Every store exposes `blobs` and `sqlite`.
The public store shape keeps account identity private under
[ADR-0429](0429-store-handles-keep-account-identity-private.md); openers capture
Personal identity privately and handles expose no Account projection.
Whispering's recording ownership follows
[ADR-0428](0428-whispering-recordings-reference-audio-in-their-containing-store.md).
A future `openShared` follows the same shape with shared-owner authorization;
it remains unbuilt. Secrets still take their own `{ id }`. SQLite borrows the
containing store's scope and lifetime under ADR-0436. An ID selects storage; it grants no authorization.

The former standalone `openSqlite` was replaced by borrowed `store.sqlite` with
`open(name)` and `delete(name)`. Store close owns SQL cleanup. SQL retains
connection identity, statement ordering, and deletion
that retires borrowed connections. Local Mail needs several dynamically named
databases. This capability is distinct from a derived store SQL projection.
Secrets retain `get`, `put`, and `delete`; browser secrets last for the document,
and desktop secrets use the keychain.

Local data, blobs, Local SQLite, secrets, and recording destinations take no Account.
They retain the same namespace across sign-in and account replacement. Personal
data, remote blobs, and Personal SQLite require an Account and capture its identity and transport
before asynchronous acquisition. Replacing an account never retargets a handle.
Saved AI catalogs retain their separate account partitions; this decision does
not merge their credentials into device-global storage.

**Products compose resources without a generic App or Device handle.**

The SDK already removed aggregate `openApp`. Do not reintroduce its capability
tree or complete `AppRuntime`. Product composition helpers are not SDK owners. Do not retain an optional
generic composition API or a compatibility alias. A product can define its own
composition function that names its required resources. Root handles can belong
to the whole page, with terminal startup failure and reload to retry. The
function need not recreate an aggregate resource with its own close tree.
Optional inference failure does not block unrelated data or recording. Operations
receive the handles they use; sign-in and availability remain explicit.

Product composition does not imply one readiness barrier. Local capture depends
on an opened Local store's blobs and a recorder; it must not await Personal or
inference. A definite Account can start Personal acquisition separately. A
workflow selecting Personal waits for that store without changing its destination
on failure. Signed-in Local workflows can still use ready account features.

The mounted product starts any composition function. Exporting an eager live
`app` promise or individual opening promises moves acquisition to import time
and is outside this ownership model. An application namespace returned from a
helper is ordinary composition, not a new SDK owner. Svelte distribution and
the `get*`/`set*` naming rule are specified in
[ADR-0392](0392-product-boundaries-provide-required-resource-handles.md).

Keep the definition generic needed for table and KV inference. Blob ownership
adds no schema, backend, or transfer generic. Extend the concrete store runtime
with complete isolated blob and SQL bindings for tests; do not fall through to ambient
production storage. Keep provenance and admitted-work tracking even if their
helpers move beside the owning implementation. Delete forwarding-only modules
when they add no contract; do not delete a boundary solely to reduce file count.

Resource modules remain under `@epicenter/app` subpaths. The root retains inert
declarations and schema types; importing a definition acquires no resources and
loads no platform implementations. Stateless modules such as clipboard retain
direct operations and gain no artificial `open` or `close`.

Each capability selects its platform implementation inside the package.
Exceptional test bindings supply only the dependencies that resource uses.
A supplied binding is complete for that resource and never fills missing parts
from ambient production services. This replaces the all-capability runtime
requirement without changing declaration purity or platform selection policy.

**Constructor names express acquisition choices; protocol and result variants remain data.**

Do not require callers to select Local or Personal through a tagged owner option
when `openLocal` and `openPersonal` already name that choice. Internal store
acquisition may retain its owner union, including at a narrow test binding.
Catalog command messages, recording outcomes, typed failures, and saved
inference destination identities still need variants; more constructor names
cannot replace those facts. Split a function when its arguments select different
operations or owners, not merely because its result can have several cases.

**A returned handle is usable, and its close owns terminal cleanup.**

Asynchronous openers resolve after required acquisition and hydration. They
expose no partial handle or separate `ready` promise. They unwind failed
acquisition and preserve both opening and cleanup failures. Readiness does not
certify future network reachability, microphone permission, or model support.
`createRecorder` constructs an inert capture controller; `start()` acquires
input. Its usable destination is fixed at construction.

Every root resource owner exposes `signal` and an asynchronous, terminal, idempotent
`close()`. Close or retirement synchronously aborts `signal` when it fences new
work. Close settles admitted operations and releases owned resources. Repeated close observes the same outcome. Failed
cleanup retains exclusion wherever another owner could race unfinished writes;
page or process teardown remains the recovery boundary. A resource never closes
an unrelated sibling. A store fences and closes its document, blobs, and SQL namespace;
the borrowed `.blobs` and `.sqlite` capabilities have no independent public close.
Failed store opening unwinds every acquisition. Closing preserves committed data and credentials.

Dependencies are directional. A recorder borrows its LocalBlobs destination:
recorder close leaves blobs usable; blob close retires its recorders and waits
for admitted publication and capture cleanup. A transfer admitted through
`destination.copyFrom(source, blobId)` belongs to both handles until it settles. Either
owning store's close cancels that transfer and waits for settlement without closing
the other store. These requirements do not mandate a generic dependency graph
or public lease abstraction.

A page-root handle need not close on component unmount. Full document
replacement ends its product lifetime; a failed root startup cannot retry in the
same document. Earlier successful root acquisitions may remain until replacement.
Individual failed openers still clean up their own partial acquisition.
Shorter-lived owners close temporary handles and suppress late publication.
A shared boot renderer may observe explicit page opening; it does not require
a schema or `openApp`, and does not own an aggregate resource drain.
Workflows spanning upload and row mutation retain their product cancellation
check. Independent resources do not make those operations atomic.

Document replacement and process restart can interrupt work; they do not acquire
a new aggregate teardown barrier. Explicit close is awaitable, while navigation
is not evidence that data was saved. A retired UI cannot resume using retained
handles while replacement is pending.

## Consequences

The SDK loses borrowed `device` assembly, optional account capability branches,
and mandatory initialization of unrelated services. Each store owns document, blob, and SQL namespace acquisition, cancellation,
and cleanup as one scope. Services retain
their own lifetimes. Product startup owns the
small amount of composition it actually performs.

Local content remains visible to users of the same device profile after account
changes. Applications requiring per-person mail or credential isolation cannot
infer it from Local: their product data model must provide it. AI catalog
account isolation remains separate. Changing APIs does not rename durable
addresses, adopt old account-local bytes, or authorize migration or deletion.

The existing implementation is transitional. The integrated ownership cut makes
stores own document and blob acquisition, moves consumers to `.blobs`, and
removes standalone public blob openers together. An isolated API milestone may
precede product migration but must report broken consumers and must not claim
application integration or merge readiness. Retain internal adapters that
publication and transport need. Do not introduce an optional blob mode or a
second public ownership path.
Fresh-destination copies and remote presentation still need their own evidence
under ADR-0372, ADR-0426, and ADR-0427. Product composition helpers must not
reintroduce the removed SDK App owner. Shared stores, native document persistence,
and new storage layouts remain separate work.

## Considered alternatives

- `openDevice` as the new aggregate: still opens unrelated capabilities and
  couples their failure and lifetime.
- Keep `openApp` as SDK convenience: preserves a second ownership model and
  requires every resource change to maintain both paths.
- One opener with tagged owner or capability options: moves the aggregate's
  branches into constructor arguments rather than naming required inputs.
- Make every module an asynchronous opener: adds lifetimes to stateless calls.
- One shared helper before implementing the constructors: fixes abstractions
  before their real differences are known; small independent implementations
  are permitted, with extraction after a shared invariant is demonstrated.

## Verification

Before removing App, verify each handle's failed acquisition, retained-method
fencing, repeated close, and release after successful cleanup. Check duplicate
persistence ownership, SQLite delete/reopen, recorder Stop racing blob close,
transfer cancellation from either owner, and AI response-body cancellation.
Verify source-accurate native recording and upload without materializing audio
in the WebView. Check account catalog isolation, late temporary acquisition, terminal page
startup failure, and the platform-free root import graph. A page can open
multiple stores with different blob namespaces; no library primitive is introduced.
Verify that store opening acquires usable blob and SQL access, failure unwinds all
children, and store close fences all children before awaiting cleanup. A failed
table open also prevents blob and SQL access; this dependency is the cost of one owner.

Store-owned SQLite verification follows ADR-0436: account isolation, complete test
bindings, failed acquisition rollback, and close fencing across all children.
Selected sign-out cleanup follows [ADR-0437](0437-sign-out-offers-removal-of-downloaded-account-data.md);
ordinary close preserves data and is not erasure.
