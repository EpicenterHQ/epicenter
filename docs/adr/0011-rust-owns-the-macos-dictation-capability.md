# 0011. Rust owns the macOS dictation capability

- **Status:** Accepted
- **Date:** 2026-06-16

## Context

ADR-0008 put a raw `rdev`
keyboard tap behind the desktop global trigger and left "the accessibility-grant
and listener-liveness handling that implies on macOS" as a deferred concern. The
frontend grew into that gap: a tri-state permission probe (calling
`AXIsProcessTrusted` through a plugin), a six-state listener supervisor that
inferred liveness and restarted dead taps, and a window-focus/blur grant poll.
Two facts the system designs around make that placement wrong. `rdev::listen`
gives a thread-death signal but no positive "alive" signal, and macOS fires no
event when Accessibility flips, so the frontend was reduced to guessing both. It
also could not tell a working grant from a stale post-update one, because
`AXIsProcessTrusted` reports a stale grant as trusted, so a broken tap surfaced
as a generic "restart the app" message, the one remediation that does not fix it.

## Decision

OS trust is a fact about the process that holds the keyboard tap, so the Rust
process that holds the tap owns it. A supervisor in `src-tauri/src/keyboard`
owns the tap's whole lifecycle: it gates spawning on the live `AXIsProcessTrusted`
check, restarts a tap that dies under a held grant with capped backoff, and
publishes one `DictationCapability` (`unknown`, `unsupported`, `untrusted`,
`active`, `broken`) over `DictationCapabilityEvent`. The frontend seeds the value
from `get_dictation_capability` and renders it; it does not probe the OS, infer
liveness, or poll for grant changes. There is no frontend `start`: the tap is
running whenever the capability is `active`.

## Consequences

- `broken` (a stale post-update grant) is distinguishable from `active` by
  construction, because the supervisor sees the tap die under a still-trusted
  grant. The home notice routes a stale grant to the remove-and-re-add guide
  instead of the wrong "toggle on" or "restart" advice.
- The one unavoidable poll (macOS has no grant-flip event) lives in Rust beside
  the tap and runs only while the capability is not `active`, never as a
  steady-state timer in the webview.
- The frontend permission state machine, the listener supervisor, and the
  focus/blur grant poll are deleted; `permissions.svelte.ts` and
  `global-listener.svelte.ts` are gone, replaced by a thin
  `dictation-capability.svelte.ts` view.
- Rust now depends on `accessibility-sys` for `AXIsProcessTrusted`. The trust
  check lives next to the tap it gates rather than in a frontend plugin call.
- A long-lived supervisor thread runs for the app's lifetime. It blocks on the
  tap-death channel while `active`, so it is idle except during recovery.

## Considered alternatives

- **Keep the trust probe in the frontend, add a `broken` state there.** Rejected:
  the frontend cannot detect `broken` (the OS reports a stale grant as trusted),
  so the fix without moving ownership is a patch, not the cure.
- **Model Accessibility as a Tauri capability.** Rejected: capabilities are
  static compile-time ACLs; this is runtime OS state that flips while the app runs.
- **Always start the tap and trust it to die when untrusted.** Rejected: an
  untrusted `rdev::listen` silently drops events and looks alive, so liveness
  alone cannot stand in for the grant.
