# 0019. Global shortcuts have a permission-free floor and Accessibility is an opt-in tier

- **Status:** Superseded
- **Date:** 2026-06-18
- **Superseded by:** ADR-0117 (now in [Whispering's decisions](../../apps/whispering/README.md#decisions))

## Context

[ADR-0008](0008-rdev-backs-the-desktop-global-trigger.md) put an `rdev`
keyboard tap behind the desktop global trigger, and
ADR-0011 made Rust own the
macOS Accessibility grant that tap needs. That left one question unanswered:
does the whole global-shortcut feature sit behind the grant? It used to. Recording
a global shortcut and firing it both leaned on the tap, so a user who declined
Accessibility got nothing, which turns the permission prompt into a wall in front
of a core feature. Yet the common shortcut is a plain chord like Cmd+Shift+Space,
which `tauri-plugin-global-shortcut` registers through the OS with no Accessibility
at all. Demanding a grant the OS does not require for the common case is the wrong
default.

## Decision

Global shortcuts have two tiers, and the floor needs no permission. Tier-0 is a
chord: one key plus at least one non-Fn modifier. A chord registers through
`tauri-plugin-global-shortcut`, records straight from the webview's `keydown`
stream, and outputs through the clipboard. It never touches Accessibility. Tier-1
is everything only the tap can surface: Fn and modifier-only holds, push-to-talk,
auto-paste-at-cursor, and live capture of those gestures. Tier-1 is opt-in behind
the single macOS Accessibility grant. `isTierZeroChord` is the one predicate that
partitions a binding between the two backends. The tap is the only thing that
consults Accessibility; the supervisor runs it only when something wants the grant
and the process is trusted, never spawning it just to probe. The three reasons to
want the grant, a Tier-1 binding being bound, auto-paste being on, and an
in-progress capture, are one `TapIntent`; the supervisor gates on whether any
holds, never on which.

## Consequences

- The app is fully usable with zero permissions. A fresh user gets the default
  chord toggle plus clipboard output and sees no prompt. Accessibility becomes a
  strict upgrade and is sold as one: the recorder shows an "Fn and holds need
  Accessibility" note with an enable button, not a wall.
- Capture mirrors execution per tier. Tier-0 captures in the webview through
  `createWebviewChordRecorder` (physical `.code`, no grant); Tier-1 captures
  through the tap. Granting Accessibility while the recorder is open upgrades it in
  place, because capture is itself a `TapIntent` reason that spins the tap up.
- The trust oracle stays `AXIsProcessTrusted` in Rust beside the tap
  (ADR-0011), sampled by the
  bounded poll only while a Tier-1 intent is waiting on the grant. Tier-0 paths
  never consult it.
- Two capture paths now exist, the webview chord recorder and the tap. They share
  a completion policy (a 300ms quiet window, commit on release, reset on blur) but
  not a mechanism: the local recorder is a reactive `$effect` over a shared
  pressed-keys store, the webview recorder owns its own listeners. They stay
  separate adapters by choice; merging them would force one lifecycle onto the
  other to deduplicate ten lines.
- A binding that needs Fn cannot be recorded or fired until the user opts in. The
  webview recorder refuses a bare key and points Fn and modifier-only holds at the
  grant.

## Considered alternatives

- **Keep every global shortcut behind Accessibility (one backend).** Rejected: it
  gates the common case, plain chords, behind a permission the OS does not require
  for it, which is the wall this decision removes.
- **Probe `AXIsProcessTrusted` to pick the capture mode up front.** Rejected: a
  spawned-to-probe tap and a steady trust poll are exactly what ADR-0011 deleted.
  Treating capture as a `TapIntent` reason reuses the supervisor's existing gate
  instead of reintroducing a probe.
