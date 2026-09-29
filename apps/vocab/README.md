# Vocab

Vocab helps a learner collect English expressions and practice using them in tutor-led conversations. Words is the starting view. Each saved expression has an exact text, a learner-owned note, and one self-reported stage: New, Recognize, Understand, or Use. Only the learner changes the stage.

## Learner flow

Add an expression directly, paste one expression per line, or browse the small built-in starter list. Paste and starter lists use the same review: blanks, repeated exact text, and already-saved text are skipped; eligible expressions are selected by default. Confirmed additions have empty notes and the New stage. Words provides search, stage filtering, note editing, and stage controls.

Choose one to three saved expressions in Words and start a chat. Vocab saves the chosen focus on this device before requesting a tutor opening. The tutor speaks first, and the learner can follow up. A stopped or failed opening leaves the chat available for explicit retry. Selecting text in a finished tutor answer saves that exact expression as one new entry.

Chat history stays on this device. Desktop Chat shows history, conversation, and focus words side by side; narrow Chat offers history and focus controls above the conversation. Returning to Words keeps the selected chat's draft and stream, but closes dictation and discards speech not yet inserted. Switching chats disposes the previous loop and its unsent draft. Focus text stays visible if its saved entry is deleted; its stage control then disappears. Earlier message-only chats remain readable, with their first learner question as the title.

## Data ownership

```text
openLocal(chatHistoryDefinition)              This device
  chats                                    Account key, creation time, fixed focus snapshot
  messages                                 Account key, conversation ID, finished message

openPersonal(vocabDefinition, { account })    Personal account
  entries                                  Exact text, note, stage, creation time
```

The chat row ID is the conversation ID on its messages. A focus item holds the original text and its Personal entry ID. Notes and stages remain in Personal entries and follow the account across devices. Local rows carry an account key so switching accounts shows only that account's device history. Legacy message-only chats are read without fabricating a focus row; this compatibility reader can retire only after those histories have an explicit preservation path.

The app runs the UI-free `@epicenter/agent` loop over Local message rows. It writes submitted learner messages before generation and saves an assistant response only after a clean finish. An unsent draft and partial response are not durable. The selected chat owns the only live loop. The inference picker saves one device workflow choice for the account; an unavailable model leaves Words and history usable.

## File chat prototype

The proposed [file chat decision](../../../docs/adr/0463-vocab-saves-each-linear-chat-as-one-markdown-file.md) has a tested codec in `src/lib/chat/file-format.ts`. It reads one Markdown transcript with visible speaker headings, preserves literal headings in message text, and appends a completed turn to readable current source. Run `bun test apps/vocab/src/lib/chat/file-format.test.ts` from the repository root. Vocab still uses the Local rows described above; the codec does not yet open account files or synchronize chats.

## Development

Start from the repository root with `bun dev:vocab`. Run `bun run --cwd apps/vocab typecheck` and `bun test apps/vocab/src/lib` for focused checks.
