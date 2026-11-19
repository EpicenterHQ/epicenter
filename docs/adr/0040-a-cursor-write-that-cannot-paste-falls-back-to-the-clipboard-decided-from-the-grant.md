# 0040. A cursor write that cannot paste falls back to the clipboard, decided from the grant

- **Status:** Accepted
- **Date:** 2026-06-19
- **Amends:** [ADR-0039](0039-dictation-feedback-is-a-projection-of-one-lifecycle-state.md) (collapses the delivery reach from three rungs to two)

## Context

[ADR-0039](0039-dictation-feedback-is-a-projection-of-one-lifecycle-state.md)
modeled delivery as a *reach* with three rungs: `output` (landed where
configured), `clipboard` (a cursor write fell back to the clipboard), and
`history` (a requested channel errored and nothing landed at the cursor or
clipboard, so the transcript survives only in its recordings row).

The reach was inferred by **observing the cursor write's result**. But a cursor
write is a synthetic ⌘V, which on macOS requires the Accessibility grant
(ADR-0019,
[ADR-0011](0011-rust-owns-the-macos-dictation-capability.md)). When the grant is
absent the keystroke **silently no-ops**: the OS delivers no event, but the
synthetic-input call still reports success. The clipboard sandwich
(save → write → ⌘V → restore) then restores the user's original clipboard,
*wiping the transcript that never pasted*. Net result on the dominant failure: the
frontend saw success, reported a clean `output`, and flashed a green "Delivered"
that was a lie — the text reached neither the cursor nor the clipboard, only
history.

Symmetrically, a user who turned the clipboard off and relied on paste hit the
`history` rung on a denied grant: the transcript stranded somewhere they would not
look.

Both failures trace to one root: deciding the reach by **observing a keystroke
whose failure the OS does not report.**

## Decision

Decide whether a cursor write can land from the **Accessibility grant, before the
keystroke**, never from its result.

- `write_text` (Rust) checks `is_trusted()` — the same `AXIsProcessTrusted` probe
  the keyboard tap reads — and returns *where the text landed*: `Pasted` (the
  sandwich restored the user's clipboard) or `LeftOnClipboard` (it could not
  paste, so the transcript was left on the clipboard as the fallback). A
  trusted-but-failed paste also returns `LeftOnClipboard`: the transcript is
  already on the clipboard, and we do not restore it away.
- **A cursor write that cannot paste always leaves the transcript on the
  clipboard.** There is no `history`-only reach anymore: the text is never
  stranded somewhere the user would not look. `DeliveryReach` collapses to
  `output | clipboard`.
- **Emergency clipboard.** Even when the user turned the clipboard *off*, a cursor
  write that cannot paste still leaves the transcript on the clipboard. Losing the
  words is worse than a one-time clipboard write the user can clear. The clipboard
  toggle still governs the normal path; this override applies only when a
  requested paste is impossible.
- The transcript is independently saved to history regardless, so a reduced reach
  stays a recoverable success, never data loss — ADR-0039's reach-not-failure rule
  holds, now over two rungs instead of three.

## Consequences

- The silent green-"Delivered" lie is structurally impossible: `output` is never
  claimed without a granted paste.
- The `history`-only reach, `DeliveryOutcome`'s error-carrying variant, and the
  `copyError`/`writeError`/`copied`/`written` bookkeeping in `deliverResult` are
  deleted. The reach is two states, and `markDictationDelivery`'s history-logging
  branch collapses into a one-line `markDelivered`.
- Correctness no longer depends on observing the keystroke, so it cannot be
  invalidated by `enigo`'s silent-no-op behavior on a denied grant. The manual
  smoke (paste with Accessibility revoked) becomes polish, not the gate.
- Web reports `LeftOnClipboard` (the text is on the clipboard) rather than an
  error, so the two platforms agree on the reach vocabulary.
- A latent stuck-modifier bug is fixed: the paste sequence issues every
  press/release even on a mid-sequence error, so ⌘ is never left held down.
- Cost: the emergency clipboard write can overwrite a clipboard-off user's
  clipboard in the rare untrusted-paste case. Accepted — not losing the transcript
  dominates a clipboard the user can refill.

## Considered alternatives

- **Observe the keystroke and restore conditionally (a failure-aware sandwich).**
  Rejected: on macOS the dominant failure (untrusted) is *unobservable* — the
  synthetic ⌘V reports success — so the signal the design hangs on is unreliable.
  Deciding from the grant sidesteps the observation entirely.
- **Make the clipboard an always-on floor (every dictation copies).** Rejected: it
  clobbers the user's clipboard on every *successful* dictation to fix a
  failure-only case. The grant-gated fallback fixes the failure without the
  per-dictation cost, and the sandwich restores the clipboard on the happy path.
- **Keep the `history`-only reach.** Rejected: it exists only when a paste-on /
  clipboard-off user cannot paste, and the emergency clipboard serves that case
  better — the text is one ⌘V away instead of stranded in a row.
- **Type the transcript character-by-character (no clipboard at all).** Rejected:
  slower than a paste, and it still issues synthetic input that needs the same
  Accessibility grant, so it does not escape the gate.
