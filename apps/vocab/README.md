# Vocab

Vocab helps a learner collect English expressions and practice using them in tutor-led conversations. Each saved expression has exact text, a learner-owned note, and a self-reported stage: New, Recognize, Understand, or Use. Only the learner changes the stage.

Words, notes, stages, chats, and finished messages are Markdown notes of Vocab's contract: in the folder attached to Vocab on the server on the web (its history is the folder's ledger at `/folders/<id>`), or in a folder on the computer in the desktop app, which `epicenter sync` syncs to the same folder. Other devices and agents reach them, and its history leaves as Git with `epicenter export --git`.

Vocab has two variants (decision 79), both served by one build: where the page runs picks the store ([ADR-0781](../../docs/adr/0781-apps-branch-on-what-a-capability-offers-and-one-build-serves-every-surface.md)).

- **Online web**, served at `/` behind sign-in: signed out it asks for a sign-in; signed in, every add, edit, delete, repair, and saved chat is a change in the folder on the server, and none of the learner's words or chats are kept in the browser. It needs the network; there is no browser copy to fall back on ([ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)). The same one sign-in covers the repository and Epicenter's hosted tutor models and dictation. The learner can also connect an OpenAI-compatible endpoint in this browser.
- **Desktop** ([below](#the-desktop-app)): the same pages over the folder Vocab keeps its words and chats in, with no sign-in needed. Signing in only adds the hosted tutor models and dictation.

## Learner flow

Add an expression directly, paste multiple expressions for review, or browse the built-in starter list. Blank lines, repeated exact text, and already-saved text are skipped. Eligible expressions start selected. A word appears as soon as its note is saved. An addition refused because a different note is at its path stays in the input or review.

Choose one to three saved expressions to start a chat. Vocab saves the chat's focus before asking the tutor to open the conversation. A stopped or failed opening leaves the chat available for explicit retry. Only a clean, complete tutor answer is saved. Unsent drafts and partial answers are local to the open conversation.

### Editing a word

Each word card edits its note (the note's body) and stage directly. The note saves as it is typed (the word's editor, `entries.notes.edit({ id })` over `folder.entries`), each save sending what was typed since the last one landed. Another device's change to the stage is kept, and another device's change to the same note is merged with it by lines, as sync merges ([ADR-0774](../../docs/adr/0774-one-write-makes-it-so-and-settles-a-change-the-way-sync-does.md)). A stage press saves at once, and only on a word the folder shows, so a word deleted elsewhere is not made again. The visible note follows what was typed until its save lands, then follows the note again. No save fails: while the store cannot be reached, saves wait in the folder and `<WhenOpen>` says so ([ADR-0775](../../docs/adr/0775-a-write-never-fails-the-folder-keeps-it-until-it-lands.md)).

Deleting a word asks first, then deletes its note; the folder's history on the server keeps it. On the web the header says whether the repository answers: Online, Offline while the folder cannot reach it (`folder.unavailable()`), or Sign in again (with a button) when the sign-in needs renewing. Sign out is in the account menu. Changes made elsewhere (another tab, or a desktop's `epicenter sync`) show without a reload.

### Repair as text

A word note that does not read (its front matter does not parse, or its fields do not fit the contract) appears in the repair list with its path and why. Repair as text opens its text (`NoteRepair` from `@epicenter/svelte/note-repair`): what is wrong follows the text as typed, and Save repair saves it as typed through the note's editor (`edit.text`). Text that still does not fit is written, and the card stays open with what is wrong with it now. The card closes once the note reads as a word. A file that is not text is named but cannot be repaired here. Chat and message notes that do not read are listed by path and why; they are not shown or sent to the tutor.

## Data ownership

Vocab's files are its contract (`src/lib/contract.ts`, published as `static/contract.json`):

```text
entries/<SHA-256 of the exact text>.md   text, stage, createdAt; the learner's note in the body
chats/<id>.md                            createdAt, and focus: one to three { entryId, text }
messages/<chat id>/<message id>.md       role, createdAt (ms), and parts (text, tool calls, tool results)
```

`src/lib/app.ts` opens the store once for the page's life ([ADR-0766](../../docs/adr/0766-an-apps-capabilities-are-module-values-opened-synchronously.md)): `openFolder(vocab, home({ site, account }))` from `@epicenter/folder`, where `home` picks its place by where the page runs. In a browser it is the learner's repository for the account `connectAccount()` answers, opened once the account is signed in and kept for the page's life; a new account is a new page. In a Tauri window it is the data folder, whatever the account. Under the `test` condition it is a folder in memory. `app.ts` reads each capability once through `reactive`: `account`, `folder`, the tutor's `ai` and `choices`, and `settings`, this computer's settings (`@epicenter/local`); it also exports `profile` (`openProfile(account)`), the learner's name and email for the account menu. The `(app)` layout renders the pages inside `<WhenOpen app="Vocab" {folder} {settings}>` (a spinner after 150 ms while they connect, the recovery screen when one cannot, and a prompt before the page is left while a word or chat save is out), or the sign-in page while the account is signed out and the folder is the learner's repository (`accountPurpose.required`). Every read inside is synchronous ([ADR-0778](../../docs/adr/0778-a-page-connects-once-and-then-reads-synchronously.md)). `VocabApp` builds the word and chat state over `folder.entries` and `folder.chats` (`createEntries`, `createChats`), and each tutor conversation runs over `folder.messages`. Components read and write only through the folder, never a client of their own, so only `app.ts` chooses the store.

```text
src/lib/app.ts                            account, profile, folder, ai, choices, settings: each opened once
src/lib/account-purpose.ts                what the account does for Vocab, in the learner's words, by folder.reveal
src/routes/+layout.svelte                 every page: the chrome
src/routes/auth/callback/+page.svelte     the web app finishes sign-in, outside (app), then
                                          returns to the page it started from
src/routes/(app)/+layout.svelte           over the repository and signed out: SignIn; otherwise
                                          <WhenOpen app="Vocab" {folder} {settings}>
src/routes/(app)/+page.svelte             VocabApp
src/routes/components/VocabApp.svelte     the header (FolderChrome where folder.reveal is there,
                                          else RepositoryChrome), Words, and Chat
```

The tutor can run on any model an endpoint offers (`ai` in `src/lib/app.ts`, one `openAi` from `@epicenter/ai` made for the page): Ollama or LM Studio on this computer while either runs, found without a form; Epicenter's hosted tutor model while signed in (`hosted(account)`, which follows sign-in and sign-out); and the endpoints the learner connected (`customEndpoints()`), in that order in the picker. Every entry is live, so signing in or connecting an endpoint reaches an open chat without rendering it again. Dictation always goes to Epicenter's hosted transcription; choosing a tutor model never changes where audio is sent. The tutor model chosen (`choices` in `src/lib/app.ts`, kept under the job `'chat'`, Epicenter's tutor model until the learner picks another) and the endpoints connected are this computer's settings, not the learner's data, so they are not in the contract: `models.md` and `connections.md` in `@epicenter/local`, which is this browser's `localStorage` on the web and the AppData root on the desktop. A key is in `connection-keys.json` beside them on the web, and in the app's `credentials.json` on the desktop. The tutor asks the chosen model without checking it against the models an endpoint lists; the endpoint refuses for itself. Unsent drafts and partial answers live only in the open conversation. On the web one sign-in asks for what each capability given the account declares it needs: `home` the repository, `hosted(account)` the AI gateway (tutor and dictation), and `openProfile(account)` the name and email ([ADR-0792](../../docs/adr/0792-an-account-asks-for-what-the-capabilities-that-take-it-need.md)).

A new word's note is named by the SHA-256 of its exact UTF-8 text. An add checks the words the folder holds for that text and the note at the hashed path: it saves only when `get` shows nothing there, and a different note already there is refused (`Taken`). Adds on one page run one at a time, so adding a word twice makes one. The same word added on two computers before they sync is one word, with the later add's stage (ADR-0774). A message's note is named by its chat and its own id, so saving it twice never makes two. The tutor loop reads the chat's saved messages sorted by creation time. A sent message and a finished answer show at once and are handed to the folder, which keeps them until they land; the tutor is asked only once the sent message has landed.

## The desktop app

```sh
bun dev:vocab:desktop     # from the repository root; needs a Rust toolchain
bun build:vocab:desktop   # a local, unsigned macOS app bundle
```

Its Tauri shell names the folder from Vocab's site, and the page opens it by
name: `~/Epicenter/vocab` (`~/Epicenter Dev/vocab` in development), made
when nothing is there. Vocab keeps no settings note of its own; the model choice and
the connected endpoints in AppData are `@epicenter/ai`'s. A failed open shows the shared recovery screen with Retry. The header shows
the shell's folder path and whether Epicenter syncs the folder; a desktop
app never syncs, and Epicenter, once installed, syncs it across devices
(ADR-0822).

Signing in is optional, from the account menu, and only adds Epicenter's hosted tutor models and dictation. The shell signs in as `so.epicenter.vocab.native` through the system browser (the shared [`epicenter-account`](../../packages/tauri-epicenter-account/README.md) crate, `createTauriAuth` from `@epicenter/account/tauri`), keeps the refresh token in the app's `credentials.json` ([ADR-0740](../../docs/adr/0740-every-credential-an-app-holds-lives-in-its-own-place.md)), writes who is signed in to `account.json`, and sends the account's requests itself, so the page never holds a token; dictation's microphone needs `Info.plist`'s usage description and `entitlements.plist`.

The connected endpoints are machine-local and never synced. Their list (each one's id, name, base URL and models, never a key) is `connections.md` at the top of the AppData root, which `customEndpoints()` from `@epicenter/ai` keeps in this computer's settings, with the endpoint each key was entered for. The shell keeps each key in the app's `credentials.json` under the connection's id (`connectionKey` in `@epicenter/ai`'s desktop module, `packages/ai/src/tauri.ts`, over `connection_key_set` and `connection_key_move`). A connection's requests (its models, the tutor's streamed answers) are sent by the shell, not the window (`connectionFetch` in the same module, over `epicenter-account`'s `connection_fetch`), so an endpoint that sends no CORS headers works as it does from a terminal: the window names the connection and the request, and the shell adds the key itself and sends only to the origin of the endpoint the key was saved for, over `https`, or `http` to `localhost` or `127.0.0.1`. So editing `connections.md` by hand cannot send a key elsewhere, and no connection the window holds carries its key. The model list offered while a new endpoint is being typed in is still asked from the window, since that key is not saved yet; an endpoint without CORS lists its models once saved. Nothing about connections is in the data folder or `settings.md`.

The page is the web's own build (`build/`, the dev server in development). One build serves both ([ADR-0781](../../docs/adr/0781-apps-branch-on-what-a-capability-offers-and-one-build-serves-every-surface.md)): each capability package decides where the page runs and loads its desktop code only there. `connectAccount()` is the browser OAuth client in a browser, which also completes a sign-in on `/auth/callback`, and the shell's account in a Tauri window (`createTauriAuth`), read from `account.json` once the page connected. `home` is the account's repository in a browser and the data folder in a Tauri window. `customEndpoints()` is this computer's settings in both, with each key in this browser's storage in a browser and in the shell's credentials file in a Tauri window.

The views branch on `folder.reveal`, which is there only for a folder on this computer: the header shows `FolderChrome` (the folder's path, whether Epicenter syncs it, the account) there and `RepositoryChrome` (whether the repository answers, Sign in again, the account) otherwise, and `accountPurpose` (`src/lib/account-purpose.ts`) says the account is required over the repository and optional over the folder.

## Development

From the repository root, run `bun dev:vocab`. Verify with:

```sh
bun run --cwd apps/vocab typecheck
bun run --cwd apps/vocab test
cargo test -p vocab
cargo test -p epicenter-account
```

The unit tests run under the `test` condition, where `app.ts`'s folder is in memory. Vocab's stores and real Svelte cards (in jsdom) run over a folder of their own instead: Vocab's folder at a new place in memory (`memory()` from `@epicenter/folder/memory`, `src/lib/vocab.test-support.ts`), whose files `memoryFiles` reads and writes as another program would, so it can hold a note that does not read, take files written by another program, and hold writes or make them wait as a lost connection does. jsdom tests prove rendered content and delivered events, not layout or IME behavior.
