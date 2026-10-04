# Voice Cursor: intent-in-context over transcript-at-cursor

**Date**: 2026-06-28 (revised 2026-07-02 after the greenfield + comparables design pass)
**Status**: Draft
**Owner**: Braden
**Branch**: holding/old-branch-voice-cursor-intent (Phase 0 code exists uncommitted in this worktree)
**Builds on**: [ADR-0099](../../../docs/adr/0099-replace-transformations-with-a-dictionary-polish-and-a-portable-recipe-library.md) (Dictionary/Polish/Recipe), [ADR-0060](../../../docs/adr/0060-an-inference-connection-is-a-base-url-and-an-optional-bearer-key.md) (connection = base URL + optional key)

## One Sentence

A capture is an intent applied to a context, chosen by two deterministic gestures (Dictate: speech is content; Instruct: speech is about content); Phases 0-1 (the recordings v2 record with its migration, the Sink seam, result-in-history) are committed now, and Instruct itself is a go/no-go decision after Phase 1, not a promise.

## How to read this spec

```txt
Read first:        One Sentence, Settled Direction, Research Findings, Implementation Plan, Success Criteria
Read for model:    The gesture grammar, Trust boundary, The record, The Sink
Read if curious:   Relationship to ADR-0099, Rejected Alternatives, Open Questions
```

## Settled Direction (2026-07-02 design pass)

A greenfield pass re-derived the product from evidence: the current Whispering code, the uncommitted Phase 0 patch, and DeepWiki-verified feature audits of Handy and FluidVoice. The primitive survived. The one thing that did not survive is conflating the storage clean break with the product clean break: the durable format keeps compatibility (shipped users sync rows through the `epicenter-whispering` cloud room), and the clean-break budget is spent on product refusals instead.

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Storage compatibility | 1 evidence | Keep the v1 -> v2 `recordings` migration and the `epicenter-whispering` workspace id | Without migration, legacy rows do not disappear; they hide (`scan().nonconforming`, invisible in history, re-hydrated from the sync relay forever), and rows already stamped `_v:2` become `newerWriter` entries that `clear()` refuses to remove (`packages/workspace/src/document/table.ts`). An id reset orphans recipes and all synced settings too. The migration is small, written, and tested. |
| First slice | 3 taste | Commit Phases 0-1 now; Phase 2 (Instruct) gets its own go/no-go after Phase 1 is solid | Phases 0-1 are wanted under every future; the bet is decided with Phase 1 evidence in hand. Revisit when: Phase 1 ships. |
| Meeting/file transcription | 1 evidence | Imported files only, through the shared pipeline and the one `recordings` table; live system-audio capture refused | Neither Handy nor FluidVoice captures system audio; FluidVoice's "meeting transcription" is confirmed to be imported-file transcription (`MeetingTranscriptionService.transcribeFile` over `AVAsset`). Whispering's import is already solid (`operations/import.ts`). |
| Command mode | 2 coherence | Refused | FluidVoice's Command mode is a shell-executing agent (`CommandModeService`, `execute_terminal_command`): a different product with a large trust surface. Revisit when: real demand appears after Instruct ships. |
| Recipes as a noun | 3 taste | Keep Recipes as-is until Phase 2 is committed; then revisit dissolving them into Instruct presets | Deleting Recipes without the replacement verb is pure user loss. Revisit when: the Phase 2 gate returns go. |
| Keyless installs | 2 coherence | Dictate works fully (local models, raw transcript); Instruct is visibly disabled with an explanation | Handy proves keyless dictation is a complete product. A transform cannot run without a completion connection and must never be silently dark. |
| Selection capture mechanism | 1 evidence (spike to verify) | Explore Accessibility-API selection capture (`kAXSelectedText`) for Phase 2, replacing synthetic Cmd+C as the plan of record | FluidVoice's `TextSelectionService` reads the selection via AX attributes: no clipboard round-trip, no focus games. Feasibility from Tauri/Rust is the spike. |
| Audio-less Instruct rows (ledger vs `recordings`) | Deferred | Deferred to Phase 2 scoping | Only Instruct-on-clipboard produces audio-less rows, and no producer exists until Phase 2. |
| Intent classifier | 2 coherence | Refused (unchanged) | Both comparables ship deterministic gestures; the category validates the refusal. |

## Overview

