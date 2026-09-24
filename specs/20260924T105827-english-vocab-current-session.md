# English Vocab with one current session

- **Date:** 2026-09-24
- **Status:** Draft
- **Owner:** Braden for product decisions; implementation agent for delivery and evidence

## One sentence

Vocab helps a learner understand and use English expressions through one locally resumable tutor exchange per account on each device and a Personal list of self-rated entries.

## Read this first

The current app has a multilingual prompt, automatic script readings, three entry stages, a Practice button that opens another chat, and an archive of device-local conversations. The target has an English tutor, no automatic readings, four learner-reported stages, one current local exchange, and the same Personal entry collection. The old Practice action is removed; a separate temporary practice activity will be designed later. The change is done when a learner can ask, follow up, save, rate an entry, refresh, switch account, and open another device with the storage guarantees below, and the superseded package surfaces have no production callers.

The durable decisions are [ADR-0444](../docs/adr/0444-vocab-stores-finished-session-messages-as-local-rows.md), [ADR-0445](../docs/adr/0445-vocab-keeps-one-current-session-on-device-and-syncs-saved-entries.md), [ADR-0446](../docs/adr/0446-vocab-teaches-english-without-automatic-pronunciation-readings.md), and [ADR-0448](../docs/adr/0448-vocab-stages-are-four-learner-reported-abilities.md). This file plans the change; the implementation and README will eventually replace it as the description of current behavior.

## Learner flow

1. Ask what an English expression means. The answer streams on the page. The question is already saved locally; the answer is saved locally after a clean finish.
2. Ask a follow-up. The tutor receives the current exchange as context.
3. Save a chosen expression. Its text, learner-owned note, and stage belong to Personal; the answer itself is not copied into the entry. The entry starts at New. The learner can later choose Recognize, Understand, or Use, or move backward.
4. Refresh. Finished turns return on this device. A saved question without a finished answer has a visible retry action. The unsent draft and partial answer may be lost.
5. Start a new tutor exchange when the current one is no longer needed. Vocab makes the reset clear, stops the old run, and replaces only this account's local messages. Stage ratings remain unchanged.
6. Switch accounts on the same device. Each account sees its own current local exchange and Personal entries. On another device, the learner sees Personal entries and a separate local exchange.

The learner gives up returning to an earlier exchange after starting another one. Saving bare text does not preserve the explanation that made it meaningful; the learner writes the part they want to keep in the entry note. Preserve that cost in product copy rather than implying that entries archive lessons. The learner also owns stage judgments; Vocab remembers them but does not measure proficiency.

## Current shape and evidence

```text
apps/vocab/src/lib/data.ts
  vocabLocalDefinition: conversations, messages, showReadings
  vocabDefinition: entries with new / understood / usable
  VOCAB_SYSTEM_PROMPT: multilingual tutor, no model-authored readings

apps/vocab/src/routes/components/VocabShell.svelte
  createAgentChatState(local conversations + messages)
  Practice -> createConversation({ title, opening })

packages/chat/src/index.ts
  conversation metadata + per-conversation message adapter

packages/app-shell/src/agent-chat/
  eager handle per conversation, titles, previews, drafts, switching,
  per-conversation model/connection selection, generic chat UI
```

`ConversationView.svelte` adds selection capture, entry suggestions, dictation, and `ReadingMarkdown.svelte`. `EntriesPanel.svelte` cycles three stages and sends the newest 20 entries under the current filter to Practice. `openVocabResources()` already calls `openLocal(vocabLocalDefinition)` and `openPersonal(vocabDefinition, { account })`. The code exposes `InferencePicker` even though `data.ts` describes `VOCAB_MODEL` as a fixed model; the execution must follow callers rather than that comment.

Repository search found Vocab as the sole application consumer of `@epicenter/chat` and `@epicenter/app-shell/agent-chat`. `@epicenter/agent`, `@epicenter/client`, the inference picker, account shell, and Markdown rendering have other roles or consumers and are not wholesale deletion targets.

## Target ownership

