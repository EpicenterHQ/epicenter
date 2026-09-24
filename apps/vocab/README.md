# Vocab

Vocab helps a learner understand English expressions in a tutor chat and save the ones they want to remember. Each saved entry has the learner's note and one self-reported stage: New, Recognize, Understand, or Use. Vocab does not score proficiency or change stages automatically.

## Data ownership

```text
openLocal(chatHistoryDefinition)              This device
  messages                                 Account + chat + message ID + complete message
  chats                                    Derived from messages; no metadata table

openPersonal(vocabDefinition, { account })    Personal account
  entries                                  Exact text, note, stage, creation time
```

`src/lib/resources.ts` opens both stores after `AppBoot` captures the account. The Local document is device-owned across sign-ins, so each message carries an account key. Switching accounts shows only that account's chats. Chats survive refresh on this device but do not follow the account to another device. Entries follow the account.

Sending writes the question locally before generation. The answer streams in page state and is saved once after a clean finish. Stopping, failure, or switching chats leaves the submitted question available for retry. An unsent draft and partial answer are not durable.

## Learner flow

Ask about an English word or phrase, follow up, and select text in a settled answer to save it. New chat selects an empty chat; it writes nothing until the first question is sent. Its sidebar title comes from that question. Older chats remain available in the sidebar, sorted by recent activity. Only the selected chat has a mounted agent loop, draft, microphone, and active answer. Switching chats stops that work.

The sidebar also supports adding an entry directly. Saving trims the selection, deduplicates by exact text, and starts with an empty learner-owned note and the New stage. The learner can select any stage later, including an earlier one. Suggested entries and dictation are optional chat actions; neither changes saved stages.

The former Practice-in-a-new-chat action and automatic pronunciation readings have been removed. A separate Practice activity can be designed later. The tutor can explain pronunciation when asked.

## Runtime

The client runs the UI-free `@epicenter/agent` loop over Vocab's Local message adapter. `src/lib/chat/session.svelte.ts` binds one loop to the active keyed chat view and captures the inference connection and model for each turn. The inference picker persists one device workflow choice for that account. Vocab supplies no tool catalog, so chat has no web search. `src/lib/data.ts` declares the Local and Personal store shapes and English tutor prompt. The app is client-rendered and requires sign-in for account-backed entries and hosted inference.

## Main files

```text
src/lib/data.ts                         Store definitions and tutor prompt
src/lib/resources.ts                    Local, Personal, and inference opening
src/lib/entries.svelte.ts               Personal entry actions
src/lib/chat/messages.ts                Local message adapter and derived chat list
src/lib/chat/session.svelte.ts          One active tutor loop
src/lib/chat/dictation.svelte.ts        Microphone and transcription lifetime
src/lib/chat/candidates.ts              Optional entry suggestions
src/routes/components/VocabShell.svelte       Resource and selection lifetime
src/routes/components/ConversationView.svelte Active chat and selection save
src/routes/components/VocabSidebar.svelte     Chats and saved entries
```

Start from the repository root with `bun dev:vocab`. Run focused checks with `bun run --cwd apps/vocab typecheck` and `bun test apps/vocab/src/lib`.
