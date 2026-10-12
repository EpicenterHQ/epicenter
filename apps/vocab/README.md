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

Every word's note and stage can be changed at once; there is no word to open first. Each note keystroke and each stage press, in Words or in a chat's focus list, changes the word on screen and is saved to its file right away. One save of a word runs at a time and at most one more waits, which saves whatever the word holds when it starts, so fast typing writes the latest note. A note is kept well formed: half of a surrogate pair becomes U+FFFD, so what is shown is what is saved.

Every save is guarded by the version this page last saved or read. When the file changed elsewhere, or the save fails, nothing is written: the word shows the file as it is now, and a notice says what happened with **Copy your text** for the note that was not saved.

The list is read when the page opens, after the learner's own actions, and when they return to the window. Nothing is read while a save is running; the list is read once the last save finishes.

A file in `entries/` that is not a valid word is named under the list with why, and is not offered as a word. **Repair as text** opens its exact text (a file that is gone or no longer text says so instead); each change is saved as typed, and the problems are shown as the learner types. Once the text is a valid word, **Show note and stage** closes the repair and the list shows it as a word. A file that is not text at all is only named.

Delete asks first. Confirming waits for the word's saves still running, then removes the file only if it is still what this page saved last; a file changed elsewhere since is refused, and the list reads it again.

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

A new word's file is named by the SHA-256 of its exact UTF-8 text and created exclusively. Adding one text twice, from one tab or two, or again after an answer that never arrived, reaches the same file: one add creates it and the others find it, with its note and stage as they are. A different file at that name is refused and left alone. A word file under another name, such as one written outside Vocab, is found by its text in the list.

A chat's ID is the `chat` field of its messages and the first part of their file names, so a chat reads only its own message files and the chat list reads none of them. Message files saved before chat prefixes are named by message ID alone; every chat reads them, and the chat list reads them for earlier message-only chats, which have no `chats` file and are listed without a focus. A focus item holds the original text and its entry's ID.

A file Vocab cannot read as a row, because its text does not parse or a field does not conform, is listed by path with the reason and left as it is. It is never dropped from view silently. A word file can be repaired as text in Words; a chat or message file is only named.

The app runs the UI-free `@epicenter/agent` loop over one chat's message files. An unsent draft and a partial response are not saved. The selected chat owns the only live loop.

A message is saved once the folder confirms its file, and nothing is shown as saved before that. Three rules follow:

- The tutor is asked only over saved history. A learner message is a file before generation, and the opening and every retry read the chat's messages from the folder first. A draft stays in the input until its message is saved. A folder that cannot be read asks nothing and has its own "Read again".
- A tutor answer is saved only after a clean finish. A stopped, failed, filtered, or cut-off answer is not saved. A complete answer that the folder refuses stays on screen and copyable; it is not a phrase source until it is saved.
- A failed save has its own notice and its own "Save again", which writes the same file again and never asks the tutor, and a notice offers to copy the message's text. Tutor failures keep their separate retry. Leaving a chat that holds an unsaved message does not ask first; its text is lost unless it was copied or saved again. The inference picker saves one workflow choice in this browser; an unavailable model leaves Words and history usable.

Each message is saved by a write scoped to its chat, so one chat's messages are written one at a time and in order, and closing the page waits for them. A streaming answer lives only on screen until it finishes; the finished answer is then saved whole.

A message's file is named by its chat and its ID and created exclusively. Saving it again after an answer that never arrived finds the file, compares what it holds, and adds no second file; a different message at that name is refused. A chat shows what it last read together with every message it saved, so a read never hides a message saved here.

## Development

Start from the repository root with `bun dev:vocab`. Run `bun run --cwd apps/vocab typecheck` and `bun test apps/vocab/src/lib` for focused checks. The tests run the real modules over the real browser folder on an in-memory OPFS stand-in. Words, chats, and every save and action go through one TanStack Query cache (ADR-0528): `src/lib/vocab.svelte.ts` owns it, `src/lib/entries.svelte.ts` holds the words, and `src/lib/chat/chats.ts` holds the chat list and message saves. `bun run --cwd apps/vocab test` also runs `test:svelte`, which mounts the real word card in jsdom under the browser build of Svelte; it shows what delivered events do, not layout, focus, or IME.

## Changed promises

This version edits files through the query cache (ADR-0528) instead of `@epicenter/svelte/edit-session` autosave, and dropped several promises of the version before it:

- A save that meets a change made elsewhere is no longer merged or reviewed. It is refused, the word shows the file as it is now, and a notice offers the note that was not saved. There is no "This changed elsewhere" review, **Use this**, **Apply**, or **Try again**, and a word deleted elsewhere cannot be created again from the screen.
- A failed save is rolled back instead of kept as an unsaved draft. The learner can lose what was in flight: one press, or the last moment of typing.
- Every word is editable at once. There is no open word, no read-only note until focus, and nothing asks "Discard unsaved changes?".
- Returning to the window reads the list again whenever no save is running; it no longer keeps a word's failed draft.
- Leaving a chat that holds an unsaved message no longer asks first.
- Closing or leaving the page waits for every save and action and never asks to discard. The browser still asks before a reload or a closed tab while one runs.
- Saves never record a version, and Vocab offers none to record (ADR-0529).
- A note with half of a surrogate pair is saved with U+FFFD in its place, instead of being refused with a notice. A note's line endings are saved as typed (LF) rather than in the file's own convention.
- The first save of a word written by an earlier version rewrites its file in the current plain YAML form. Comments in a hand-edited word file are lost.
- New message files are named `<chat id>.<message id>.md`, and a chat reads only its own. Message files from before this change are still read by every chat and by the chat list; there are as many of them as there will ever be.
- Chats are listed newest first by when they started, not by their latest message. A chat with messages saved before this change also moves up to its latest such message, and an earlier message-only chat is placed by its latest message; messages saved after this change never move a chat.
