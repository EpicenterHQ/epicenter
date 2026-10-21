# Vocab

Vocab helps a learner collect English expressions and practice using them in tutor-led conversations. Words is the starting view. Each saved expression has an exact text, a learner-owned note, and one self-reported stage: New, Recognize, Understand, or Use. Only the learner changes the stage.

All tutor instructions are in English. SAT vocabulary is one expected use case;
saved expressions and phrase capture preserve ordinary Unicode text without
restricting it to a word list or script.

Vocab opens straight to Words with no sign-in. Words, notes, stages, chats, and finished messages are saved in this browser's local folder. Nothing is synced to another device. Signing in is optional and only adds Epicenter's hosted tutor models and dictation.

## Learner flow

Add an expression directly, open Add multiple to paste one expression per line, or browse the small built-in starter list. Closing Add multiple keeps the pasted text and any open review. Paste and starter lists use the same review: blanks, repeated exact text, and already-saved text are skipped; eligible expressions are selected by default. Confirmed additions have empty notes and the New stage. Words provides search, stage filtering, note editing, and stage controls. A word appears once its file is saved; an addition the folder refused stays in the field or the review for another try.

Choose one to three saved expressions in Words and start a chat. Vocab saves the chosen focus before requesting a tutor opening. The tutor speaks first, and the learner can follow up. A stopped or failed opening leaves the chat available for explicit retry.

### Editing a word

Every word's note and stage can be changed at once; there is no word to open first. A word's note and stage are its draft, held by the folder (`folder.tables.entries.edit(id)`) apart from the list. A stage press, in Words or in a chat's focus list, is saved right away. A typed note is saved a second after the last keystroke, even after the card goes away. FolderApp also sends pending input when the page is hidden; a forced quit can lose input that has not saved, including older input whose save failed. A draft holds every field typed since the word last saved, so a stage press also saves the note typed just before it. One word's saves run one at a time. A read that lands while a draft is held never replaces it.

The draft holds the whole source observed when typing began, including fields
that were not edited. If another tab saves different source, the local typing
stays pinned and saving reports a whole-file conflict. Retrying does not merge
fields or silently overwrite the saved word. Fields Vocab does not name and
the text below the frontmatter survive edits to the observed source. A note is
saved as typed, except that half of a surrogate pair becomes U+FFFD as it is
typed, since the folder saves only well-formed text.

A save that fails keeps the typing on the card with why it failed and **Try again**; further typing tries again too. When the word stops being listed as a word while its typing failed to save, Words names its file and keeps what was typed, with **Save again**, **Copy**, and **Discard**. A word deleted elsewhere stays deleted when the save conflicts; retrying does not recreate it. The held source remains available to copy or explicitly discard.

The list is read when the page opens. After that, the folder reports each committed save, from this page or another tab of Vocab in this browser, and the list reads the table again. The shared folder context also polls active reads while visible and refreshes them when the page becomes visible again.

A file in `entries/` that is not a valid word is named under the list with why, and is not offered as a word. **Repair as text** opens its exact text. What is typed is saved a second after the last keystroke, even after the card goes away, and by FolderApp when the page is hidden, one write at a time. Changed outside source causes a whole-file conflict and leaves the repair text held. The problems shown follow the current editable document, including unsaved text. Once that document is a valid word, **Show note and stage** returns to structured editing without waiting for a save. Switching repair files leaves their unsaved input with the folder. A file that is gone or is not text says so and offers the text still typed to copy. A file that is not text at all is only named.

Delete asks first. Confirming waits for the word's typing to save, then removes the file. A word whose typing failed to save is not deleted until that typing is saved or discarded. A word changed in another tab in that moment is kept, and a notice says so.

Leaving the page while the Folder has an accepted change still saving is cancelled; for a reload or a closed tab, the browser asks first. Normal page teardown sends held edits and waits for started saves.

Vocab records no versions and offers no "Save version" or Sync.

