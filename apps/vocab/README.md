# Vocab

Vocab helps a learner collect English expressions and practice using them in tutor-led conversations. Words is the starting view. Each saved expression has an exact text, a learner-owned note, and one self-reported stage: New, Recognize, Understand, or Use. Only the learner changes the stage.

All tutor instructions are in English. SAT vocabulary is one expected use case;
saved expressions and phrase capture preserve ordinary Unicode text without
restricting it to a word list or script.

Vocab opens straight to Words with no sign-in. Words, notes, stages, chats, and finished messages are saved in one folder in this browser. Nothing is synced to another device; a remote would have to be configured separately. Signing in is optional and only adds Epicenter's hosted tutor models and dictation.

## Learner flow

Add an expression directly, open Add multiple to paste one expression per line, or browse the small built-in starter list. Closing Add multiple keeps the pasted text and any open review. Paste and starter lists use the same review: blanks, repeated exact text, and already-saved text are skipped; eligible expressions are selected by default. Confirmed additions have empty notes and the New stage. Words provides search, stage filtering, note editing, and stage controls. A word appears once its file is saved; an addition the folder refused stays in the field or the review for another try.

Choose one to three saved expressions in Words and start a chat. Vocab saves the chosen focus before requesting a tutor opening. The tutor speaks first, and the learner can follow up. A stopped or failed opening leaves the chat available for explicit retry.

### Editing a word

Every word's note and stage can be changed at once; there is no word to open first. A stage press, in Words or in a chat's focus list, is saved to the word's file right away. A note is held on its card while it is typed, apart from the list, and saved a second after the last keystroke, when the learner leaves it, and when the card goes away; quitting loses at most that last second. Each is a change to the file as it is now (ADR-0576): it sets the note or the stage and keeps whatever another writer changed in the other field. One word's saves run one at a time, in the order made. A note that did not save stays on its card with **Try again**. A note is saved as typed, except that the folder writes half of a surrogate pair as U+FFFD (ADR-0572); the card shows U+FFFD once that save lands.

When the file changed elsewhere since the edit started, the save merges with it: what only the other writer changed stays, and your edit wins where you both changed the same field, with no notice. When the save fails, nothing is written and the edit stays on screen; a notice says what happened, with **Save again**, and the next change sends it too. A word deleted elsewhere is gone with its edit.

The list is read when the page opens. After that, a change made outside this page is reported by the folder, here by other tabs of Vocab in this browser, and the list reads the files it reached. Returning to the window reads nothing. A read that lands while an edit is saving changes the list, never the edit. This page's own saves put what they wrote in the list themselves.

A file in `entries/` that is not a valid word is named under the list with why, and is not offered as a word. **Repair as text** opens its exact text (a file that is gone or no longer text says so instead); what is typed is saved a second after the last keystroke and when the learner leaves it, one write at a time over the version the last write left, merging by line with a change made elsewhere, and the problems are shown as the learner types. Once the text is a valid word, **Show note and stage** waits for the last write, closes the repair, and the list reads the file again and shows it as a word. A file that is not text at all is only named.

Delete asks first. Confirming waits for the word's save still running, then removes the file, whatever another tab or program changed in it since (ADR-0576).

Leaving or closing the page waits for every save and action still running and never asks to discard anything. While one runs, the browser asks before a reload or a closed tab.

Saves never record a version. Vocab has no "Save version", and its folder records history only through a sync, which Vocab does not run.

### Saving a phrase

A phrase comes from one line of one finished tutor answer that is saved. Select it with the pointer, the keyboard, or touch handles, or press the answer's "Save a phrase" button and type or paste it. Either way it must be an exact run of that answer's text, trimmed and otherwise unchanged. A selection across two messages or two lines, or in an answer that is still arriving or unsaved, offers nothing. The source is checked again when the phrase is accepted.

