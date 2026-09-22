# 0423. App resources open as independent handles

- **Status:** Proposed
- **Date:** 2026-09-22
- **Amends:** [ADR-0388](0388-the-app-owns-what-a-library-scopes-and-the-package-s-modules-supply-what-the-device-supplies.md) and [ADR-0390](0390-the-app-is-the-unit-of-ownership-and-a-capability-is-the-unit-of-sharing.md) at resource ownership; [ADR-0389](0389-the-open-call-decides-the-app-s-type-and-a-local-app-has-no-account-members.md) at aggregate App return types; [ADR-0404](0404-the-opened-account-owns-application-local-storage.md) at account-partitioned local resources; [ADR-0407](0407-app-owns-the-declaration-and-data-engine.md) and [ADR-0408](0408-one-app-opener-uses-a-complete-runtime.md) at aggregate opening and runtime injection; [ADR-0410](0410-an-app-is-returned-ready-and-page-teardown-owns-recovery.md), [ADR-0411](0411-honeycrisp-displays-data-from-one-app.md), [ADR-0412](0412-app-data-addresses-name-scopes-not-libraries.md), and [ADR-0413](0413-app-boot-owns-the-working-page-lifetime.md) at App-wide lifecycle and nested capability access.
- **Unbuilt:** Independent capability constructors, product composition and caller migration, resource-specific test bindings, and removal of `openApp` and `AppRuntime`; only standalone Local and Personal store opening exists.

## Context

`packages/app/src/open.ts` opens Local data, SQLite, secrets, recording, blobs,
and AI as one App. Its `device` member combines borrowed Local data operations
with capabilities. Its optional account supplies remote access. Personal data
already opens independently through `openPersonal`.

Opening one resource still acquires unrelated capabilities. The aggregate also
makes consumers check whether an account-dependent member exists after opening.
Moving those members into `openDevice` would preserve both problems.

## Decision

**Each resource constructor captures its required inputs and owns its handle.**

The target public imports are listed here. They are implementation targets,
not a claim that these exports exist.

| Import | Constructor | Captured input |
| --- | --- | --- |
| `@epicenter/app/open` | `openLocal(definition)` | Device-local definition |
| `@epicenter/app/open` | `openPersonal(definition, { account })` | Definition and account |
| `@epicenter/app/blobs` | `openLocalBlobs({ id })` | Device-local blob namespace |
| `@epicenter/app/blobs` | `openRemoteBlobs({ id, account })` | Remote blob namespace and account |
| `@epicenter/app/sqlite` | `openSqlite({ id })` | Device-local database namespace |
| `@epicenter/app/secrets` | `openSecrets({ id })` | Device-local secret namespace |
| `@epicenter/app/recorder` | `createRecorder({ blobs })` | Open LocalBlobs destination |

Inference and saved-catalog constructors are specified in
[ADR-0365](0365-ai-owns-inference-access-and-applications-own-workflow-selection.md).
Blob transfer and recorder dependencies are specified in
[ADR-0372](0372-local-and-remote-blobs-open-independently.md) and
[ADR-0366](0366-a-recorder-captures-into-its-explicit-local-blob-destination.md).

Store definitions contain their ID and schema. Capabilities that need only an
ID take `{ id }`; they do not accept a schema as a required dependency. Using
`definition.id` for a capability is a product choice, not implicit attachment
to the store. An ID selects a namespace; it grants no authorization.

`openSqlite` returns a namespace owner with `open(name)`, `delete(name)`, and
`close()`. It retains connection identity, statement ordering, and deletion
that retires borrowed connections. Local Mail needs several dynamically named
databases. This capability is distinct from a derived store SQL projection.
Secrets retain `get`, `put`, and `delete`; browser secrets last for the document,
and desktop secrets use the keychain.

Local data, blobs, SQLite, secrets, and recording destinations take no Account.
They retain the same namespace across sign-in and account replacement. Personal
data and remote blobs require an Account and capture its identity and transport
before asynchronous acquisition. Replacing an account never retargets a handle.
Saved AI catalogs retain their separate account partitions; this decision does
not merge their credentials into device-global storage.

**Products compose resources without a generic App or Device handle.**

Remove `openApp`, the `App` capability tree, and the complete `AppRuntime`
requirement after callers use independent handles. Do not retain an optional
generic composition API or a compatibility alias. A product can define its own
composition function when that function owns startup rollback and workflows.
It opens only the handles that product needs and passes required handles to
consumers. Sign-in and runtime availability are resolved at that boundary.

Resource modules remain under `@epicenter/app` subpaths. The root retains inert
declarations and schema types; importing a definition acquires no resources and
loads no platform implementations. Stateless modules such as clipboard retain
direct operations and gain no artificial `open` or `close`.

Each capability selects its platform implementation inside the package.
Exceptional test bindings supply only the dependencies that resource uses.
A supplied binding is complete for that resource and never fills missing parts
from ambient production services. This replaces the all-capability runtime
requirement without changing declaration purity or platform selection policy.

**A returned handle is usable, and its close owns terminal cleanup.**

Asynchronous openers resolve after required acquisition and hydration. They
expose no partial handle or separate `ready` promise. They unwind failed
acquisition and preserve both opening and cleanup failures. Readiness does not
certify future network reachability, microphone permission, or model support.
`createRecorder` constructs an inert capture controller; `start()` acquires
input. Its usable destination is fixed at construction.

Every resource owner exposes `signal` and an asynchronous, terminal, idempotent
`close()`. Close or retirement synchronously aborts `signal` when it fences new
work. Close settles admitted operations and releases owned resources. Repeated close observes the same outcome. Failed
cleanup retains exclusion wherever another owner could race unfinished writes;
page or process teardown remains the recovery boundary. A resource never closes
an unrelated sibling. Closing preserves committed data and credentials.

Dependencies are directional. A recorder borrows its LocalBlobs destination:
recorder close leaves blobs usable; blob close retires its recorders and waits
for admitted publication and capture cleanup. A transfer admitted through
`remote.addFrom(local, id)` belongs to both handles until it settles. Either
handle's close cancels that transfer and waits for settlement without closing
the other handle. These requirements do not mandate a generic dependency graph
or public lease abstraction.

Product composition stops its own producers before explicit resource closure.
If a later opening fails, it attempts cleanup of every earlier acquisition.
If a component disappears during opening, it closes the eventual handle rather
than publishing it into a dead UI. A shared boot renderer may observe the
product's opening promise; it does not require auth, a schema, or `openApp`.
Workflows spanning upload and row mutation retain their product cancellation
check. Independent resources do not make those operations atomic.

Document replacement and process restart can interrupt work; they do not acquire
a new aggregate teardown barrier. Explicit close is awaitable, while navigation
is not evidence that data was saved. A retired UI cannot resume using retained
handles while replacement is pending.

## Consequences

The SDK loses borrowed `device` assembly, optional account capability branches,
and mandatory initialization of unrelated services. Each resource gains its
own acquisition, cancellation, and cleanup contract. Product startup owns the
small amount of composition it actually performs.

Local content remains visible to users of the same device profile after account
changes. Applications requiring per-person mail or credential isolation cannot
infer it from Local: their product data model must provide it. AI catalog
account isolation remains separate. Changing APIs does not rename durable
addresses, adopt old account-local bytes, or authorize migration or deletion.

The existing implementation is transitional. Land each independent owner with
its required lifecycle behavior, then migrate its consumers. Remove the generic
App once its remaining consumers no longer depend on it. Shared stores, native
document persistence, and new storage layouts are independent work.

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
in the WebView. Check account catalog isolation, late opening after unmount,
partial product startup failure, and the platform-free root import graph.