```text
openLocal(chatHistoryDefinition)             device-owned, app-wide document
  message rows for one current session per account
    account key + agent message id + complete message value
  no conversation metadata or readings setting

openPersonal(vocabDefinition, { account })   account-backed replica
  entries: exact text + human note + four-stage self-rating + creation time

page state                                  one mounted account session
  draft, streaming answer, transient errors, optional secondary actions

future Practice activity                    temporary, separate from tutor chat
  exercise and review flow to be designed later

inference selection                         one account/device workflow choice
  resolved before a turn, captured for that turn
```

`openLocal()` does not partition by signed-in account. A local message therefore needs an account key derived from the captured authority and principal identities. The session adapter reads and deletes only that account's rows. A reset need not create a new conversation id: after aborting and disposing the old loop, delete that account's current rows in a transaction and construct one fresh loop. Verify that the store's subscription and disposal semantics make late writes impossible; add an explicit generation fence if abort alone does not prove it.

Continue using the agent loop's finished-message boundary. A user message is written on send; the assistant's visible token stream remains in memory; a clean finish writes the assistant message once. A stopped or failed answer leaves the user message. The UI must offer retry when the last stored message is a user message after reload, not only when an in-memory error is present.

The app still chooses a connection. Move the choice out of conversation identity; do not remove the shared inference picker or custom endpoint support merely because per-conversation choices disappear. A fresh install needs an explicit, usable default or a clear choose-connection step before sending a turn. New starts an empty exchange without making an inference request.

## Product cut

`VOCAB_SYSTEM_PROMPT` teaches English vocabulary. It explains an English expression in clear English, gives English examples, answers follow-ups, and can discuss pronunciation when asked. It no longer infers a studied language or bans model-authored pronunciation. Do not add a language profile to Vocab. A future Zhongwen or other language app owns its own teaching flow; creating one is outside this cut.

Remove the automatic reading overlay rather than defaulting it off. This removes `showReadings`, its Local KV state and header control, `ReadingMarkdown.svelte`, the Vocab reading providers and tests, the three script-library dependencies, Vocab's ruby styling, and ruby-stripping selection code. Use the shared Markdown component for settled answers. After removing the Vocab caller and generic agent-chat UI, inspect the shared Markdown reading API and remove it if no remaining production caller needs it.

Keep the entry contract apart from its stage dial: exact learner-selected text, exact-text deduplication, empty human-owned note, and one learner-chosen stage. Use stored values `new`, `recognized`, `understood`, and `usable`, shown as New, Recognize, Understand, and Use. A save starts at New even if the learner already knows the expression. Only the learner changes stages; a generated answer or future Practice activity never advances them automatically. Replace the cycling button with direct selection so the learner can skip or move backward. Do not add a score, confidence number, fifth stage, or practice-derived progress record.

Remove the current Practice-as-new-chat button, its title and opening prompt, and its tests with the conversation archive. A separate temporary Practice activity can later help the learner use selected expressions and review their stages without replacing the tutor exchange. Its exercise format, feedback, and review UI are outside this pass. Do not build a second persisted session or imply that Vocab currently measures learning.

## Implementation path

### 1. Establish the behavioral baseline

- [ ] Treat the current Vocab data as disposable: the product has zero users and zero existing learner data. Start the new Local and Personal shapes cleanly; do not add a compatibility reader or import path.
- [ ] Record the current focused test and typecheck result before touching Vocab, `packages/chat`, `packages/app-shell/agent-chat`, or shared Markdown; attribute failures against that baseline. Preserve unrelated checkout edits, including `bun.lock`.
- [ ] Exercise the current learner flow and the four failure boundaries: missing connection, failed answer, refresh after a saved question, and account switch.

### 2. Build and prove the one-session path

