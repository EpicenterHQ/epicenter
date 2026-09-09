# 0373. Product operations read the page-owned App when invoked

- **Status:** Proposed
- **Date:** 2026-09-08
- **Relates:** [ADR-0369](0369-an-application-page-owns-one-library-and-changing-it-ends-the-page.md) fixes one library for an application document. This proposal preserves that lifetime and reconsiders how product consumers reach it.
- **Unbuilt:** Remaining product/context argument removal and native capture/recovery acceptance. The UI session still owns subscriptions, queries, and producer teardown.

## Context

Whispering's page opens a framework App, while `WhisperingShell` constructs a
`createWhisperingUiSession` that combines domains, recording workflows, queries,
and reactive views. Operations including `transcribeAndPersist`,
`processRecordingPipeline`, and `runPolish` receive that product object as their
first argument. The page reaches back into the shell to coordinate closure.

The reviewed alternatives added `createWhispering(app)`, a product `ready`
promise, or an inert product handle with opening methods. Those are useful only
if the product owns additional initialization or resources. A group of functions
that operates on the page's existing App needs no second application lifetime.

Defining a method does not execute its body. A method can import the App binding
and read it when called, even if its module was evaluated before startup.
Calling a factory with `app` at module scope instead reads the binding then.
Passing an uninitialized value does not establish a reference to its future
assignment. Freezing an object of methods does not change either rule.

## Decision

**App-specific operations access the document's one App inside their function
bodies. Importing operation modules defines behavior and acquires nothing.**

Bootstrap owns library selection, opening, successful readiness, and terminal
closure. It publishes one App for the document and never replaces it. Callback,
connection-only, auxiliary, and route-preload imports must acquire no library.
The existing eager `application.ts` export cannot become a generally imported
module unchanged: its mounted dynamic import currently protects acquisition.
An import-safe publication boundary must be implemented before migrating callers.

The intended product shape is ordinary operation modules, optionally grouped
into cohesive objects. This sketch describes the proposed access pattern, not
current exports or a complete transcription implementation:

```ts
import { app } from '$lib/application';

export const whispering = {
  async transcribeRecording(recordingId: RecordingId) {
    // Read app.tables.recordings, app.blobs, and supplied inference here.
    // Coordinate the product workflow and persist its result.
  },
};
```

The object adds no `ready`, `openLocal`, `openAccount`, or `close` merely to
group functions. Named exports and cohesive namespaces follow their callers;
this decision does not require one giant Whispering object. Consumers keep full
member paths such as `app.tables.recordings` rather than capturing namespace
aliases. Fixed document identity makes call-time access stable across awaits;
it does not permit operations after close begins.

The Svelte boundary observes plain product/data capabilities and gates consumers
on successful readiness. A fulfilled Result may still contain an error.
Templates and component-instance statements run after the gate; imported module
statements do not. Module-level reads, destructuring, factory calls that inspect
data, and effectful transitive imports remain prohibited before initialization.
Background triggers must satisfy the same admission rule independently of UI.
Direct import syntax itself neither supplies reactivity nor ensures readiness.

Keep factories for resources or state that genuinely have an instance boundary,
for example a recording session, an editor binding, or independently configured
services. A factory receiving an already initialized App is still valid when
it owns such a boundary. Reusable packages and explicit cross-library operations
retain explicit capabilities; they do not import Whispering's global App.

## Consequences for Whispering

Migrate operations according to the capability they actually use. Current
`WhisperingApp` is not interchangeable with the framework App. Product prompts,
recipe execution, retry policy, transcript retention, and delivery remain
Whispering code even when their dependencies move to the framework handle.

The related AI proposal describes configured clients on App; the remote-blob
proposal describes capability presence on App. Their implementation is in flight; neither is a verified prerequisite
merely because a proposal or working-tree implementation exists. Their migrations must replace actual
Account uses before removing Account from product composition. Preserve native
audio addressing, explicit inference destinations, and account-management UI.
Local storage with separately authenticated inference remains an opening-contract
question; a global read must not silently select another inference Account.

Delete `createWhisperingUiSession`'s redundant composition and product context
only after their remaining resources have named owners. Svelte views, query
providers, and UI effects keep the framework lifetime they require. Product
operations remain plain JavaScript; moving a rune-backed constructor into a
`.ts` file does not satisfy that boundary.

Departure still stops new producers, submits buffered edits, drains admitted
multi-step workflows, and closes the App before deliberate identity mutation.
App close cannot account for an unregistered workflow waiting between storage
calls. Preserve recording refusal, partial-startup cleanup, and native close
acknowledgment independently of an in-progress sign-out action. A module
singleton does not make physical shutdown unnecessary.

## Verification

Prove that importing and preloading operation modules opens nothing; bootstrap
publishes exactly one App; failed readiness never enables consumers; and
operation calls reach that same App. Exercise retained methods after close,
final editor writes, recording startup/save drains, and native departure.
Verify no product module creates an import cycle back into bootstrap and no
plain product operation depends on Svelte adaptation.

## Considered alternatives

- A second Whispering handle with its own readiness and open methods: earns its
  lifecycle only if it owns independent initialization, not for method grouping.
- Pass the same product App through every app-specific call: retains a variable
  dependency where the document already fixes identity. Keep explicit inputs
  where callers can genuinely select different instances.
- Eagerly construct domains at import time: executes their current table/KV reads
  before the UI gate and can acquire resources through preloaded dependencies.
- Put all workflows in component scripts: ties shared actions to one UI entry
  even when buttons, shortcuts, and retries invoke the same operation.
- Turn every operation into a global: erases real resource and reuse boundaries.
- Assume live imports retarget factory arguments: arguments capture their value
  at invocation; they do not track subsequent binding initialization.

## Implementation

Whispering has an inert `application.ts`, explicit mounted opening, and call-time
completion, Polish, Recipe, and saved transcription execution. Publication survives
a refused close and remains available to admitted work until UI drain finishes.
Failed readiness releases the App while preserving the opening-error screen.
Svelte observes the same completion resolver that execution uses.

Recording, imports, and retries drain their complete workflows before App closure.
The browser UI has capture/transcription/Polish/playback/reopen evidence in Local,
Personal, and Shared. Native file inference has real WebView evidence; native
capture and reload recovery remain unproved. The UI session remains because it
owns subscriptions, query state, and producer teardown. This implementation
evidence does not change the ADR's Proposed status.

See the [Whispering execution spec](../../specs/20260908T212054-whispering-call-time-app-composition.md)
for dependency reconciliation, caller migration, ownership removal, and acceptance.