Whispering and its category (FluidVoice, Handy, Wispr Flow, VoiceInk) share one primitive: a transcript whose only job is to land as text at the caret. This spec changes the primitive to an intent applied to a context. "Write down what I said" becomes the degenerate case (empty context, no instruction). The behaviours the category needs (dictate, edit a selection, generate, capture a thought) become one operation, `complete(instruction, operand + speech)`, routed by two axes that are observable from structure (is there an operand? where does output go?) plus exactly one bit that is not: is my speech content, or an instruction about content? That bit is read from which gesture the user pressed, never inferred.

## Motivation

### Current State

ADR-0099 decomposed the old fused `Transformation` into Dictionary, Polish, and Recipes, and that decomposition was correct given the cursor primitive. The engine underneath is uniform: every AI step is one `complete()` over the OpenAI wire (ADR-0060), and delivery routes through `delivery.ts`. Problems the cursor primitive creates:

1. **No edit-by-voice.** Recipes run a pre-authored instruction. There is no "select this and say what to do." The most-missed dictation-power-user verb is structurally absent.
2. **The result is half-modelled.** `recordings.polishedTranscript` is written (`pipeline.ts`) and never read; recipe output is delivered and discarded.
3. **Sink is a global setting, not a per-capture fact.** The capture does not record where its text actually went, so there is no per-capture provenance.
4. **Selection capture is the roughest surface.** Synthetic Cmd+C is lossy by construction, and the recipe palette steals focus (`recipe-picker.ts` calls `tauri.mainWindow.focus()`).

The uncommitted Phase 0 patch in this worktree already addresses 2 and 3 structurally: `recordings` v2 (`raw`/`result`/`intent`/`operand`/`sink`) with a v1 migration and test, and a `Sink` seam (`operations/sink.ts`) whose resolved kind is persisted per row.

### Desired State

Two gestures on the use/mention axis. Operand source explicit by gesture. Sink inferred structurally and recorded as a terminal fact. Every capture is a typed record in one durable table.

```txt
DICTATE  (speech is content)                 INSTRUCT (speech is about content)
+--------------------------------+           +------------------------------------------+
| selection  -> replace it       |           | selection       -> edit in place         |
| focused field -> cursor        |           | clipboard gesture -> act on clipboard    |
| no destination -> ledger only  |           | neither         -> generate (no operand) |
| (always tee to ledger)         |           | cancel = no-op, leave original untouched |
+--------------------------------+           +------------------------------------------+
```

## Research Findings (2026-07-02, DeepWiki-verified)

Feature audits of Handy (`cjpais/Handy`) and FluidVoice (`altic-dev/FluidVoice`), all items below confirmed against concrete files/symbols unless marked weak.

| Feature | Whispering | Handy | FluidVoice |
| --- | --- | --- | --- |
| Dictation | manual/VAD/PTT, 8 cloud/local/self-hosted backends | PTT/toggle, local-only engines | hold/toggle, local-first engines |
| Rewrite/edit by voice | no (pre-authored Recipes only) | no | yes: Edit hotkey branches on selection presence (rewrite vs generate) |
| Command | no | no | yes: terminal-executing agent |
| Meeting/file | file import, shared pipeline | none | file import only, separate history store; no live capture |
| Post-processing | Polish always-on + Recipes | opt-in prompt + a dedicated always-post-process hotkey | prompt slots per mode |
| Custom words | AI-injected `string[]` (ADR-0099) | deterministic fuzzy (Levenshtein + Soundex + n-gram) plus Whisper `initial_prompt` | LLM prompt slots |
| Delivery | cursor paste with clipboard fallback | paste variants, direct typing, external-script seam, clipboard restore | multi-tier insertion ladder, clipboard snapshot/restore |
| History/retention | synced table, manual deletion only | SQLite + WAV, "saved" flag exempt from cleanup, retry-transcription | UserDefaults + audio GB budget |
| Sync | Yjs local-first sync | none | JSON settings export, keys excluded |

Key findings:

- **The gesture grammar is category-validated.** FluidVoice ships deterministic hotkey modes with no classifier, and its Edit hotkey branches on selection presence exactly as this spec's Instruct does (selection -> rewrite in place, none -> generate).
- **"Meeting transcription" in this category means imported files.** Nobody captures live system audio. Whispering already has solid parallel file import; the category gap is real but out of scope by decision.
- **AX selection capture beats synthetic Cmd+C.** FluidVoice reads `kAXSelectedText` with range/value fallbacks; no clipboard round-trip. This de-risks the machinery this spec previously flagged as the residual Phase 2 engineering risk.
- **Clipboard-restore hygiene is table stakes.** Both comparables snapshot and restore the clipboard around paste delivery. Whether Whispering's cursor paste does is an open verification item (Phase 1).
- **Handy's keyless story is complete.** Local engines plus deterministic fuzzy vocabulary need no key at all; this grounds the keyless stance and keeps ADR-0099's deferred fuzzy matcher on the shelf with a concrete reference implementation.
- **Whispering's unique differentiator is local-first sync.** Neither comparable syncs anything.

