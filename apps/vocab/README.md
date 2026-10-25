# Vocab

Vocab helps a learner collect English expressions and practice using them in tutor-led conversations. Each saved expression has exact text, a learner-owned note, and a self-reported stage: New, Recognize, Understand, or Use. Only the learner changes the stage.

Vocab opens to Words with no sign-in. Words, notes, stages, chats, and finished messages are saved in this browser's local folder. Nothing is synced to another device. Signing in optionally adds Epicenter's hosted tutor models and dictation. The learner can also connect an OpenAI-compatible endpoint for this device.

## Learner flow

Add an expression directly, paste multiple expressions for review, or browse the built-in starter list. Blank lines, repeated exact text, and already-saved text are skipped. Eligible expressions start selected. A word appears as soon as its file is saved. An addition the folder refused stays in the input or review for another attempt.

Choose one to three saved expressions to start a chat. Vocab saves the focus before asking the tutor to open the conversation. A stopped or failed opening leaves the chat available for explicit retry. Only a clean, complete tutor answer is saved. Unsent drafts and partial answers are local to the open conversation.

### Editing a word

Each word card edits its note and stage directly. The note has one local draft per mounted card. Every change asks the folder to update only the `note` field; a stage press updates only the `stage` field. The mirror writes those field changes over the file as it is when the save runs, so unnamed fields and the Markdown body survive. A lone surrogate in a note becomes U+FFFD. The folder groups changes to one path and sends them in order. The visible note follows what was typed until that save answers, then follows the file again. A failed write keeps the typed note visible with Save again, Discard, and Copy controls.

Deleting a word asks first, then removes its path. A later write can create or update that path only according to the folder's normal write rules. The header says Saving… while any write is outstanding and Saved when none is.

### Repair as text

A word file with invalid frontmatter or fields appears in the repair list. Repair as text opens its exact source in a text draft. The problem list and the Show note and stage control update from the text currently typed, even before a write lands. The control returns to the structured card only after that text reads as a valid word and its path has settled without a draft error. A read error offers Read again. A failed write keeps the typed repair visible with Save again, Discard, and Copy controls. Non-text and unreadable files are named but cannot be opened as text for repair.

### Leaving the page

`<OpenFolder>` checkpoints on focus, visibility changes, reconnect, and page hide. It asks the browser to confirm unload only while a write is outstanding. Unmount closes the folder after sending waiting writes and waiting for them to answer. A write made after close answers `Closed`.

## Data ownership

```text
openFolder({ tables: vocabTables })       This browser's local folder (IndexedDB)
  entries/<SHA-256 of exact text>.md      Exact text, note, stage, creation time
  chats/<id>.md                           Creation time and fixed focus
  messages/<chat id>.<message id>.md      Chat ID and one finished message
```

`src/lib/data.ts` declares the TypeBox schema for each table. `src/routes/+page.svelte` opens the browser folder through `@epicenter/folder/next/browser` and passes its Svelte mirror into Vocab. Opening needs no account or network. The folder is this browser origin's local folder, not a directory on disk.

A schema interprets a row. Invalid files remain in the mirror with issues and their exact source text. Vocab lists invalid word and chat files by path; an open conversation lists invalid message files belonging to that chat. Files outside these tables are left alone.

A new word's file is named by the SHA-256 of its exact UTF-8 text. An add first checks valid listed words for that text, then checks the hashed path. It creates only when the path is free. An `Exists` answer is checked against the mirror again: the same word is present, and a different file at that path is refused. A word under another filename is still found by its exact text.

A chat's messages have its ID as the first part of their filenames and in their `chat` field. The message store reads only those rows and keeps the lowest filename when two files contain the same message ID. A message write answers only after its file is visible in the mirror. The tutor loop uses saved history, sorted by creation time. A failed learner-message save asks nothing of the tutor; the conversation keeps the unsaved message available for retry. A failed finished-answer save likewise keeps the answer visible and copyable.

This version is a clean break from the older OPFS, account Personal, and device chat stores. Vocab does not read, move, or delete their data. An origin with only earlier data opens an empty current folder.

## Development

From the repository root, run `bun dev:vocab`. Verify with `bun run --cwd apps/vocab typecheck` and `bun run --cwd apps/vocab test`. The tests use the folder mirror over in-memory storage or IndexedDB, and mount real Svelte cards in jsdom. The browser-conditioned library test command exercises reactive message observation as the app does. jsdom tests prove rendered content and delivered events, not layout or IME behavior.
