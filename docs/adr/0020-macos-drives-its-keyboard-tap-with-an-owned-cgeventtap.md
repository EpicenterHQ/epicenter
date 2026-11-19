# 0020. macOS drives its keyboard tap with an owned CGEventTap, not the rdev fork

- **Status:** Accepted
- **Date:** 2026-06-18

## Context

ADR-0008 put `rdev::listen`
behind the desktop global trigger on every platform, and
[ADR-0011](0011-rust-owns-the-macos-dictation-capability.md) gave a background
supervisor thread ownership of the tap's lifecycle, trusting the listener's return
to mean the tap died. On macOS those two facts collide with a bug in the
rustdesk-org `rdev` fork: its `listen()` attaches the `CGEventTap` source to
`CFRunLoopGetMain()` and then runs the *calling* thread's run loop. On the
supervisor's background thread that run loop has no sources, so `CFRunLoopRun()`
returns instantly, `listen()` returns `Ok(())`, and the supervisor reads
"registered" as "the tap died." Five restarts later it publishes `Broken`. This is
the real cause of the "global shortcut stopped working" notice, it hits release
builds, and it is not a signing, TCC, or Accessibility problem. (The fork's
`grab.rs` uses `CFRunLoopGetCurrent` and is correct; only the `listen` path is
wrong, and `grab` consumes events, which we do not want.)

## Decision

On macOS the supervisor drives an owned, in-tree `CGEventTap`
(`src-tauri/src/keyboard/mac_tap.rs`) as its `listen` primitive instead of
`rdev::listen`. It adds the tap source to the current background thread's run loop
and blocks there, so `listen` is a real blocking call whose return means the tap
actually ended, which is the liveness signal ADR-0011 depends on. It re-enables a
tap that macOS silently disables under load
(`kCGEventTapDisabledByTimeout` / `…ByUserInput`), and uses the safe
`core-graphics` / `core-foundation` RAII wrappers so a restart cannot leak the mach
port or run-loop source. It emits the same normalized `(Edge, Input)` stream the
matcher already consumes, so `matcher`, `keys`, and `event` are untouched.
`rdev::listen` still backs every non-macOS desktop through `rdev_map`; exactly one
backend compiles per platform. This amends ADR-0008 for macOS only.

## Consequences

- The false `Broken` is gone by construction: `listen` blocks until the tap
  genuinely dies, so the supervisor's death signal is trustworthy again.
- macOS gains two things the rented fork never provided: recovery from a
  load-disabled tap, and leak-free restarts.
- New native surface to own: a small direct FFI for `CGEventTapEnable` /
  `CGEventTapIsEnabled` (the `core-graphics` 0.22 wrapper exposes them only as
  methods on the tap it owns), plus a `kVK_*` keycode table transcribed from
  rdev's own.
- Two keyboard backends now have to behave identically, `mac_tap` and `rdev_map`.
  The cost is justified because the rented one is broken on the platform that
  matters most, and the seam keeps the divergence to the `listen` primitive.

## Considered alternatives

- **Patch or pin a fix in the rdev fork.** Rejected: the bug is in the fork's
  `listen` run-loop attachment, the fork is effectively unmaintained, and owning
  the one primitive we need removes that bus-factor for less code than tracking a
  patched fork.
- **Run `rdev::listen` on the main thread so `CFRunLoopGetMain` matches.**
  Rejected: the supervisor owns a dedicated background thread by design
  (ADR-0011); moving the tap onto the main thread to satisfy a fork's quirk
  inverts that ownership.