## The gesture grammar

The intent of a capture is `(has instruction?) x (operand source) x (sink)`. Operand source is observable (selection present, clipboard gesture, or neither). Sink is observable (selection -> replace; focused field -> cursor; nothing -> ledger). The only ambiguous bit is use/mention ("make this shorter" vs "the numbers look strong"), and it is resolved by which gesture the user pressed. One deterministic bit of user input deletes an entire ML subsystem: no classifier, no training data, no override UX, no drift, no destructive-misfire risk. Routing works offline, preserves privacy (only execution calls the LLM), and is teachable in one sentence: Dictate types what you say; Instruct does what you say.

### Trust boundary (the two scaffolds)

The prompt structure differs by gesture because the trust model differs:

- **Dictate scaffold** = today's `buildPolishSystemPrompt`: a text filter that never executes the transcript. The whole utterance is untrusted content to be cleaned. Unchanged.
- **Instruct scaffold** = new, and it inverts the trust: the spoken instruction is trusted (system role); the operand (selection or clipboard text) is untrusted data (user role) that must not hijack the instruction. `complete()` already takes separate `systemPrompt`/`userPrompt`. Role separation is a mitigation, not a hard boundary: an operand containing "ignore the above" can still influence a weak model. The success criterion tests representative strings; it cannot prove obedience.

The Dictionary block (`buildSystemPrompt`) appends to both, unchanged.

### Cancel semantics

- **Dictate**: the existing ship-raw. Aborting the AI pass delivers the raw words (a clean success). Raw is never lost.
- **Instruct**: abort is a no-op that leaves the original untouched and delivers nothing. Shipping the raw spoken instruction would type "make this shorter" into the document, the opposite of intent.

This is a redesign of the cancel path, not a copy change: the in-flight control is hardwired to ship-raw (`pill-actions.ts` -> `polishHud.shipRaw()`), and the lifecycle has no "abort = discard" outcome (`dictation-lifecycle.svelte.ts`). Supporting two cancel meanings forks the lifecycle, the overlay projection, and the pill actions. Budget it inside the Phase 2 bet.

### Instruct's surface is the overlay, not the palette

The overlay window is deliberately `no_activate` (`src-tauri/.../overlay.rs`): focus never leaves the user's app, so `write_text` pastes into the still-focused app. A spoken Instruct over the overlay needs no app-handle capture. The palette path steals focus and would need a "capture frontmost app + reactivate by handle" Rust command that does not exist. The palette stays only for saved presets (text already in hand, no live recording), and only if the Phase 2 gate returns go.

## Architecture

### The record (recordings v2, shipped in the Phase 0 patch)

One row per utterance. Before/after on the actual columns:

```txt
v1 (committed definition.ts)             v2 (workspace/recordings.ts, uncommitted)
id, title, recordedAt,                   id, title, recordedAt,
recordedAtZone, duration,                recordedAtZone, duration,
transcript: string                       raw: string
polishedTranscript: string | null        result: string | null
transcription: TranscriptionOutcome|null transcription: unchanged
                                         intent: 'dictate' | 'instruct'
                                         operand: { kind: 'none'|'selection'|'clipboard', text: string|null }
                                         sink: { kind: 'cursor'|'clipboard'|'replace-selection'|'ledger', ref: string|null } | null
```

Semantic shifts to note: `sink` is a terminal delivery fact, never in-flight state (liveness stays derived from the mutation); legacy rows migrate with `sink: null`, not `'cursor'`, because fabricating an unobserved delivery fact would lie. The migration maps `transcript -> raw`, `polishedTranscript -> result`, and stamps `intent: 'dictate'`, `operand: { kind: 'none', text: null }`. The frozen v1 column block in `recordings.ts` must never be edited; `tests/recordings-migration.test.ts` replays real v1 Yjs updates through the v2 table and asserts zero nonconforming rows.

### The Sink (shipped in the Phase 0 patch)

```ts
interface Sink {
	kind: SinkKind;
	deliver(text: string): Promise<DeliveryReach>;
}
```