### Saving a phrase

A phrase comes from one line of one finished tutor answer that is saved. Select it with the pointer, the keyboard, or touch handles, or press the answer's "Save a phrase" button and type or paste it. Either way it must be an exact run of that answer's text, trimmed and otherwise unchanged. A selection across two messages or two lines, or in an answer that is still arriving or unsaved, offers nothing. The source is checked again when the phrase is accepted.

The phrase becomes one entry with an empty note and the New stage. "Saved to your words" appears once the folder holds the entry's file. A phrase the folder refused is not added and can be saved again. An exact text that is already in the list is reported as already there, and its note and stage are left alone.

### Chat history

Below 768px, Words and Chat sit in a bottom navigation bar; desktop keeps them in the header. A selected practice action sits above the bar without covering words. Chat returns to the selected conversation without opening History. Desktop Chat shows history, conversation, and focus words side by side; narrow Chat offers separate history and focus controls above the conversation. Returning to Words keeps the selected chat's draft and stream, but closes dictation and discards speech not yet inserted. Switching chats disposes the previous loop and its unsent draft, and never asks first. Focus text stays visible if its saved entry is deleted; its stage control then disappears.

### Choosing a model

The model picker lists the endpoints saved in this browser and lets the learner connect an OpenAI-compatible endpoint, such as a local Ollama at `http://localhost:11434/v1`. That works signed out. Connected endpoints and the chosen model are kept for this device, not for an account, so they are the same signed out and signed in: signing in adds Epicenter's hosted models beside them and takes nothing away. Signing in or out reloads the page onto the same folder: no word or chat is hidden or removed. A chosen hosted model is unavailable while signed out, and the picker asks for another. Dictation uses hosted transcription, so its button appears only when signed in.

## Data ownership

```text
openFolder({ tables: vocabTables })        This browser's local folder (IndexedDB)
  entries/<SHA-256 of the text>.md          Exact text, note, stage, creation time
  chats/<id>.md                             Creation time, fixed focus snapshot
  messages/<chat id>.<message id>.md        Chat ID, one finished message
```

`src/lib/data.ts` declares `vocabTables`, the TypeBox schema each table's frontmatter is read through, and `src/routes/+page.svelte` supplies `open={() => openFolder({ tables: vocabTables })}` to `<FolderApp>` from `@epicenter/svelte`. Opening needs no app ID, account, remote, or network. The folder is this browser origin's one local folder, kept in IndexedDB. It is not a directory on disk: Vocab has no desktop build, and inside the desktop app opening is refused rather than answered with browser storage. No row has an account in it.

A schema only interprets. A file whose frontmatter does not parse, or whose fields do not fit, still reads as a row with its exact text and its issues; a save never checks the schema, so fields Vocab does not name survive.

This version is a clean break. Vocab does not read, copy, or delete what an earlier version saved in its OPFS folder `so.epicenter.vocab`, in IndexedDB under another name, in an account's Personal store, or in a device chat store. An origin with only earlier data opens an empty current workspace.

A new word's file is named by the SHA-256 of its exact UTF-8 text. An add reads that file first and writes only when none is there. Adding one text twice, from one tab or two, or again after an answer that never arrived, reaches the same file: an add that finds the word there leaves its note and stage as they are. A different file at that name is refused and left alone. A word file under another name, such as one written outside Vocab, is found by its text in the list.

A chat's ID is the `chat` field of its messages and the first part of their file names, so a chat reads only its own message files and the chat list reads none of them. The chat list is read again when the folder reports a save under `chats/`; an open chat reads its messages when it opens and before each tutor request. A focus item holds the original text and its entry's ID.

A file Vocab reads that does not read as a row is listed by path with the reason and left as it is. Vocab reads `entries/`, `chats/`, and the message files named for an open chat; any other file is left alone and not listed. A word file can be repaired as text in Words; a chat or message file is only named.

