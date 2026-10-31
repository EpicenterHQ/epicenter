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

Each word card edits its note (the note's body) and stage directly. The note saves as it is typed (`fieldEdit`), one save at a time, the newest value waiting; it is written over the word as the learner saw it, so another device's change to the stage is kept, and another device's change to the same note surfaces instead of being overwritten. A stage press saves at once. The visible note follows what was typed until its save answers, then follows the note again. A failed note save keeps the typed note visible with Save again, Discard, and Copy controls. A failed stage change shows an error toast.

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

The variant's root (`#platform/root`) opens the store before any page renders: on the web, the learner's repository (`openRemote` from `@epicenter/folder/remote`) for the account, set in context (`setRepo`); on the desktop, the data folder. The page passes that store's client to `VocabApp` (`store()`), which composes the words, chats, and messages from that one client (`createVocab`, in `src/lib/vocab.svelte.ts`). Components read and write only through the client they are given, never a client of their own, so only the variant's root chooses the store.

```text
src/routes/+layout.svelte                 every page: the chrome and the leave guard
src/routes/auth/callback/+page.svelte     Callback from #platform/root: the web app finishes
                                          sign-in, outside (app), then returns to /
src/routes/(app)/+layout.svelte           <svelte:boundary> (spinner) around Startup from #platform/root
  lib/components/OnlineRoot.svelte        web: signed out, a sign-in; signed in, {#key account}
    lib/components/Online.svelte          setRepo(fromClient(openRemote(vocab, { account }))), one per account
  lib/components/Startup.svelte           desktop: await openAppData(vocabSettings), openDataFolder(vocab); Recovery
    lib/components/DesktopRoot.svelte     setAppData/setDevice(fromClient(...)), setFolderSync
src/routes/(app)/+page.svelte             VocabApp over store() (#platform/root)
src/routes/components/VocabApp.svelte     the header (Chrome from #platform/root), Words, and Chat
```

The tutor model chosen and the endpoints connected are this device's settings, not the learner's data, so they are not in the contract: on the web both are in this browser's `localStorage`; on the desktop the endpoints are in the AppData root's `connections.md`, their keys in the keychain. Unsent drafts and partial answers live only in the open conversation. One sign-in asks for both audiences, the API (tutor, dictation, profile) and Git (the repository).

A new word's note is named by the SHA-256 of its exact UTF-8 text. An add first checks the listed words for that text, then the note at the hashed path; it creates only when the path is free, and a different note already there is refused. A message's note is named by its chat and its own id, so saving it twice never makes two, and a different message at that id is refused. The tutor loop reads the chat's saved messages sorted by creation time. A failed learner-message save asks nothing of the tutor; the conversation keeps the unsaved message available for retry. A failed finished-answer save likewise keeps the answer visible and copyable.

## The desktop app

```sh
bun dev:vocab:desktop     # from the repository root; needs a Rust toolchain
bun build:vocab:desktop   # a local, unsigned macOS app bundle
```

Its Tauri shell (`src-tauri/`, on the shared [`epicenter-standalone`](../../packages/tauri-epicenter-standalone/README.md) crate) starts the window on Vocab's AppData root. There is no first-run question: the page opens `~/Epicenter/Vocab` (`~/Epicenter/Vocab Dev` under `tauri.dev.conf.json`), made when missing, or the folder `settings.md` names (`openAppData(vocabSettings)`, Vocab's settings contract for that root, then `openDataFolder(vocab, { appData })`). Tauri decides which folders the window may open: the shell allows the default at startup, the native picker allows a folder the learner picks, and persisted-scope keeps it. A folder that cannot open shows the shared recovery screen. The header says "On this computer", or "Synced by Epicenter" once Epicenter syncs the folder, offers **Sync with Epicenter** until it does, and holds the folder's path and **Choose data folder…** in the status details.

Signing in is optional, from the account menu, and only adds Epicenter's hosted tutor models and dictation. The shell signs in as `so.epicenter.vocab.native` through the system browser (the shared [`epicenter-account`](../../packages/tauri-epicenter-account/README.md) crate, `createTauriAuth` from `@epicenter/auth/tauri`), keeps the refresh token in the keychain, and sends the account's requests itself, so the page never holds a token; dictation's microphone needs `Info.plist`'s usage description and `entitlements.plist`.

The connected endpoints are machine-local and never synced. Their list (each one's id, name, base URL and models, never a key) is `connections.md` at the top of the AppData root, beside `settings.md`, read and written through Vocab's settings contract, the same one that opens `settings.md` (`vocabSettings` in `src/lib/folder.tauri.ts`). Each key is in the keychain under the connection's id (`keychain.get`, `keychain.set`), saved with the endpoint it was entered for. A connection's requests (its models, the tutor's streamed answers) are sent by the shell, not the window (`connectionFetch` from `@epicenter/auth/tauri`, over `epicenter-account`'s `connection_fetch`), so an endpoint that sends no CORS headers works as it does from a terminal: the window names the connection and the request, and the shell adds the key itself and sends only to the origin of the endpoint the key was saved for, over `https`, or `http` to `localhost` or `127.0.0.1`. So editing `connections.md` by hand cannot send a key elsewhere, and no connection the window holds carries its key. The model list offered while a new endpoint is being typed in is still asked from the window, since that key is not saved yet; an endpoint without CORS lists its models once saved. Nothing about connections is in the data folder or `settings.md`.

| Seam | Web leaf | Desktop leaf |
| --- | --- | --- |
| `#platform/root` | `root.ts`: `Startup` (the repository behind sign-in), `store()`, `Chrome` (status, account), the end of sign-in | `root.tauri.ts`: `Startup` (the two roots or the recovery screen), `store()`, `Chrome` (folder, sync, account), no callback |
| `#platform/auth` | `auth.ts`: the browser OAuth client for the API and Git | `auth.tauri.ts`: the shell's account, hosted models only |
| `#platform/connections` | `connections.ts`: this browser's storage, keys included, sent by the browser's `fetch` | `connections.tauri.ts`: `connections.md` in AppData, keys in the keychain, sent by the shell |

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

The unit tests run Vocab's stores and real Svelte cards (in jsdom) over a stand-in client: a real device folder in a temporary directory (`openDevice` from `@epicenter/folder/node`, `src/lib/vocab.test-support.ts`), the same contract's client at the same paths, in place of the repository. The Playwright suite runs Vocab against the local API with temporary Git and LFS stores, in Chromium and WebKit, in one persistent profile per engine: signed out, `/` asks for a sign-in; signed in, the repository is empty; words are added, noted, staged and deleted and a chat is started, all in the repository and never in the browser's files, and a reload shows them; a desktop clone matches and passes `epicenter check`; edits each way between the desktop and the browser; a repair; and sign-out. `bun run --cwd apps/vocab demo` starts the same environment by hand. jsdom tests prove rendered content and delivered events, not layout or IME behavior.