`delivery.ts` resolves exactly one sink per capture and persists the observed outcome onto the row (a cursor sink that fell back records `clipboard`). Phase 1 routes Dictate through a structural resolver; Recipes keep the existing settings-priority pick. The `vault` sink (a markdown note) is the Phase 3 seam and the entire on-ramp to a personal corpus; it is designed-for, not built.

## Implementation Plan

### Phase 0: land the record and the seam (code exists; review and commit)

- [x] **0.1** Review the uncommitted patch as one wave: `workspace/recordings.ts` (v2 + migration), `operations/sink.ts`, the `delivery.ts`/`pipeline.ts`/`transcribe.ts` rewiring, the mechanical `transcript -> raw` renames.
- [x] **0.2** Run `bun test apps/whispering/tests/recordings-migration.test.ts` and the app typecheck.
- [x] **0.3** Commit with specific staged paths (no `git add -A`), splitting the leaf-module extraction from the behavioral rewiring if the diff reads better as two commits.

### Phase 1: the result becomes visible (low-regret, committed)

- [x] **1.1** History shows `result` (the delivered text) with a one-tap "show original" reading `raw`. This gives `result` its first reader and fixes the dead-`polishedTranscript` bug.
- [x] **1.2** Route Dictate delivery through the structural resolver (focused field -> cursor; nothing -> ledger), replacing the settings-priority pick.
  > **Note**: Phase 1 has no native focused-field probe yet, so the resolver uses the existing `output.transcription.cursor` setting as the observable "write into the focused field" intent. Clipboard remains a cursor fallback and optional tee, not Dictate's primary sink.
- [x] **1.3** Verify clipboard-restore behavior after cursor paste (both comparables snapshot and restore). If absent, decide whether to add it here or defer; it is a Class 1 evidence question first.
  > **Evidence**: `src-tauri/src/lib.rs::write_text` snapshots the clipboard when `keep_on_clipboard == false`, writes the transcript as the paste transport, waits for paste consumption, then restores the snapshot. macOS uses native `NSPasteboard` save/restore from `src-tauri/src/clipboard.rs`; other desktop platforms restore the prior text clipboard. If paste cannot run or fails, the transcript intentionally stays on the clipboard as the reduced-reach fallback.

Opportunistic in Phase 1, not required: retry-transcription from a history row and a "saved/pinned" retention exemption (both Handy-validated, both cheap, both independent of the primitive).

### Phase 2 gate: the Instruct go/no-go

Decided by Braden after Phase 1 ships, with these inputs on the table:

- Phase 1 live and stable (result-in-history holding up in daily use).
- The AX selection-capture spike result (`kAXSelectedText` from Tauri/Rust: feasible or not).
- The audio-less Instruct row decision (does `recordings` tolerate audio-less rows, or is the ledger a separate store).
- The Recipes decision (dissolve into Instruct presets, or keep both nouns).

### Phase 2 (only if go): Instruct

- [ ] **2.1** Selection machinery: AX-based capture at press, paste-over-selection write-back, shared by Dictate-replace and Instruct-edit.
- [ ] **2.2** The Instruct scaffold: trusted spoken instruction (system role), untrusted operand (user role).
- [ ] **2.3** The cancel-path fork: Instruct abort discards and delivers nothing.
- [ ] **2.4** Instruct-generate (no operand) and Instruct-on-clipboard; keyless installs show Instruct visibly disabled with an explanation.
- [ ] **2.5** Slim preset picker (saved instructions); Recipes dissolve per the gate decision.

### Phase 3 (earned later): the corpus seam

- [ ] **3.1** `vault` Sink (markdown note) plus a reader over the ledger. No migration needed: the data has been accumulating since Phase 0.

### Web platform (Tauri-only gestures)

Whispering also runs on web with no Tauri (`captureSelection`/`writeToCursor` return NotSupported in the browser backend). Every selection gesture is desktop-only. On web the product degrades to Dictate -> cursor/clipboard/ledger and Instruct -> generate/clipboard only. Phase 1/2 success criteria are desktop criteria; the web degradation is explicit.

## Success Criteria

- [x] **Phase 0**: every pre-upgrade recording still appears in history (`scan().nonconforming` empty for migrated rows); new rows carry `intent`/`operand`/`sink`; Dictate's delivery outcome is persisted on the row; no visible change; typecheck and the migration test green.
- [x] **Phase 1**: history shows `result` with "show original" one tap away; Dictate delivery flows through the resolver; the clipboard-restore question is answered with evidence.
- [ ] **Phase 2 (if go)**: Instruct-on-selection edits in place under Accessibility (clipboard + notice fallback otherwise); Instruct with no operand generates; the untrusted-operand scaffold mitigates representative injection strings; Instruct cancel leaves the original untouched and delivers nothing; Dictate-with-selection replaces it; routing makes zero LLM calls and a unit test proves the same inputs always route the same way.

