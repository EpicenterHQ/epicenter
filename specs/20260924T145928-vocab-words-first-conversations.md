# Words-first Vocab conversations

- **Date:** 2026-09-24
- **Status:** In Progress
- **Owner:** Vocab

## One Sentence

Vocab lets learners collect English expressions in Words, start tutor-led device-local chats from a few saved entries, and update those entries themselves.

## Current State

`apps/vocab/src/lib/data.ts` declares two stores. Local `chatHistoryDefinition` has only `messages`; Personal `vocabDefinition` has `entries` with exact text, a learner note, and one of four learner-reported stages. `listChats()` in `src/lib/chat/messages.ts` derives a chat and its title from the first sent learner question. `VocabShell.svelte` opens the latest chat or an empty ID. `ConversationView.svelte` shows Chat, selection saving, dictation, model selection, and a separate Suggest entries completion request. `VocabSidebar.svelte` combines chat history with `EntriesPanel.svelte`, where each entry's note and stage are edited in a narrow row.

At task start, the agent loop could generate an assistant turn from empty history through `createConversation().retry()`. Vocab's former `createVocabChat().retry()` and retry UI required a last user message, so they do not yet support a recoverable tutor-first opening.

Task-start checks on 2026-09-24: Vocab typecheck reported 0 errors and 0 warnings; `bun test apps/vocab/src/lib` passed 28 tests. Vocab implementation now has durable chat focus, Words and Chat, shared import review, and selection-only capture. The first independent review identified recovery and microphone-lifetime defects; those were repaired. Browser interaction remains unverified because the available computer-use service exposes no browser tab or usable native browser window.

## Target Shape

The accepted rules are [ADR-0448](../docs/adr/0448-vocab-stages-are-four-learner-reported-abilities.md), [ADR-0452](../docs/adr/0452-vocab-chats-persist-chosen-expressions-before-the-tutor-speaks.md), [ADR-0453](../docs/adr/0453-vocab-batch-additions-share-one-review.md), and [ADR-0454](../docs/adr/0454-vocab-saves-expressions-from-chat-by-selection.md). This spec tracks execution; those records own the decisions.

```text
Local chatHistoryDefinition                one device, account-keyed rows
  chats                                    one row per chosen focus
  messages                                 many finished rows per chat

Personal vocabDefinition                   learner's account
  entries                                  exact text, note, stage, createdAt

Words -> choose 1-3 saved entries -> persist chat focus -> tutor opens
Chat  -> select text to save      -> one Personal entry
Words -> paste or starter list    -> shared review -> confirm entries
```

On desktop, Words is the full list and editor. Chat has history on the left, conversation in the center, and focus words with optional stage controls on the right. On narrow screens, Words and Chat each take the available width; history and focus stay reachable without squeezing the conversation. Moving between Words and the selected Chat keeps its draft and stream. Switching chats ends the former chat's transient work. The microphone stops when Chat is hidden.

| State | Learner sees |
| --- | --- |
| No entries | Add an expression, paste lines, or browse starter lists. No empty chat is created. |
| Chat opening | The chosen focus stays visible while the tutor starts. The start action runs once. |
| Opening or answer failed | Saved chat and submitted learner text remain available for an explicit retry. No partial assistant answer is saved. |
| Model unavailable | Words and history remain usable. Chat explains that a model must be selected; generation controls are disabled. |
| Import review | Eligible expressions selected by default, with repeated and already-saved counts; the learner can unselect items before confirming. |

## Implementation Plan

### Phase 1: durable focus and tutor-first turns

- [x] Capture a task baseline before editing. The checkout is already dirty with unrelated work; inspect `git status` and the Vocab diff, and avoid staging or resetting other files.
- [x] Add the Local `chats` table to `chatHistoryDefinition`. A row belongs to one account and stores creation time plus one to three immutable `{ entryId, text }` focus items. Its row ID is the `conversationId` already used by message rows. Keep notes and stages in Personal `entries` only.
- [x] Change chat listing and titles to read Local chat rows, filter by `accountKey`, and derive recency from the latest message or chat creation time. Preserve the ability to reopen earlier device-local explanations. Resolve the legacy message-only chat question below before replacing the old listing path.
- [x] Make Start conversation persist the chat row before the first model request. Use the existing agent generation path for the tutor opening. An empty transcript must be retryable, but mounting or reopening an unanswered chat must never generate by itself.
- [x] Keep the selected chat as the sole live agent loop. Confirm failure, stop, refresh, account switch, and chat switch against the current submitted-message and partial-answer guarantees.
- [x] Focused tests: account separation; a chat listed before its first answer; stable focus after entry deletion; retry after an interrupted tutor opening; no repeat generation on remount. Update `data.test.ts` and `messages.test.ts` as their current assertions become obsolete.
- [x] Run an independent adversarial checkpoint on the cumulative data and lifecycle change before building the new UI. Test whether the chat row owns only intent and whether recovery or account filtering has moved into callers.

