# 0008. rdev backs the desktop global trigger

- **Status:** Superseded
- **Date:** 2026-06-13
- **Superseded by:** ADR-0117 (now in [Whispering's decisions](../../apps/whispering/README.md#decisions))

## Context

Whispering's desktop global trigger needs to fire on keys the Tauri global-shortcut
plugin cannot bind: the Fn key, modifier-only chords, and a press-and-release
push-to-talk gesture. `tauri-plugin-global-shortcut` registers discrete accelerators
and cannot express any of these.

## Decision

The desktop global trigger is backed by `rdev::listen`, not the Tauri
global-shortcut plugin. The Rust side listens to the raw key event stream and the
frontend matches gestures against it (see
ADR-0007 for the
gesture model). The `rdev` fork in use is pinned in `src-tauri/Cargo.toml`.

## Consequences

- Fn, modifier-only chords, and press-and-release push-to-talk become bindable,
  which the plugin could not support.
- Whispering takes on a raw global keyboard listener, with the accessibility-grant
  and listener-liveness handling that implies on macOS. That recovery handling is
  its own concern and is not frozen by this ADR.
- The matcher is pure state matching over the event stream, with no timing logic.

## Considered alternatives

- **Keep `tauri-plugin-global-shortcut`.** Rejected: it cannot bind Fn,
  modifier-only chords, or a press-and-release gesture, which are the whole point.
- **Hand-roll a macOS CGEventTap now.** Deferred, not chosen: the `rdev` map is the
  seam to drop to a native event tap only if the fork breaks.
