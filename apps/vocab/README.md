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
src/routes/(app)/ViewLinks.svelte            the two views' links, which each web page hands VocabApp's header
src/routes/components/SignedIn.svelte        the repository (setRepo) and the uploader, one per account
src/routes/components/VocabApp.svelte        one view: the header, Words, and Chat over one client (also the desktop root's)
```

The tutor model chosen and the endpoints connected are this device's settings (browser storage), not the learner's data, so they are not in the contract. One sign-in asks for both audiences, the API (tutor, dictation, profile) and Git (the repository).

A new word's note is named by the SHA-256 of its exact UTF-8 text. An add first checks the listed words for that text, then the note at the hashed path; it creates only when the path is free, and a different note already there is refused. A message's note is named by its chat and its own id, so saving it twice never makes two, and a different message at that id is refused. The tutor loop reads the chat's saved messages sorted by creation time. A failed learner-message save asks nothing of the tutor; the conversation keeps the unsaved message available for retry. A failed finished-answer save likewise keeps the answer visible and copyable.

## Desktop

Vocab's desktop program is its own small Tauri app (`src-tauri/`, identifier `so.epicenter.vocab`) on the shared standalone startup (`packages/tauri-epicenter-standalone`). It shows the same Vocab as the web, over a folder on this computer:

- **Its folder.** On first run it asks "Where should Vocab keep its files?": the Epicenter folder `~/Epicenter/Vocab` (recommended; `~/Epicenter Dev/Vocab` for the `.dev` build), the app's data folder, or any folder. The choice is `folder` in `settings.md` in Vocab's configuration directory (`appConfig`), never in the folder. Rust binds the folder to the window before the page loads; the page opens it with `openDevice(vocab)` from `@epicenter/folder/tauri`. The words, chats and messages there are the same Markdown files as everywhere (`epicenter check <url>/contract.json <folder>`).
- **The folder menu**, where the web shows its two views: where the folder is, whether Epicenter syncs it (`syncedWithEpicenter`), "Sync with Epicenter" (`syncWithEpicenter({ path, contract })`, which opens `epicenter://init?path=…&contract=https://vocab.epicenter.so/contract.json` for Epicenter to set up), and "Choose folder…" (waits for saves, then moves the window to the new folder). Vocab never commits; Epicenter syncs.
- **Sign-in is for hosted models and dictation only.** It runs through the system browser (RFC 8252 loopback, PKCE) as the native client `so.epicenter.vocab.desktop`, which asks for the API alone. The refresh token is in the keychain; the page never holds a token: Rust sends the account's requests to Epicenter's API (`src-tauri/src/account.rs`, `src/lib/platform/auth.tauri.ts`).
- **Connected endpoints' API keys are in the keychain**, each saved with the endpoint it was entered for (`src-tauri/src/keychain.rs`, `src/lib/platform/connections.tauri.ts`); the list itself stays in the window's storage.
- **Closing waits for saves**: Cmd-Q and the close button go through the leave guard.

The variant is chosen at build time. `bun run build:native` (`EPICENTER_DESKTOP=1`) builds the root in `src/desktop` into `build-desktop/`, and resolves `#platform/auth` and `#platform/connections` to their `.tauri.ts` leaves; the web build keeps `src/routes` and the `.browser.ts` leaves. `src/lib/platform.test.ts` bundles both and names a seam whose desktop leaf went missing.

```sh
bun run --cwd apps/vocab dev:desktop      # the .dev build (so.epicenter.vocab.dev)
bun run --cwd apps/vocab build:desktop    # Vocab.app
cargo test -p vocab -p epicenter-standalone
```

A debug build reads `EPICENTER_API_URL` (a local API) and, with `EPICENTER_TEST_SECRETS` set, keeps its secrets in memory instead of the keychain.

## Development

From the repository root, run `bun dev:vocab`. Verify with:

```sh
bun run --cwd apps/vocab typecheck   # the web build and the desktop build
bun run --cwd apps/vocab test
bun x playwright test -c apps/vocab/playwright.config.ts
```

The unit tests run Vocab's stores and real Svelte cards (in jsdom) over a real device folder in a temporary directory (`src/lib/vocab.test-support.ts`). The Playwright suite runs Vocab against the local API with temporary Git and LFS stores, in Chromium and WebKit: words made signed out on "On this device" while "Synced" asks for a sign-in; on sign-in, their upload (and that of one added on this device signed in) out of "On this device" and the browser's files into "Synced", where a word and a chat are added; a desktop clone that passes `epicenter check`; edits each way between the desktop and "Synced"; a repair there; and sign-out. `bun run --cwd apps/vocab demo` starts the same environment by hand. jsdom tests prove rendered content and delivered events, not layout or IME behavior.
