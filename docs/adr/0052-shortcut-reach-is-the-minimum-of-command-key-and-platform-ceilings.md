# 0052. Shortcut reach is the minimum of command, key, and platform ceilings, never a user toggle

- **Status:** Accepted
- **Date:** 2026-06-20

## Context

[ADR-0028](0028-both-shortcut-tiers-share-one-physical-keybinding-model.md) unified the runtime representation of both shortcut tiers onto one physical `KeyBinding`, and ADR-0019 split execution into a permission-free chord floor and an opt-in hold tier. The representation is now one, but the model around it still asks four separate questions for one fact: scope (focused or system), tier (chord or hold), backend (in-app keydown or native tap), and storage home. Each is really re-reading the physical shape of the keystroke, and the settings UI surfaces the worst of them, a "system vs in-app" scope toggle, as a choice the user already made when they picked the key. A bare letter cannot be system-wide; a chord can; a hold can but needs Accessibility. The keystroke already decides reach, so the user should not be asked.

## Decision

A shortcut's reach is computed, not chosen. Each command declares one intrinsic ceiling, `reach: 'focused' | 'global'` (required; `focused` is the conservative choice for a new command), in the catalog; it is the only reach fact a human states, and a programmer states it once. The realized reach of a binding is the minimum of three independent ceilings:

```
realizedReach = min(
  command.reach,        // intrinsic: meaningful outside the app? (default focused)
  keyCapability,        // bare -> focused; chord -> global; hold -> global + Accessibility
  platformCapability,   // web -> focused; desktop -> global
)
```

The most restrictive ceiling wins, so reach can only ever clamp down: a bare key cannot be made global, and a focused command cannot be hijacked system-wide by a capable chord. The realized reach is surfaced as a read-only badge ("Works in Whispering" / "Works everywhere" / "Works everywhere, needs Accessibility"), never as a scope toggle. The user expresses intent only by choosing a key. Storage routes by realized reach into the two existing stores from [ADR-0007](0007-local-shortcuts-sync-global-shortcuts-stay-per-device.md): focused bindings to synced workspace KV (they roam), global bindings to per-device device-config (they collide per machine). The user never names a map. The catalog is the dispatch spine: every input source (native tap, webview keydown, button, later the palette) runs a command by id.

## Consequences

- The focused/system scope choice is deleted from the UI. The settings page becomes one flat list with a per-row reach badge, no scope tabs and no `tauri` branch.
- Desktop gains in-app (focused) shortcuts, which it had no way to express before. The `#platform/shortcuts` pick-one seam splits into a universal focused module plus a Tauri-only system seam, composed by a reach-router; the webview matcher already runs in the Tauri window, so this is wiring, not a new backend.
- Reach is a ceiling, so user preference can only clamp down through key choice. The model deliberately ships no lever to confine a global-capable key to the focused window; adding one would reintroduce a smaller scope toggle. It returns later as an explicit per-binding clamp only if real usage demands it.
- Default bindings stay in their two homes, not one literal: focused defaults in the synced workspace schema (platform-free, because a synced default must be the same on every machine), global defaults per-device (platform-dependent). Merging them into one "platform-computed" literal was considered and refused: it would push platform identity into the synced schema to serve the half that must never depend on it, and the two stores hold different values, so there is nothing to single-source. Because the focused and global defaults are different keys, a command can carry both at once with no double-fire. The same gesture bound across the two stores would still double-fire in the focused desktop window, where both backends run at once; the reach router's `findConflict` refuses that by checking a candidate against the other store too, not only the one it routes into (a per-store check alone cannot see across the split).
- `reach` now names two axes in this app: shortcut reach (how far a keystroke fires) and `DeliveryReach` ([ADR-0039](0039-dictation-feedback-is-a-projection-of-one-lifecycle-state.md), how far a finished transcript got toward its output). Every use of the shortcut sense must stay qualified by context, or the codebase becomes harder to talk about.

## Considered alternatives

- **A user-facing "system vs focused" scope toggle.** The status quo this record removes. The key shape already decides reach; a live badge teaches it without a choice.
- **`allowedScopes: Scope[]` per command.** Subsumed by one ordered `reach` ceiling. Reach is a `min`, not a set-membership test, and the ordered bit is what stops a chord from escaping a focused command's nature.
- **One keybinding map.** A roamed-in focused binding clobbers a per-device global default. The two stores are earned by the differing sync semantics of [ADR-0007](0007-local-shortcuts-sync-global-shortcuts-stay-per-device.md).
- **An explicit downgrade lever (keep a capable key in-app only).** Deferred. It is additive under the `min` model and not an asymmetric win for v1; if you do not want a key global, do not bind a chord.
- **Roaming global bindings with a collision notice.** Deferred. [ADR-0007](0007-local-shortcuts-sync-global-shortcuts-stay-per-device.md) keeps global bindings per-device; roaming adds collision machinery rather than deleting any.
