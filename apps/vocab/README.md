# Vocab

Vocab helps a learner understand English expressions in a tutor chat and save the ones they want to remember. Each saved entry has the learner's note and one self-reported stage: New, Recognize, Understand, or Use. The app does not score proficiency or change stages automatically.

## Data ownership

```text
openLocal(chatHistoryDefinition)            This device
  messages                              One current tutor exchange per account

openPersonal(vocabDefinition, { account })  Personal account
  entries                               Exact text, note, stage, creation time
```

`src/lib/resources.ts` opens both stores after the account is captured by `AppBoot`. The Local store is device-owned, so each message row includes an account key. Switching accounts shows only that account's local exchange. Finished turns survive a refresh on this device; they do not follow the account to another device. Entries do follow the account.

The learner's question is written when sent. The answer streams in page state and is written once after a clean finish. Stopping or failing leaves the question available for retry, including after refresh. An unsent draft or partial answer is not durable. New chat stops the current run and clears only the active account's messages; earlier exchanges cannot be reopened.

## Learner flow

Ask about an English word or phrase, follow up, and select text in a settled answer to save it. The sidebar also supports adding an entry directly. Saving trims the selection, deduplicates by exact text, and starts with an empty learner-owned note and the New stage. The learner can select any stage later, including an earlier one. Suggested entries and dictation are optional chat actions; neither changes saved stages.

The former Practice-in-a-new-chat action and automatic pronunciation readings have been removed. A separate Practice activity can be designed later. The tutor can explain pronunciation when asked.

## Runtime

The client runs the UI-free `@epicenter/agent` loop over Vocab's local message adapter. `src/lib/state/chat.svelte.ts` owns one loop for the mounted account and captures the chosen inference connection and model for each turn. The inference picker persists one device workflow choice for that account. `src/lib/data.ts` declares the inert Local and Personal store shapes and the English tutor prompt. The app is client-rendered and requires sign-in for account-backed entries and hosted inference.

## Main files

```text
src/lib/data.ts                     Store definitions and tutor prompt
src/lib/chat-history.ts             Local message adapter scoped by account
src/lib/state/chat.svelte.ts        One tutor loop and New chat reset
src/lib/state/entries.svelte.ts     Personal entry actions
src/lib/resources.ts                Local, Personal, and inference opening
src/routes/components/VocabShell.svelte       Resource and component lifetime
src/routes/components/ConversationView.svelte Chat, selection save, suggestions, dictation
src/routes/components/EntriesPanel.svelte     Saved entries and stage selection
```

Start from the repository root with `bun dev:vocab`. Run focused checks with `bun run --cwd apps/vocab typecheck` and `bun test apps/vocab/src/lib`.
