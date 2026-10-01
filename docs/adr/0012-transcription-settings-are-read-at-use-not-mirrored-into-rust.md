# 0012. Transcription settings are read at use, not mirrored into Rust

- **Status:** Accepted
- **Date:** 2026-06-17
- **Amended by:** [ADR-0180](0180-epicenter-has-one-host-owned-active-local-transcription-model.md) at the model-identity boundary only. The local model name is host state rather than an application-owned value carried in `TranscriptionSpec`; read-at-use delivery and the refusal to mirror config into Rust stand.
- **Amended by:** [ADR-0397](0397-native-inference-selects-an-installed-model-explicitly.md) at the same boundary, restoring it: the model name is again a per-call value read at use, alongside the language and the prompt.

## Context

Whispering's Rust backend held an authoritative copy of the active transcription
settings: the frontend pushed an ambient `TranscriptionConfig`
(`set_transcription_config`) on every change, and `ModelManager` read that copy
on each `transcribe_recording` call. The copy went stale on world changes the
push could not see, the same failure class [ADR-0011](0011-rust-owns-the-macos-dictation-capability.md)
found for the keyboard tap: a model file reappearing on disk after a failed load
read as still-missing until an app restart re-pushed the config, which is why
"restart fixes it" was the workaround (#2034). A latent variant rode along:
`unloadPolicy` was bundled into that same config, so it could not be delivered
while no model was selected.

## Decision

The frontend owns every transcription setting value; Rust owns mechanism only
(the resident model, its disk identity, the idle clock), never authority.
Delivery splits by *when the value is consumed*:

- **Consumed at use → read-at-use.** Engine, model name, language, and prompt
  travel with the operation as a per-call `TranscriptionSpec` built in
  `transcribeLocally` where it is consumed. Rust keeps only a `ModelCache`
  (resident model, disk identity, unload clock, status, lifecycle events) and
  resolves the model path at load time. There is no ambient config to go stale.
- **Consumed between uses → reconcile into the resource.** A background idle
  timer cannot be read at use, so the frontend reconciles the unload policy onto
  its own `set_unload_policy` channel (the `synchronizeUnloadPolicy` app
  effect) on every change. Rust owns the clock, because a backgrounded webview
  timer throttles exactly when idle-eviction must fire to reclaim RAM.

`ModelManager` is renamed `ModelCache` to name what it now is. `set` and `sync`
are the smell verbs: both shove a copy across a boundary and hope it stays put.

## Consequences

- "Restart fixes it" becomes structurally impossible for transcription: every
  transcribe carries its own settings, so a model that appears after a failed
  attempt just works on the next call. The ambient `set_transcription_config`
  command, the `NoConfig` error, and the `SelectionChanged` / `ConfigChanged`
  events are deleted, not fixed.
- `unloadPolicy` reaches Rust whether or not a model is selected, fixing the
  latent third bug; `ModelCache` seeds the policy to its default until the first
  reconcile lands.
- `snapshot()` reports identity from the resident engine rather than the retired
  ambient config, so a late-mounting window still sees what is loaded now.
- The convention is app-lifetime effect helpers plus per-call specs,
  deliberately not a generic config-reconciler framework: there is exactly one
  between-uses value left (the unload clock), and subtraction beats abstraction
  here.

## Considered alternatives

- **Frontend owns the eviction clock (zero native settings).** Rejected:
  backgrounded webview timers throttle exactly when idle-eviction must fire.
- **Keep the ambient config and re-push it on world changes.** Rejected: it
  re-creates the staleness this removes; the frontend cannot see every world
  change (a file reappearing on disk) that would invalidate the copy.
- **A generic reconciler framework spanning all cross-boundary settings.**
  Rejected: one between-uses value remains; a convention beats a framework.

Relates to [ADR-0011](0011-rust-owns-the-macos-dictation-capability.md), the
keyboard-tap sibling of the same principle (the frontend owns the value, the
Rust process that holds the resource owns its mechanism). The keyboard tap is
the "consumed between uses" case taken to full Rust ownership, because OS trust
and tap liveness are facts only the holding process can observe; transcription
settings are plain values the frontend owns and hands over at the point of use.