### Phase 2: Words and Chat surfaces

- [x] Make Words the initial view. Give it search, stage filtering, direct addition, a roomy learner note editor, and the same four labeled stage buttons used in Chat. Starting a chat requires an explicit focus selection or a visible suggested selection the learner accepts.
- [x] Put saved chats beside the desktop conversation; put the selected focus in a small right panel. Read each current entry by stored ID for the stage control. If it is gone, display the original focus text without a control. Do not relink by text or edit notes in Chat.
- [x] Provide full-width Words and Chat views on narrow screens. Returning to Words preserves the selected chat's draft and stream; close dictation and cancel speech not yet inserted into the draft. Changing to another chat disposes the old loop.
- [x] Handle empty, loading, failed-answer, unavailable-model, and filter-empty states with shared `@epicenter/ui` primitives. Verify keyboard focus, touch targets, and four-button stage choice without relying on hover text.

### Phase 3: entry capture and batch import

- [x] Remove Suggest entries from `ConversationView.svelte` and retire its separate completion request, candidate parser, tray, and tests after confirming no other caller needs them. Keep selecting text in a settled tutor answer as the chat save action. One selection saves one exact expression.
- [x] Give multiline paste and built-in starter lists the same in-memory review. Split paste on newlines; trim outer whitespace; skip blanks, repeated exact text, and already-saved text. Do not parse numbered lines or glosses into different text.
- [x] Show eligible items selected by default and counts for skipped items. Confirm through the existing entry writer so a save made during review is checked again. New rows start with empty notes and New stages. Do not store import provenance, installed-list state, or a deck.
- [x] Choose and verify the initial starter-list text before shipping that entrypoint. The accepted design names the workflow, not a specific GRE corpus.

### Phase 4: prove and retire

- [ ] Exercise the complete flow in a browser at desktop and narrow widths: empty Words, add and import, tutor-first conversation, chat selection save, optional stage change, return to Words during a stream, reopen an old explanation, and retry failures.
- [x] Run an independent adversarial review of the cumulative implementation and remove superseded paths it identifies. Recheck the accepted learner flow after resolving findings.
- [x] Update `apps/vocab/README.md` to describe the implemented UI and storage. Remove stale first-question-title, sidebar-editor, and Suggest entries claims from active documentation.
- [ ] Delete this spec when browser verification completes; keep the ADRs as the durable decision record.

## Open Questions

1. **Existing message-only chats.** The current Local store can contain histories with no `chats` row. Before a clean break, establish whether existing learner data must survive this change. If it does, preserve those histories with a bounded migration or legacy reader and state its retirement condition. Do not silently hide them from the chat list.
2. **Starter-list content.** The learner chose a built-in-list entrypoint but not a specific list or source. Start with a small, reviewed list whose text and right to distribute are clear. A GRE-sized corpus can use the same review once its content is chosen.

## Verification

- [x] `bun run --cwd apps/vocab typecheck`
- [x] `bun test apps/vocab/src/lib`
- [ ] `bun dev:vocab` from the repository root, then desktop and narrow-screen browser checks of the states above.
- [x] Search active Vocab code and docs for `Suggest entries`, `parseEntryCandidates`, and first-question-only chat title assumptions. Retire stale paths rather than retaining a second behavior.
- [x] `bun scripts/check-doc-hygiene.ts` reports no issues introduced by this work. The checkout already reports unrelated issues; compare against a captured task baseline.

Done means a learner can add or import expressions, begin and reopen tutor-led chats from selected words on the same device, edit their own notes and stages, and recover a failed first answer. No automatic stage change, chat definition quiz, or AI entry-suggestion path remains.

## Verification note

The cumulative review found a provider compatibility issue in the tutor opening: an empty agent transcript produced a system-only model request. A transient user instruction now supplies required conversation content to the provider without writing a learner message. Focused tests cover the wire-facing request shape, stopped opening recovery, and no generation on remount. The local app returns HTTP 200 and its production build passes. Interactive browser verification remains open: the computer-use service exposed no browser tab and could not bind a native browser window in this session.