- [ ] Define `chatHistoryDefinition` with only the local state the target owns. Preserve Vocab's store identity and the Personal entry fields other than the four-value stage change. With zero existing data, do not add a compatibility migration.
- [ ] Adapt local message rows to the agent loop for one captured account. Prove ordering, account filtering, a saved question on send, one completed assistant write, and no partial assistant write after stop or failure.
- [ ] Mount one Vocab session controller for the captured account. Resolve a single account/device inference choice, capture it for each turn, and show unavailable-connection recovery.
- [ ] Make New an explicit reset. Stop and retire the old run, then replace only this account's rows. Check failure and late-result races. Do not start another archived conversation behind the UI.
- [ ] Show retry for a trailing stored user message after reload. Verify refresh recovery of finished turns and account switch isolation with a real Local-store fixture, not only a mock handle.

### 3. Make Vocab English-only and retire readings

- [ ] Replace multilingual tutor and candidate wording with English-vocabulary wording; keep pronunciation answerable on request.
- [ ] Check Vocab's smoke and reproduction scripts for prompt imports and assumptions about multilingual responses.
- [ ] Remove the reading control, setting, overlay, providers, dependencies, styling, and ruby-specific selection path. Preserve ordinary selection-to-entry behavior and Markdown rendering.
- [ ] Replace the three-stage entry field and cyclic control with the four direct choices. Preserve exact text and human-owned notes; no migration or legacy-language classification is needed with zero learner data.

### 4. Collapse retired surfaces and document the result

- [ ] Replace the conversation sidebar and generic thread wiring with the one-session Vocab surface. Remove Practice-as-new-chat and its title/prompt/test family. Keep account access, saved entries, manual stage choice, stop/retry, error handling, and explicit save.
- [ ] Search production imports again. Remove `packages/chat` and `packages/app-shell/src/agent-chat` only after their actual callers and package dependencies are gone. Keep the UI-free agent loop and shared inference infrastructure that other applications use.
- [ ] Update Vocab's README, app/package descriptions, sign-in and account copy that still says conversations sync, and any current call-site docs. Delete the spent spec after implementation, preserving durable decisions in the ADRs.
- [ ] When ADR-0446 is accepted, add the reciprocal `Superseded by` link to ADR-0105 and update its index status. Until then ADR-0446 remains a proposed replacement.

## Verification

- [ ] A clean finish produces one persisted assistant message; failure or Stop does not persist a partial answer. A saved question remains retryable after refresh.
- [ ] New resets only the current account's local turns. A late old stream cannot write into the new exchange. The other account's local turns remain available when switching back.
- [ ] Saved entry text, notes, and the four learner-chosen stages follow the account to a second device. Chat turns do not. A save starts at New; the learner can choose any stage later, including an earlier one.
- [ ] The settled answer renders Markdown without ruby annotations. Selecting and saving an English phrase stores exactly the chosen text.
- [ ] There is no Practice-as-new-chat action or automatic entry advancement. Future Practice cannot replace the tutor exchange or change stages without an explicit learner choice.
- [ ] Production searches find no Vocab multilingual-reading path, archived-conversation UI, or callers of the retired `@epicenter/chat` and `app-shell/agent-chat` exports.
- [ ] Run focused Vocab and affected package tests, Vocab and affected package typechecks, `bun typecheck`, `bun run check:doc-hygiene`, and a browser smoke of ask, save, rate, refresh, New, account switch, and second device. Run check-only formatting and lint commands if configured; do not use fix commands to sweep unrelated edits.

## Open questions

1. **Secondary chat actions.** Entry suggestions and dictation are independent of conversation archiving. Recommendation pending the product choice: keep their existing behavior for the first cut unless removing them is a separate accepted refusal. Their destination and error paths must be adjusted to the one-session lifetime if kept.
2. **Audience.** “English vocabulary learner” covers people learning English as an additional language and English readers expanding vocabulary. Recommendation: use clear English explanations and examples without requiring a source-language profile. Tune difficulty from the learner's request; defer translations and curriculum until a real audience need is established.
3. **Future Practice.** A separate temporary activity can elicit learner use and offer a stage review while leaving the tutor exchange intact. Its exact exercise, feedback, selection size, and review UI are deferred. This pass removes the old passage button rather than specifying a replacement prematurely.
