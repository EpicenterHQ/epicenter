# Capture two-table cutover plan

**Date**: 2026-09-23
**Status**: In Progress
**Owner**: Braden for product decisions; implementation agent for delivery and evidence

## Outcome

Capture opens one signed-in Personal store, `so.epicenter.capture`. Its root timeline lists dated captures newest first. A capture holds editable text and an ordered, one-level list of independently editable thoughts. Thoughts can move between captures and reorder within one; they do not own children or show individual timestamps. An unavailable capture never makes a surviving thought disappear.

The product decisions are in Proposed [ADR-0432](../docs/adr/0432-captures-hold-ordered-thoughts-beneath-a-dated-timeline.md), [ADR-0433](../docs/adr/0433-capture-opens-one-account-backed-inbox.md), [ADR-0434](../docs/adr/0434-capture-keeps-unavailable-thoughts-visible.md), and [ADR-0435](../docs/adr/0435-capture-hands-markdown-out-as-an-explicit-snapshot.md). [ADR-0439](../docs/adr/0439-whispering-promotes-text-to-capture-instead-of-copying-recordings.md) and [ADR-0441](../docs/adr/0441-whispering-keeps-speech-evidence-local-and-syncs-only-its-speech-profile.md) describe Whispering's later promotion and store split.

## Current implementation

Commits `1e8b92d099` and `4fad9f4138` built the interim recursive app. The current checkout replaces its product surface with dated `captures` and one-level `thoughts`. It preserves account-bound acquisition, collaborative plain-text bodies, local persistence, thought identity across moves, and exact-ID confirmed deletion. The web UI has a root timeline, selected capture text, ordered thoughts, and recovery for thoughts whose capture is unavailable. The browser smoke exercises two signed-in replicas, multiline text, reload, moves, conflicting offline reorders, deletion preview refresh, and an unseen offline thought surviving deletion.

The old `entries` table stays declared and appears in a read-only **Earlier entries** area with full text and a copy action. The checkout offered no evidence that every opened account replica is disposable. An independent adversarial checkpoint found that an automatic importer based on surviving destination rows can resurrect deleted writing and duplicate conversions across offline replicas. The chosen recovery path keeps source rows intact and lets a person copy wanted material into new captures or thoughts. It leaves manual reconstruction work for anyone with retained recursive data. Actual non-disposable account data could not be inspected from this checkout.

The [older baseline manifest](20260923T113039-capture-implementation.baseline.json) records an earlier checkout only. This wave recorded fresh git status, a diff inventory, and a focused baseline before editing. Unrelated dirty work was left alone.

## This wave's boundary

The two-table cutover and web UI are implemented in the checkout. Ordering uses Move up and Move down controls instead of drag interaction; both change persisted positions. The old `entries` declaration remains solely for read-only recovery. There is no recursive navigation, move, or deletion path in the current product.

## Later waves

First, add explicit Markdown preview and copy or download for one capture and its thoughts in chosen order. Use one reviewed snapshot, preserve all text, and leave deletion separate. A single readable format is enough for the first handoff; templates and regex extraction remain product questions.

Then cut Whispering over to Local result ownership and add **Add to Capture** for the exact selected Original or Cleaned text, using the recording's `recordedAt` for the root capture. Copy no audio or required source link. The Personal recording-copy path is being retired separately; do not restore it to follow the older plan. Keep Whispering Local audio and transcription history separate from its Personal speech profile, `so.epicenter.whispering.speech`.
