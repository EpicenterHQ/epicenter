# 0410. An App is returned ready and page teardown owns recovery

- **Status:** Accepted
- **Date:** 2026-09-18
- **Amended by:** [ADR-0423](0423-app-resources-open-as-independent-handles.md) applies ready-return, terminal close, failed-open rollback, and safe release to each resource; products own composition.
- **Amends:** [ADR-0408](0408-one-app-opener-uses-a-complete-runtime.md) at opening and failure recovery: replace the immediate handle and public readiness promise with an asynchronous opener that returns a usable App.
- **Relates:** [ADR-0409](0409-resource-admission-protects-its-storage-owner.md), a proposed admission decision; the implementation preserves one claim and safe release.

## Context

An immediate App handle represents resources while they are opening. It exposes
readiness separately and permits closure during acquisition. Retryable cleanup
then keeps a failed lifetime available for another attempt. These promises make
partial construction and recovery visible throughout App composition and page UI.

The user chose a narrower product promise: one App per application page, with
page teardown as recovery after opening or cleanup failure. Existing application
callsites and Vocab configuration do not constrain the new API.

## Decision

**The page owns opening; openApp returns a ready App; a failed lifetime requires
page teardown before the page starts another one.**

```ts
const app = await openApp(definition, { account });
await app.close();
```

Opening resolves only after ownership, document hydration, and required catalog
hydration succeed. It rejects on failure without exposing a partial App. The page
observes the opening promise to render loading, content, or a terminal error.
There is no public `ready`, cancellation handle, retry opener, or close-retry flag.
Top-level await is optional; the UI can observe the promise directly.

Close is asynchronous, terminal, and idempotent. It immediately refuses new work,
flushes and drains admitted work, closes resources, then releases ownership only
when safe. Repeated calls observe the same outcome; rejection does not reset the
lifetime or enable retry. External retirement also revokes operations immediately.
Closed or retired handles never regain usability.

Failed opening cleans up acquired resources where possible. Cleanup must not
release ownership while any resource may still write. If cleanup cannot finish
safely, the ownership mechanism must retain exclusion until page/process teardown,
even though no App handle was returned. Preserve the original opening failure and
make cleanup failure observable; do not report successful cleanup falsely.

A second window still gets AlreadyOpen. No waiting, takeover, browser-storage
fallback, or in-place replacement after failure is introduced. Page policy owns
one opening attempt, while the admission mechanism owns cross-window exclusion.

Successful close may be followed by another lifetime against the same memory
runtime in tests. App failure does not authorize force-disposal of live memory
resources; terminal-failure tests use isolated pages or processes. Ordinary
memory-runtime disposal still requires resources to be released.

## Consequences

The App-level initialization flag and pre-readiness checks disappear because no
caller can receive an opening App. The close retry flag and reset paths disappear.
Internal services may still need acquisition and closure state. Moving readiness
inside an async function does not make rollback, draining, or external retirement
unnecessary.

A reload ends a lifetime; it does not prove pending writes were saved. Normal
closure retains flushing and accurate error reporting. After a failed flush the
page must not claim that reload preserves unsaved changes. Account/server changes
must not proceed as if closure succeeded when it rejected.

`App<T>` is derived with Awaited<ReturnType<typeof openApp<T>>>. Account remains
optional in the handle. The declaration and complete runtime contracts are
unchanged. A runtime still selects capabilities; shared services still receive
storage primitives.

## Considered alternatives

- Keep immediate handles and `app.ready`: retains public partial initialization
  to support a cancellation and recovery promise the product no longer needs.
- Wrap an async opener with a partial App facade: recreates the same state and
  permits premature capability access. A UI-owned promise is sufficient.
- Release ownership whenever opening rejects: unsafe when rollback fails or a
  late acquisition can still write.
- Treat page teardown as a successful save: hides possible loss of pending writes.
- Add a public force-close or force-dispose: shifts unsafe release to callers.