## Relationship to ADR-0099

This completes ADR-0099's trajectory rather than contradicting it. Its load-bearing insight ("auto-versus-manual is which layer you are in, not a flag on a shared object") is the use/mention axis: Dictate is the auto layer (Polish becomes its default cleanup); Instruct is the manual layer (Recipes become its saved presets, if the gate returns go). The Dictionary stays exactly as ADR-0099 defined it. When the Phase 2 gate resolves, harvest the settled decisions (the gesture grammar, the refusals in Settled Direction, the record shape) into an ADR that supersedes 0098's vocabulary while preserving its decisions, then delete this spec.

## Rejected Alternatives

- **Inferred intent (a language classifier with an override).** The override UX becomes the product; a perpetual ML liability to avoid spending one deterministic bit. Category evidence now backs the refusal: neither comparable infers.
- **Storage clean break (delete the v1 migration, or reset the workspace id).** Rejected 2026-07-02: shipped users sync rows through the cloud room; hidden-not-gone rows plus `newerWriter` zombies plus orphaned settings is strictly worse than forty lines of migration. The clean break is spent on product refusals instead.
- **Live system-audio/meeting capture.** Rejected for now: no comparable ships it; large per-platform bet (ScreenCaptureKit and friends). Imported files stay supported. Revisit when: file-import usage shows real meeting-transcription demand.
- **Command mode (FluidVoice's third gesture).** OS automation is a different product with a shell-shaped trust surface. Revisit when: demand appears after Instruct ships.
- **One gesture, selection carries use/mention.** Loses generate-from-empty, a real capability hole.
- **Selection-else-clipboard operand fallback.** Poisons generate: a blank-doc "draft a note" silently inherits clipboard junk. The operand source stays explicit by gesture.
- **Build the corpus (Vision B) first.** A different product; B is what Dictate/Instruct earn, sequenced after.

## Open Questions

1. **The saved-preset palette's missing Rust.** The focus-stealing palette needs a "capture frontmost app + reactivate by handle" command that does not exist. Build it, or constrain saved presets to the overlay surface too? Recommendation: decide inside Phase 2 scoping; the overlay-only constraint is the cheaper default.
2. **Bindings.** Dictate, Instruct-on-selection, and Instruct-on-clipboard are three gestures; the cross-app verbs ship globally unbound today. Keep three bindings with sane global defaults, or defer Instruct-on-clipboard? Recommendation: defer the clipboard binding until the other two prove out.
3. **Instruction cleanup.** Does the spoken instruction get its own light cleanup before use, or is the completion model trusted to absorb disfluency? Recommendation: trust the model first; add cleanup only on observed failures.
4. **Generate with no focused field.** Ledger-only, clipboard, or both? Recommendation: clipboard plus ledger tee.
5. **VAD concurrency.** An Instruct transform in flight during a live VAD session collides with the single-outcome pill (`dictation-lifecycle` is most-recent-wins). How do the two multiplex? Must be answered in Phase 2 scoping.
6. **Tee suppression.** Should Dictate's always-tee be suppressible for ephemeral captures (password-field-style privacy)? Defer until a user asks.
7. **Surfaces the plan must touch but the table glosses**: per-intent sounds (`sound.*` has only `recipeComplete`/`transcriptionComplete`) and new variants in the typed analytics event union (`transcribe.ts`).

## References

- `apps/whispering/src/lib/workspace/recordings.ts` (uncommitted): the v2 table, migration, sink/operand schemas
- `apps/whispering/tests/recordings-migration.test.ts` (uncommitted): the migration gate
- `apps/whispering/src/lib/operations/sink.ts` (uncommitted): the Sink seam
- `apps/whispering/src/lib/operations/{pipeline,delivery,transcribe,run-polish}.ts`: the rewired pipeline
- `apps/whispering/src/lib/operations/{selection,recipe-picker,recipe-clipboard}.ts`: today's selection/palette surface (Phase 2 raw material)
- `packages/workspace/src/document/{define-table,table,nullable}.ts`: version routing, `scan()` buckets, migration mechanics
- `.agents/skills/workspace-api/references/table-migrations.md`: the documented migration story
- DeepWiki audits (2026-07-02): `cjpais/Handy`, `altic-dev/FluidVoice` (facts cited inline in Research Findings)
