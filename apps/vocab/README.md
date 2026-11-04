# Vocab

Vocab helps a learner collect English expressions and practice using them in tutor-led conversations. Each saved expression has exact text, a learner-owned note, and a self-reported stage: New, Recognize, Understand, or Use. Only the learner changes the stage.

Words, notes, stages, chats, and finished messages are Markdown notes of Vocab's contract: in the learner's own Epicenter repository (`<account>/vocab`) on the web, or in a folder on the computer in the desktop app, which Epicenter can sync to the same repository. Other devices, `git`, and agents reach them.

Vocab has two variants, chosen at build time (decision 79):

- **Online web**, served at `/` behind sign-in: signed out it asks for a sign-in; signed in, every add, edit, delete, repair, and saved chat is a commit in the repository, and none of the learner's words or chats are kept in the browser. It needs the network; there is no browser copy to fall back on ([ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)). The same one sign-in covers the repository and Epicenter's hosted tutor models and dictation. The learner can also connect an OpenAI-compatible endpoint in this browser.
- **Desktop** ([below](#the-desktop-app)): the same pages over the folder Vocab keeps its words and chats in, with no sign-in needed. Signing in only adds the hosted tutor models and dictation.

## Learner flow

Add an expression directly, paste multiple expressions for review, or browse the built-in starter list. Blank lines, repeated exact text, and already-saved text are skipped. Eligible expressions start selected. A word appears as soon as its note is saved. An addition that was refused stays in the input or review for another attempt.

Choose one to three saved expressions to start a chat. Vocab saves the chat's focus before asking the tutor to open the conversation. A stopped or failed opening leaves the chat available for explicit retry. Only a clean, complete tutor answer is saved. Unsent drafts and partial answers are local to the open conversation.

### Editing a word

Each word card edits its note (the note's body) and stage directly. The note saves as it is typed (the word's editor, `entries.notes.edit({ id })` over `folder.entries`), one save at a time, the newest value waiting; it is written over the word as the learner saw it, so another device's change to the stage is kept, and another device's change to the same note surfaces instead of being overwritten. A stage press saves at once. The visible note follows what was typed until its save answers, then follows the note again. A failed note save keeps the typed note visible with Save again, Discard, and Copy controls. A failed stage change shows an error toast.

Deleting a word asks first, then deletes its note; the repository's Git history keeps it. A failed deletion shows an error toast. On the web the header says whether the repository answers: Online, Offline when it does not, or Sign in again (with a button) when the sign-in needs renewing. Sign out is in the account menu. Changes made elsewhere (another tab, or a desktop's `epicenter sync`) show without a reload.

### Repair as text

A word note that does not read (its front matter does not parse, or its fields do not fit the contract) appears in the repair list with its path and why. Repair as text opens its text (`NoteRepair` from `@epicenter/svelte/note-repair`): what is wrong follows the text as typed, and Save repair writes it with `replace`, which refuses text that still does not fit and writes nothing then. The card closes once the note reads as a word. A file that is not text is named but cannot be repaired here. Chat and message notes that do not read are listed by path and why; they are not shown or sent to the tutor.

## Data ownership

Vocab's files are its contract (`src/lib/contract.ts`, published as `static/contract.json`):

```text
entries/<SHA-256 of the exact text>.md   text, stage, createdAt; the learner's note in the body
chats/<id>.md                            createdAt, and focus: one to three { entryId, text }
messages/<chat id>/<message id>.md       role, createdAt (ms), and parts (text, tool calls, tool results)
```

`src/lib/app.ts` opens the store once for the page's life ([ADR-0766](../../docs/adr/0766-an-apps-capabilities-are-module-values-opened-synchronously.md)): `openFolder(vocab, { site, account })` from `@epicenter/folder`, which the build picks. On the web it is the learner's repository for the account `connectAccount()` answers, opened once the account is signed in and kept for the page's life; a new account is a new page. On the desktop it is the data folder, whatever the account. Under the `test` condition it is a folder in memory. `app.ts` reads each capability once through `reactive`: `account`, `folder`, and the tutor's `ai` and `choices`. The `(app)` layout renders the pages inside `<WhenOpen app="Vocab" {folder}>` (a spinner while the folder opens, the recovery screen when it cannot, and a prompt before the page is left while a word or chat save is out), or the sign-in page while the web build is signed out. `VocabApp` builds the word and chat state over `folder.entries` and `folder.chats` (`createEntries`, `createChats`), and each tutor conversation runs over `folder.messages`. Components read and write only through the folder, never a client of their own, so only `app.ts` chooses the store.

```text
src/lib/app.ts                            account, folder, ai, choices: each opened once, read through reactive
src/routes/+layout.svelte                 every page: the chrome
src/routes/auth/callback/+page.svelte     the web app finishes sign-in, outside (app), then
                                          returns to the page it started from
src/routes/(app)/+layout.svelte           web, signed out: SignIn; otherwise <WhenOpen app="Vocab" {folder}>
src/routes/(app)/+page.svelte             VocabApp
src/routes/components/VocabApp.svelte     the header (Chrome from #platform/chrome), Words, and Chat
```

The tutor can run on any model an endpoint offers (`ai` in `src/lib/app.ts`, one `openAi` from `@epicenter/ai` made for the page): Ollama or LM Studio on this computer while either runs, found without a form; Epicenter's hosted tutor model while signed in (`hosted(account)`, which follows sign-in and sign-out); and the endpoints the learner connected (`customEndpoints()`), in that order in the picker. Every entry is live, so signing in or connecting an endpoint reaches an open chat without rendering it again. Dictation always goes to Epicenter's hosted transcription; choosing a tutor model never changes where audio is sent. The tutor model chosen (`choices` in `src/lib/app.ts`, kept under the job `'chat'`, Epicenter's tutor model until the learner picks another) and the endpoints connected are this device's settings, not the learner's data, so they are not in the contract: on the web both are in this browser's `localStorage`; on the desktop they are the AppData root's `models.md` and `connections.md`, the keys in the keychain. Unsent drafts and partial answers live only in the open conversation. One sign-in asks for both audiences, the API (tutor, dictation, profile) and Git (the repository).

A new word's note is named by the SHA-256 of its exact UTF-8 text. An add first checks the listed words for that text, then the note at the hashed path; it creates only when the path is free, and a different note already there is refused. A message's note is named by its chat and its own id, so saving it twice never makes two, and a different message at that id is refused. The tutor loop reads the chat's saved messages sorted by creation time. A failed learner-message save asks nothing of the tutor; the conversation keeps the unsaved message available for retry. A failed finished-answer save likewise keeps the answer visible and copyable.

## The desktop app

```sh
bun dev:vocab:desktop     # from the repository root; needs a Rust toolchain
bun build:vocab:desktop   # a local, unsigned macOS app bundle
```

Its Tauri shell names the folder from Vocab's site, and the page opens it by
name: `~/Epicenter/vocab` (`~/Epicenter Dev/vocab` in development), made
when nothing is there. Vocab keeps no settings note of its own; the connected
endpoints in AppData are `@epicenter/ai`'s. A failed open shows the shared recovery screen with Retry. The header shows
the shell's folder path and offers **Set up in Epicenter** for local history.
Connecting a repository in Epicenter enables transfer.

Signing in is optional, from the account menu, and only adds Epicenter's hosted tutor models and dictation. The shell signs in as `so.epicenter.vocab.native` through the system browser (the shared [`epicenter-account`](../../packages/tauri-epicenter-account/README.md) crate, `createTauriAuth` from `@epicenter/account/tauri`), keeps the refresh token in the keychain, and sends the account's requests itself, so the page never holds a token; dictation's microphone needs `Info.plist`'s usage description and `entitlements.plist`.

The connected endpoints are machine-local and never synced. Their list (each one's id, name, base URL and models, never a key) is `connections.md` at the top of the AppData root, which `customEndpoints()` from `@epicenter/ai` opens itself in the desktop build (the `tauri` condition picks its implementation; `connectionsCollection` from `@epicenter/ai/tauri` is the note's shape). `createKeychainConnections` from that entry keeps each key in the keychain under the connection's id, saved with the endpoint it was entered for. A connection's requests (its models, the tutor's streamed answers) are sent by the shell, not the window (`connectionFetch` from `@epicenter/ai/tauri`, over `epicenter-account`'s `connection_fetch`), so an endpoint that sends no CORS headers works as it does from a terminal: the window names the connection and the request, and the shell adds the key itself and sends only to the origin of the endpoint the key was saved for, over `https`, or `http` to `localhost` or `127.0.0.1`. So editing `connections.md` by hand cannot send a key elsewhere, and no connection the window holds carries its key. The model list offered while a new endpoint is being typed in is still asked from the window, since that key is not saved yet; an endpoint without CORS lists its models once saved. Nothing about connections is in the data folder or `settings.md`.

| Seam | Web leaf | Desktop leaf |
| --- | --- | --- |
| `#platform/account` | `account.ts`: `connectAccount()`, the browser OAuth client for the API and Git, which also completes a sign-in on `/auth/callback`; `accountPurpose`, required | `account.tauri.ts`: `connectAccount()`, the shell's account, hosted models only, which reads signed out until the shell answers; `accountPurpose`, optional |
| `#platform/chrome` | `OnlineChrome.svelte`: whether the repository answers, Sign in again, the account | `DesktopChrome.svelte`: the folder's path, Set up in Epicenter, the account |

Which folder opens is not a Vocab seam: `openFolder` from `@epicenter/folder` is the account's repository on the web and the data folder on the desktop, picked by the `tauri` condition.

Where the connected endpoints are kept is not a Vocab seam: `customEndpoints()` from `@epicenter/ai` is this browser's storage on the web and AppData with the keychain on the desktop, picked by the same `tauri` condition.

`desktopVariant()` in `vite.config.ts` turns on the `tauri` condition for `bun run build:native` (into `build-desktop/`), `tsconfig.tauri.json` typechecks the desktop leaves, and `src/lib/platform.test.ts` bundles both builds and names a seam whose desktop leaf went missing.

## Development

From the repository root, run `bun dev:vocab`. Verify with:

```sh
bun run --cwd apps/vocab typecheck
bun run --cwd apps/vocab test
bun x playwright test -c apps/vocab/playwright.config.ts
cargo test -p vocab
cargo test -p epicenter-account
```

The unit tests run under the `test` condition, where `app.ts`'s folder is in memory. Vocab's stores and real Svelte cards (in jsdom) run over a stand-in folder instead: a folder (`createFolder` from `@epicenter/folder/core`) over a real device client in a temporary directory (`openDevice` from `@epicenter/folder/node`, `src/lib/vocab.test-support.ts`), the same contract's client at the same paths, which can hold a note that does not read, take files written by another program, and hold or refuse writes. The Playwright suite runs Vocab against the local API with temporary Git and LFS stores, in Chromium and WebKit, in one persistent profile per engine: signed out, `/` asks for a sign-in; signed in, the repository is empty; words are added, noted, staged and deleted and a chat is started, all in the repository and never in the browser's files, and a reload shows them; a desktop clone matches and passes `epicenter check`; edits each way between the desktop and the browser; a repair; and sign-out. `bun run --cwd apps/vocab demo` starts the same environment by hand. jsdom tests prove rendered content and delivered events, not layout or IME behavior.
