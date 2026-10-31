# Vocab

Vocab helps a learner collect English expressions and practice using them in tutor-led conversations. Each saved expression has exact text, a learner-owned note, and a self-reported stage: New, Recognize, Understand, or Use. Only the learner changes the stage.

Vocab opens to Words with no sign-in. Words, notes, stages, chats, and finished messages are Markdown notes of Vocab's contract. Vocab has two views (decision 76), each over its own files:

- **On this device** (`/`): the notes in this browser's files. It works signed out and offline.
- **Synced** (`/synced`, signed in): the learner's Epicenter repository (`<account>/vocab`), where other devices, Epicenter's desktop app, `git`, and agents reach them. Signed out it asks for a sign-in.

Each view adds, edits, deletes, repairs, and chats over its own notes; a chat's focus words and messages are always the same view's. Signed in, the uploader moves every note on this device into the repository in the background: a word or chat leaves "On this device" and appears in "Synced", whichever view made it. Nothing keeps it on screen across the move. The two views are not merged; one merged view may come back later.

Signing in also adds Epicenter's hosted tutor models and dictation, in either view. The learner can also connect an OpenAI-compatible endpoint for this device.

## Learner flow

Add an expression directly, paste multiple expressions for review, or browse the built-in starter list. Blank lines, repeated exact text, and already-saved text are skipped. Eligible expressions start selected. A word appears as soon as its note is saved. An addition that was refused stays in the input or review for another attempt.

Choose one to three saved expressions to start a chat. Vocab saves the chat's focus before asking the tutor to open the conversation. A stopped or failed opening leaves the chat available for explicit retry. Only a clean, complete tutor answer is saved. Unsent drafts and partial answers are local to the open conversation.

### Editing a word

Each word card edits its note (the note's body) and stage directly. The note saves as it is typed (`fieldEdit`), one save at a time, the newest value waiting; it is written over the word as the learner saw it, so another device's change to the stage is kept, and another device's change to the same note surfaces instead of being overwritten. A stage press saves at once. The visible note follows what was typed until its save answers, then follows the note again. A failed note save keeps the typed note visible with Save again, Discard, and Copy controls. A failed stage change shows an error toast.

Deleting a word asks first, then deletes its note. A failed deletion shows an error toast. The header links the two views and says which is open: On this device, or Synced (Offline when the server cannot be reached, Sign in again when the sign-in needs renewing).

### Repair as text

A word note that does not read (its front matter does not parse, or its fields do not fit the contract) appears in the repair list with its path and why. Repair as text opens its text (`NoteRepair` from `@epicenter/svelte/note-repair`): what is wrong follows the text as typed, and Save repair writes it with `replace`, which refuses text that still does not fit and writes nothing then. The card closes once the note reads as a word. A file that is not text is named but cannot be repaired here. Chat and message notes that do not read are listed by path and why; they are not shown or sent to the tutor.

## Data ownership

Vocab's files are its contract (`src/lib/contract.ts`, published as `static/contract.json`):

```text
entries/<SHA-256 of the exact text>.md   text, stage, createdAt; the learner's note in the body
chats/<id>.md                            createdAt, and focus: one to three { entryId, text }
messages/<chat id>/<message id>.md       role, createdAt (ms), and parts (text, tool calls, tool results)
```

"On this device" reads this browser's files for Vocab's origin (OPFS, `openDevice` from `@epicenter/folder/browser`), opened once for the page in `src/lib/device.ts` with no account. "Synced" reads the learner's repository (`openRemote` from `@epicenter/folder/remote`), which the signed-in boundary sets in context. Each view composes its words, chats, and messages from its one client (`fromClient`, in `src/lib/vocab.svelte.ts`). The uploader (`startUploading`), owned by the signed-in boundary and ended with the account, adopts each file on this device once it has been quiet for a few seconds, and the browser lets go of its copy once the repository has it. Editing and deleting in "Synced" needs the server. Signing out leaves the browser with only what has not uploaded.

```text
src/routes/+layout.svelte                    chrome only; the sign-in callback opens nothing
src/routes/auth/callback/+page.svelte        completes a sign-in
src/routes/(app)/+layout.svelte              the leave guard, and signed in, the signed-in boundary around both views
src/routes/(app)/+page.svelte                "On this device": VocabApp over fromClient(device)
src/routes/(app)/synced/+layout.svelte       signed out, asks for a sign-in
src/routes/(app)/synced/+page.svelte         "Synced": VocabApp over fromClient(getRepo())
src/routes/components/SignedIn.svelte        the repository (setRepo) and the uploader, one per account
src/routes/components/VocabApp.svelte        one view: the header, Words, and Chat over one client
```

The tutor model chosen and the endpoints connected are this device's settings (browser storage), not the learner's data, so they are not in the contract. One sign-in asks for both audiences, the API (tutor, dictation, profile) and Git (the repository).

A new word's note is named by the SHA-256 of its exact UTF-8 text. An add first checks the listed words for that text, then the note at the hashed path; it creates only when the path is free, and a different note already there is refused. A message's note is named by its chat and its own id, so saving it twice never makes two, and a different message at that id is refused. The tutor loop reads the chat's saved messages sorted by creation time. A failed learner-message save asks nothing of the tutor; the conversation keeps the unsaved message available for retry. A failed finished-answer save likewise keeps the answer visible and copyable.

## Development

From the repository root, run `bun dev:vocab`. Verify with:

```sh
bun run --cwd apps/vocab typecheck
bun run --cwd apps/vocab test
bun x playwright test -c apps/vocab/playwright.config.ts
```

The unit tests run Vocab's stores and real Svelte cards (in jsdom) over a real device folder in a temporary directory (`src/lib/vocab.test-support.ts`). The Playwright suite runs Vocab against the local API with temporary Git and LFS stores, in Chromium and WebKit: words made signed out on "On this device" while "Synced" asks for a sign-in; on sign-in, their upload (and that of one added on this device signed in) out of "On this device" and the browser's files into "Synced", where a word and a chat are added; a desktop clone that passes `epicenter check`; edits each way between the desktop and "Synced"; a repair there; and sign-out. `bun run --cwd apps/vocab demo` starts the same environment by hand. jsdom tests prove rendered content and delivered events, not layout or IME behavior.
