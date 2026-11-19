# 0117. Global shortcut input is plugin chords only, and the macOS tap is just the paste grant watcher

- **Status:** Accepted
- **Date:** 2026-07-09
- **Supersedes:** ADR-0008 (rdev no longer backs any trigger), ADR-0019 (the two-tier model collapses to one tier plus a paste-only grant)
- **Relates:** [ADR-0011](0011-rust-owns-the-macos-dictation-capability.md) and [ADR-0020](0020-macos-drives-its-keyboard-tap-with-an-owned-cgeventtap.md) (the macOS tap mechanics survive, re-scoped to the grant watcher), [ADR-0040](0040-a-cursor-write-that-cannot-paste-falls-back-to-the-clipboard-decided-from-the-grant.md) (the grant-decided paste is the sole reason the tap survives), [ADR-0052](0052-shortcut-reach-is-the-minimum-of-command-key-and-platform-ceilings.md) (the reach model loses its Accessibility-gated global rung), [ADR-0058](0058-push-to-talk-owns-the-recording-it-starts-keyed-by-its-id-not-a-lifecycle-layer.md) (push-to-talk becomes a chord hold)

## Context

ADR-0008 put a raw `rdev`
keyboard tap behind the desktop global trigger to bind the three gestures
`tauri-plugin-global-shortcut` cannot express: the Fn key, modifier-only chords,
and a press-and-release push-to-talk. ADR-0019
split shortcuts into a permission-free Tier-0 chord floor and an opt-in Tier-1
tap behind macOS Accessibility. [ADR-0020](0020-macos-drives-its-keyboard-tap-with-an-owned-cgeventtap.md)
then replaced rdev with an owned `CGEventTap` on macOS, leaving rdev to back only
the other desktops.

Three facts, gathered with source citations in the linked spec, undercut the
Tier-1 *input* premise:

- The tap's raw gestures are weak-to-dead off macOS. rdev's Windows and Linux
  keycode maps produce no `Function` key at all, so bare-Fn holds cannot fire
  there; `rdev::listen` is X11-only, so Wayland is unsupported and ships an
  apology notice. What remains off macOS is modifier-only holds on X11, unproven
  and behind push-to-talk, which is the only release-sensitive command and ships
  unbound.
- No Tier-1 gesture has live runtime proof on any platform. The macOS Fn path is
  a keycode-63 code path with a unit test, not an observed dictation trigger.
- The default product workflow never needed the tap for *input*. The shipped
  toggle and cancel are Tier-0 chords, and the plugin delivers both key edges
  (`ShortcutEvent.state` is `Pressed | Released`), so hold-to-talk works as a
  chord hold with no tap.

Meanwhile the macOS tap earns its keep for an unrelated reason: it is the only
reliable `Broken`-vs-`Active` oracle for auto-paste-at-cursor.
[ADR-0040](0040-a-cursor-write-that-cannot-paste-falls-back-to-the-clipboard-decided-from-the-grant.md)
established that a stale post-update Accessibility grant reads as trusted through
`AXIsProcessTrusted` yet silently drops the synthetic ⌘V, so paste correctness
cannot be decided from a bare trust probe; it is decided from the supervisor's
capability, which learns `Broken` only by watching a live tap die under a still-
trusted grant. So the tap has two jobs, input and paste-liveness, and only the
second is load-bearing.

## Decision

Global shortcut **input** is `tauri-plugin-global-shortcut` chords on **every**
platform. Whispering owns no raw global keyboard listener for input. The Fn key,
modifier-only holds, and raw press-and-release gestures are refused as a product
surface. Push-to-talk is a chord hold, driven by the plugin's `Pressed`/`Released`
edges.

The `rdev` dependency and its non-macOS listener are deleted. The macOS
`CGEventTap` survives, but **only** as the Accessibility-grant watcher that
produces the `Broken`-aware `DictationCapability` gating auto-paste-at-cursor. It
is not a shortcut backend: it registers no bindings, emits no trigger or capture
events, and runs solely while auto-paste (cursor output) is enabled.

Concretely: the shortcut tier partition never resolves a binding to the tap; the
recorder only records chords; `TapController` keeps `capability()` and
`set_auto_paste_enabled` and loses `set_bindings` / `set_capturing`; the matcher,
the trigger/capture events, and the tap's gesture-decode surface are deleted. The
`write_text` gate on `capability() == Active` and its emergency-clipboard fallback
are unchanged.

## Consequences

- One code path owns global-shortcut input on all platforms. A new caller finds a
  single backend (the plugin) and no tier branch to reason about, and no
  Accessibility grant is ever required to *fire a shortcut*.
- The unmaintained rustdesk `rdev` fork leaves the tree entirely, with its
  bus-factor, its X11/Wayland session handling, and the "global shortcut stopped
  working" support class it created.
- macOS keeps auto-paste-at-cursor with its stale-grant correctness intact,
  because the tap is retained for exactly that. The `Broken` → `LeftOnClipboard`
  behavior of [ADR-0040](0040-a-cursor-write-that-cannot-paste-falls-back-to-the-clipboard-decided-from-the-grant.md)
  is the invariant the split must preserve, and is the acceptance gate for the
  work.
- Users lose the ability to bind a bare Fn key or a modifier-only hold as a global
  gesture. The workflow they had, hold to talk, survives as a chord hold; the loss
  is the specific "hold the native dictation key" affordance, which was never a
  shipped default and had no live proof.
- The macOS Accessibility surface narrows from "fire your global shortcut and
  paste at your cursor" to "paste at your cursor." The recorder's "Fn and holds
  need Accessibility" upgrade prompt becomes an honest refusal, and the Wayland
  "needs an X11 session" shortcut apology is deleted.
- The macOS tap keeps the mechanics of [ADR-0011](0011-rust-owns-the-macos-dictation-capability.md)
  and [ADR-0020](0020-macos-drives-its-keyboard-tap-with-an-owned-cgeventtap.md)
  (Rust-owned lifecycle, owned `CGEventTap`, load-disable recovery, leak-free
  restart); only its justification changes.

## Considered alternatives

- **Keep Tier-1 as an opt-in advanced surface (status quo).** Rejected: it owns a
  raw global keyboard listener and an unmaintained fork to serve gestures that are
  dead off macOS and unproven on it, for a promise ("hold the native dictation
  key") the product does not commit to. The complexity is real; the capability is
  not.
- **Delete Tier-1 input on non-macOS only, keep the macOS Fn/hold input.**
  Deferred, not chosen: it keeps the matcher, the recorder's tap path, and the
  trigger/capture surface alive on macOS for an unproven gesture. If "hold Fn like
  the native dictation key" is ever made a core promise, reopen with a live proof
  and a macOS-only ADR; until then the surface is refused everywhere.
- **Delete the macOS tap too and gate paste on a bare `AXIsProcessTrusted`.**
  Rejected: it reintroduces the silent-transcript-loss bug
  [ADR-0040](0040-a-cursor-write-that-cannot-paste-falls-back-to-the-clipboard-decided-from-the-grant.md)
  fixed, because a stale grant reads as trusted. The tap is the cheapest reliable
  `Broken` detector.
- **Refuse auto-paste-at-cursor entirely and ship clipboard-only output.**
  Rejected: it would collapse the entire macOS tap subsystem and every
  Accessibility surface, the largest deletion available, but "the transcript
  appears where your cursor is" is a signature Whispering promise, and macOS grants
  go stale on every update, so the `Broken`-aware paste is load-bearing.