The phrase becomes one entry with an empty note and the New stage. "Saved to your words" appears once the folder holds the entry's file. A phrase the folder refused is not added and can be saved again. An exact text that is already in the list is reported as already there, and its note and stage are left alone.

### Chat history

Below 768px, Words and Chat sit in a bottom navigation bar; desktop keeps them in the header. A selected practice action sits above the bar without covering words. Chat returns to the selected conversation without opening History. Desktop Chat shows history, conversation, and focus words side by side; narrow Chat offers separate history and focus controls above the conversation. Returning to Words keeps the selected chat's draft and stream, but closes dictation and discards speech not yet inserted. Switching chats disposes the previous loop and its unsent draft, and never asks first. Focus text stays visible if its saved entry is deleted; its stage control then disappears. Earlier message-only chats remain readable, with their first learner question as the title.

### Choosing a model

The model picker lists the endpoints saved in this browser and lets the learner connect an OpenAI-compatible endpoint, such as a local Ollama at `http://localhost:11434/v1`. That works signed out. Connected endpoints and the chosen model are kept for this device, not for an account, so they are the same signed out and signed in: signing in adds Epicenter's hosted models beside them and takes nothing away. Signing in or out reloads the page onto the same folder: no word or chat is hidden or removed. A chosen hosted model is unavailable while signed out, and the picker asks for another. Dictation uses hosted transcription, so its button appears only when signed in.

## Data ownership

```text
openFolder({ id, definition: vocabFolder }) One folder in this browser (OPFS), ID so.epicenter.vocab
  entries/<SHA-256 of the text>.md          Exact text, note, stage, creation time
  chats/<id>.md                             Creation time, fixed focus snapshot
  messages/<chat id>.<message id>.md        Chat ID, one finished message
```

`src/lib/data.ts` declares how the folder's files read and `src/lib/folder.ts` opens it as `VOCAB_FOLDER_ID` through `@epicenter/folder/browser`. The folder is one directory in this browser's origin private file system, `Epicenter/local/so.epicenter.vocab`, holding the files and their Git history. It is not a directory on disk: Vocab has no desktop build, and inside the desktop app the opener refuses instead of opening browser storage. No row has an account in it.

This version is a clean break from earlier ones. Vocab does not read, copy, or delete what an earlier version saved in IndexedDB, in an account's Personal store, or in a device chat store; it starts from the OPFS directory alone.

A new word's file is named by the SHA-256 of its exact UTF-8 text. An add reads that file first and creates it only when none is there. Adding one text twice, from one tab or two, or again after an answer that never arrived, reaches the same file: an add finds it with its note and stage as they are, and adds made at the same moment merge into one file. A different file at that name is refused and left alone. A word file under another name, such as one written outside Vocab, is found by its text in the list.

A chat's ID is the `chat` field of its messages and the first part of their file names, so a chat reads only its own message files and the chat list reads none of them. Message files saved before chat prefixes are named by message ID alone; every chat reads them, and the chat list reads them for earlier message-only chats, which have no `chats` file and are listed without a focus. The chat list is read again when the folder reports a change to `chats/`; an open chat reads its messages when it opens and before each tutor request. A focus item holds the original text and its entry's ID.

A file Vocab cannot read as a row, because its text does not parse or a field does not conform, is listed by path with the reason and left as it is. It is never dropped from view silently. A word file can be repaired as text in Words; a chat or message file is only named.

The app runs the UI-free `@epicenter/agent` loop over one chat's message files. An unsent draft and a partial response are not saved. The selected chat owns the only live loop.

A message is saved once the folder confirms its file, and nothing is shown as saved before that. Three rules follow:

- The tutor is asked only over saved history. A learner message is a file before generation, and the opening and every retry read the chat's messages from the folder first. A draft stays in the input until its message is saved. A folder that cannot be read asks nothing and has its own "Read again".
- A tutor answer is saved only after a clean finish. A stopped, failed, filtered, or cut-off answer is not saved. A complete answer that the folder refuses stays on screen and copyable; it is not a phrase source until it is saved.
- A failed save has its own notice and its own "Save again", which writes the same file again and never asks the tutor, and a notice offers to copy the message's text. Tutor failures keep their separate retry. Leaving a chat that holds an unsaved message does not ask first; its text is lost unless it was copied or saved again. The inference picker saves one workflow choice in this browser; an unavailable model leaves Words and history usable.

Each message is saved by a write scoped to its chat, so one chat's messages are written one at a time and in order, and closing the page waits for them. A streaming answer lives only on screen until it finishes; the finished answer is then saved whole.

A message's file is named by its chat and its ID, and a save creates it only when no file is there. Saving it again after an answer that never arrived finds the file, compares what it holds, and adds no second file; a different message at that name is refused. A chat shows what it last read together with every message it saved, so a read never hides a message saved here.

## Development

Start from the repository root with `bun dev:vocab`. Run `bun run --cwd apps/vocab typecheck` and `bun test apps/vocab/src/lib` for focused checks. The tests run the real modules over the real browser folder on an in-memory OPFS stand-in. Words, chats, and every save and action go through one TanStack Query cache (ADR-0528, ADR-0548): `src/lib/vocab.svelte.ts` owns it, reads through `folderOptions` from `@epicenter/folder/query`, and wires the folder's `onFilesChanged` to invalidate exactly the queries a change reached; `src/lib/entries.svelte.ts` holds the words, the set a card sends a note or a stage with, and the repair's text draft (`createTextDraftState` from `@epicenter/folder/svelte`), and `src/lib/chat/chats.ts` holds the chat list and message saves. `bun run --cwd apps/vocab test` also runs `test:svelte`, which mounts the real word card in jsdom under the browser build of Svelte; it shows what delivered events do, not layout, focus, or IME.

## Changed promises

This version saves a note or a stage as a change to the word's file as it is now (ADR-0576): a note is saved after a pause in typing rather than on every keystroke, and a save no longer names a note it replaced. Before that, it read files through the query cache (ADR-0528) and kept each word's edit as a draft that saved as it changed (ADR-0548), instead of an edit session that autosaved, and dropped several promises of the version before it:

- A save that meets a change made elsewhere is no longer reviewed. It merges with the change (ADR-0548): what only the other writer changed stays, and your edit wins where you both changed the same field. There is no "This changed elsewhere" review, **Use this**, **Apply**, or **Try again**, and a word deleted elsewhere cannot be created again from the screen.
- A delete no longer refuses a word file changed elsewhere since this page saved it: confirming removes the file as it is then (ADR-0576).
- A failed save keeps the edit on screen with **Save again**, but only while the page is open: leaving or reloading drops an edit that was never saved.
- Every word is editable at once. There is no open word, no read-only note until focus, and nothing asks "Discard unsaved changes?".
- Returning to the window reads nothing. Changes made in another tab of Vocab arrive as the folder reports them; a file changed by another program in this browser's storage is read on the next reload.
- Leaving a chat that holds an unsaved message no longer asks first.
- Closing or leaving the page waits for every save and action and never asks to discard. The browser still asks before a reload or a closed tab while one runs.
- Saves never record a version, and Vocab offers none to record (ADR-0529).
- A note with half of a surrogate pair is saved with U+FFFD in its place, instead of being refused with a notice. A note's line endings are saved as typed (LF) rather than in the file's own convention.
- The first save of a word written by an earlier version rewrites its file in the current plain YAML form. Comments in a hand-edited word file are lost.
- New message files are named `<chat id>.<message id>.md`, and a chat reads only its own. Message files from before this change are still read by every chat and by the chat list; there are as many of them as there will ever be.
- Chats are listed newest first by when they started, not by their latest message. A chat with messages saved before this change also moves up to its latest such message, and an earlier message-only chat is placed by its latest message; messages saved after this change never move a chat.
