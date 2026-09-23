# Capture implementation plan

**Date**: 2026-09-23
**Status**: In Progress
**Owner**: Braden for product decisions; implementation agent for delivery and evidence

## One sentence

Capture opens one account-backed timeline of editable, timestamped entries whose children open with the same interaction at every depth.

## Current slice

Build the inert `so.epicenter.capture` definition and shared entry operations in `packages/capture`, then a signed-in web app. The definition has one `entries` table. Each row has a minted ID, nullable `parentId`, immutable `capturedAt`, and a collaborative plain-text body. The timeline shows roots newest first; an entry view shows its body and immediate children. There is no title, recording pointer, child-ID array, or processed flag.

An entry typed in Capture uses its creation time. The first slice ends when direct typing, reload, three nested levels, ordering, and synchronization between two browser replicas have been verified with disposable data. It does not implement moving, deletion, Markdown handoff, or Whispering promotion.

The current checkout contains unrelated dirty work. The [older baseline manifest](20260923T113039-capture-implementation.baseline.json) is an audit record from 2026-09-23, not proof of the current state or a backup. A fresh status, diff inventory, and focused test/typecheck baseline precede edits. Current store and account APIs, not examples from the former draft, determine calls.

## Product decisions for later waves

The Proposed ADRs hold the decisions and their rationale:

- [0432](../docs/adr/0432-captures-form-a-timeline-of-recursively-openable-entries.md), [0433](../docs/adr/0433-capture-opens-one-account-backed-inbox.md), and [0434](../docs/adr/0434-capture-resolves-parent-links-into-one-visible-forest.md) define the account-backed entries and visible forest.
- [0435](../docs/adr/0435-capture-hands-markdown-out-as-an-explicit-snapshot.md) defines the explicit Markdown snapshot after the person selects a subtree.
- [0425](../docs/adr/0425-a-transcript-is-separate-from-its-latest-attempt.md), [0439](../docs/adr/0439-whispering-promotes-text-to-capture-instead-of-copying-recordings.md), [0440](../docs/adr/0440-whispering-cleans-transcriptions-and-does-not-own-general-text-actions.md), and [0441](../docs/adr/0441-whispering-keeps-speech-evidence-local-and-syncs-only-its-speech-profile.md) describe Whispering's later Local result cutover and Capture promotion.

Future Add to Capture copies exactly the selected Original or Cleaned text. It fixes the recording's `recordedAt` as the new entry's `capturedAt`, creates a top-level entry, and carries no audio or required source link. It does not offer a parent choice. This action replaces the Personal recording-copy path; the current checkout has already deleted that path's former components, operation, and route. Do not restore them to follow the older draft. Whispering Local audio and transcription history remain separate from its Personal speech profile, `so.epicenter.whispering.speech`.

## Ordered work

1. Implement and verify the Capture store contract, then run an independent adversarial review before expanding the UI.
2. Build the signed-in web app and recursive entry view. Bind one opened Personal store to one captured Account. Show acquisition failures and already-open ownership failures; never substitute an empty inbox. Apply text changes to the current row body incrementally so concurrent keystrokes remain collaborative.
3. Verify persistence and two-browser synchronization with disposable entries. Review ownership, lifecycle, and unnecessary machinery cumulatively.
4. Next wave: move and deletion rules, then Markdown handoff, then Whispering's Local result cutover and exact-text promotion. Those waves need their own verification. Do not mark the Proposed ADRs Accepted merely because this slice works.
