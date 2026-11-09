# 0777. A capability has no ready promise

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Amends:** [ADR-0767](0767-an-async-lifecycle-is-modeled-as-synchronous-state-actions-wait-on-their-own.md) at what a capability exposes of its first load: its reads answer at every moment and its actions wait, so nothing exposes a promise of being ready.
- **Relates:** [ADR-0769](0769-svelte-reads-every-capability-through-one-reactive-copy.md) (the four verbs), [ADR-0775](0775-a-write-never-fails-the-folder-keeps-it-until-it-lands.md) (a folder's writes wait until they land).
- **Amended by:** [ADR-0778](0778-a-page-connects-once-and-then-reads-synchronously.md) at reads answering "from what it has so far": a read of stored data answers after the page has connected, and nothing renders before.

## Context

ADR-0767 models an async lifecycle as synchronous state and lets actions
wait on their own. Several capabilities still also exposed `ready`, a
promise of their first load, and app code awaited it before acting: Vocab's
session before asking the tutor, Whispering before reading model choices
or a custom endpoint, the desktop's device settings before writing
connections. Each was a second way to say what the capability's reads and
actions already said, and each caller had to remember to await it.

## Decision

**No capability exposes a promise of being ready.** Its reads answer at
every moment, from what it has so far; its actions wait for whatever they
need and then run. Code that needs to act after a capability has loaded
calls the action, and the action waits. Code that needs to show progress
reads the capability's state.

## Consequences

- `ready` and every `await x.ready` go.
- A capability that has not loaded yet answers an action later instead of
  refusing it; one that cannot load says so in its state.