The app runs the UI-free `@epicenter/agent` loop over one chat's message files. An unsent draft and a partial response are not saved. The selected chat owns the only live loop.

A message is saved once the folder confirms its file, and nothing is shown as saved before that. Three rules follow:

- The tutor is asked only over saved history. A learner message is a file before generation, and the opening and every retry read the chat's messages from the folder first. A draft stays in the input until its message is saved. A folder that cannot be read asks nothing and has its own "Read again".
- A tutor answer is saved only after a clean finish. A stopped, failed, filtered, or cut-off answer is not saved. A complete answer that the folder refuses stays on screen and copyable; it is not a phrase source until it is saved.
- A failed save has its own notice with "Save again", which writes the same file again and never asks the tutor, and "Copy". Tutor failures keep their separate retry. Leaving a chat that holds an unsaved message does not ask first; its text is lost unless it was copied or saved again. The inference picker saves one workflow choice in this browser; an unavailable model leaves Words and history usable.

One chat's messages are saved in its own turn, one at a time and in order. A streaming answer lives only on screen until it finishes; the finished answer is then saved whole.

A message's file is named by its chat and its ID. A save reads that file first and writes only when none is there. Saving it again after an answer that never arrived finds the file, compares what it holds, and adds no second file; a different message at that name is refused. A chat shows what it last read together with every message it saved, so a read never hides a message saved here.

## Development

Start from the repository root with `bun dev:vocab`. Run `bun run --cwd apps/vocab typecheck` and `bun test apps/vocab/src/lib` for focused checks. The tests run the real modules over the real local folder on an in-memory IndexedDB (`fake-indexeddb`, loaded from `@epicenter/svelte`'s install). Words, chats, and every save go through the local folder context `<FolderApp>` builds (`getFolder()`): one TanStack Query cache whose table reads the folder's `onChange` marks stale, and one close when the page goes away. The folder holds each word as stored and its draft (`folder.tables.entries.edit(id)`), which each card reads with `createFileEdit(folder.tables.entries.edit(id))` from `@epicenter/svelte/edits`; the list's reads keep it current. `src/lib/vocab.svelte.ts` builds Vocab over that context; the context waits for accepted actions (adding a word, starting a chat, saving a message) during normal teardown. `src/lib/entries.svelte.ts` holds the words and each word's draft, `src/lib/repair.svelte.ts` the repair's text, typed through the folder's edit of the file (`createFileEdit(folder.tables.entries.edit(id))`), and `src/lib/chat/chats.ts` the chat list and each chat's turn of message saves. `bun run --cwd apps/vocab test` also runs `test:svelte`, which mounts the real word card in jsdom under the browser build of Svelte; it shows what delivered events do, not layout, focus, or IME.

## Changed promises

This version opens this browser's local folder (`openFolder({ tables })`) instead of the OPFS folder named after Vocab's app ID, and drops several promises of the version before it:

- An earlier OPFS folder does not stop the new opener; its words and chats are not read, moved, or deleted. Other earlier stores are not read by this version.
- A delete no longer removes a word changed in another tab in that moment: it is kept, and a notice says so. A word whose note failed to save is not deleted until the note is saved again or discarded.
- A word deleted elsewhere stays deleted when its held source conflicts. The
  unsaved note and stage remain available to copy or explicitly discard.
- A failed note save says why on its card, without a toast. A failed message save keeps its notice in the chat, without a toast.
- Repair diagnostics follow the current text as it changes; switching to a valid structured view does not wait for saving.
- A word's listing is read again after this page's own saves too, rather than taking what the save wrote.
- Half of a surrogate pair in a note becomes U+FFFD as it is typed, not when the save lands.
- A word file and a message file are written in the folder's canonical frontmatter: keys a new file adds are sorted, and strings may be quoted.
- Closing the page sends typing and lets every started save land. A word add or a message save that has only read its file when the page closes is refused rather than finished.
