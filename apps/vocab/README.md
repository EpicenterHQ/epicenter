# Vocab

Vocab helps a learner collect English expressions and practice using them in tutor-led conversations. Each saved expression has exact text, a learner-owned note, and a self-reported stage: New, Recognize, Understand, or Use. Only the learner changes the stage.

Words, notes, stages, chats, and finished messages are Markdown notes of Vocab's contract, in the learner's own Epicenter repository (`<account>/vocab`), where other devices, `git`, and agents reach them.

Vocab is online web only for now; a desktop app comes later. It is served at `/` behind sign-in: signed out it asks for a sign-in; signed in, every add, edit, delete, repair, and saved chat is a commit in the repository, and none of the learner's words or chats are kept in the browser. It needs the network; there is no browser copy to fall back on ([ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)). The same one sign-in covers the repository and Epicenter's hosted tutor models and dictation. The learner can also connect an OpenAI-compatible endpoint in this browser.

## Learner flow

Add an expression directly, paste multiple expressions for review, or browse the built-in starter list. Blank lines, repeated exact text, and already-saved text are skipped. Eligible expressions start selected. A word appears as soon as its note is saved. An addition that was refused stays in the input or review for another attempt.

Choose one to three saved expressions to start a chat. Vocab saves the chat's focus before asking the tutor to open the conversation. A stopped or failed opening leaves the chat available for explicit retry. Only a clean, complete tutor answer is saved. Unsent drafts and partial answers are local to the open conversation.

### Editing a word

Each word card edits its note (the note's body) and stage directly. The note saves as it is typed (`fieldEdit`), one save at a time, the newest value waiting; it is written over the word as the learner saw it, so another device's change to the stage is kept, and another device's change to the same note surfaces instead of being overwritten. A stage press saves at once. The visible note follows what was typed until its save answers, then follows the note again. A failed note save keeps the typed note visible with Save again, Discard, and Copy controls. A failed stage change shows an error toast.

Deleting a word asks first, then deletes its note; the repository's Git history keeps it. A failed deletion shows an error toast. The header says whether the repository answers: Online, Offline when it does not, or Sign in again (with a button) when the sign-in needs renewing. Sign out is in the account menu. Changes made elsewhere (another tab, or a desktop's `epicenter sync`) show without a reload.

### Repair as text

A word note that does not read (its front matter does not parse, or its fields do not fit the contract) appears in the repair list with its path and why. Repair as text opens its text (`NoteRepair` from `@epicenter/svelte/note-repair`): what is wrong follows the text as typed, and Save repair writes it with `replace`, which refuses text that still does not fit and writes nothing then. The card closes once the note reads as a word. A file that is not text is named but cannot be repaired here. Chat and message notes that do not read are listed by path and why; they are not shown or sent to the tutor.

## Data ownership

Vocab's files are its contract (`src/lib/contract.ts`, published as `static/contract.json`):

```text
entries/<SHA-256 of the exact text>.md   text, stage, createdAt; the learner's note in the body
chats/<id>.md                            createdAt, and focus: one to three { entryId, text }
messages/<chat id>/<message id>.md       role, createdAt (ms), and parts (text, tool calls, tool results)
```

The signed-in layout opens the learner's repository (`openRemote` from `@epicenter/folder/remote`) for the account and sets it in context (`setRepo`); the page passes its client to `VocabApp` (`fromClient(getRepo<Vocab>())`), which composes the words, chats, and messages from that one client (`createVocab`, in `src/lib/vocab.svelte.ts`). Components read and write only through the client they are given, never a client of their own, so only the `(app)` layout chooses the store. Another variant, such as the desktop app to come, needs only a new root that passes `VocabApp` its own store's client.

```text
src/routes/+layout.svelte                 every page: the chrome and the leave guard
src/routes/auth/callback/+page.svelte     completes a sign-in, outside (app), then returns to /
src/routes/(app)/+layout.svelte           the root that decides the store: signed out, a sign-in;
                                          signed in, {#key account} Online
src/routes/components/Online.svelte       setRepo(openRemote(vocab, { account })), one per account
src/routes/(app)/+page.svelte             VocabApp over fromClient(getRepo<Vocab>())
src/routes/components/VocabApp.svelte     the header (status, account), Words, and Chat over that client
```

The tutor model chosen and the endpoints connected are this browser's settings (`localStorage`), not the learner's data, so they are not in the contract. Unsent drafts and partial answers live only in the open conversation. One sign-in asks for both audiences, the API (tutor, dictation, profile) and Git (the repository).

A new word's note is named by the SHA-256 of its exact UTF-8 text. An add first checks the listed words for that text, then the note at the hashed path; it creates only when the path is free, and a different note already there is refused. A message's note is named by its chat and its own id, so saving it twice never makes two, and a different message at that id is refused. The tutor loop reads the chat's saved messages sorted by creation time. A failed learner-message save asks nothing of the tutor; the conversation keeps the unsaved message available for retry. A failed finished-answer save likewise keeps the answer visible and copyable.

## Development

From the repository root, run `bun dev:vocab`. Verify with:

```sh
bun run --cwd apps/vocab typecheck
bun run --cwd apps/vocab test
bun x playwright test -c apps/vocab/playwright.config.ts
```

The unit tests run Vocab's stores and real Svelte cards (in jsdom) over a stand-in client: a real device folder in a temporary directory (`openDevice` from `@epicenter/folder/node`, `src/lib/vocab.test-support.ts`), the same contract's client at the same paths, in place of the repository. The Playwright suite runs Vocab against the local API with temporary Git and LFS stores, in Chromium and WebKit, in one persistent profile per engine: signed out, `/` asks for a sign-in; signed in, the repository is empty; words are added, noted, staged and deleted and a chat is started, all in the repository and never in the browser's files, and a reload shows them; a desktop clone matches and passes `epicenter check`; edits each way between the desktop and the browser; a repair; and sign-out. `bun run --cwd apps/vocab demo` starts the same environment by hand. jsdom tests prove rendered content and delivered events, not layout or IME behavior.
