# Vocab

Multilingual chat tutor. A learner asks about a word, phrase, or sentence; the tutor answers in the language being studied alongside English, inferring that language from the conversation (ADR-0105). The client annotates non-Latin scripts with pronunciation readings (pinyin over Han, romaji over kana, Latin over Cyrillic) using `<ruby>` tags, produced by a deterministic offline registry. The system prompt tells the tutor to write plain text and never include readings itself.

## How it works

**Live answer in state, finished messages in the row body node**: Vocab is capability-free (ADR-0043), so the open browser tab answers its own turns, and the live answer needs nothing durable (re-asking is free). `src/routes/+page.svelte` builds the shared `createAgentChatState()` controller with Vocab's system prompt and default model, and `ConversationView.svelte` renders the active `AgentChatThread`. Only finished messages persist (ADR-0046): the user turn the moment it is sent, the assistant turn on a clean finish, each written once as one JSON blob into the conversation row's body node. A stopped or failed turn writes nothing; the durable user turn stays, ready to retry. On open, the controller reads the row and observes its body node, so a message finished on another device shows up here.

**Markdown + readings**: Settled assistant messages render through `@epicenter/ui/markdown` via `ReadingMarkdown.svelte`, which resolves the deterministic per-script romanizers whose script appears in the passage (`src/lib/readings/`, ADR-0105) and composes them behind the shared Markdown component. Readings are a client-side derived view over clean text: pure, offline, lazily loaded per script, with no model call and no network, so a reading can only be missing, never wrong. The shared Markdown component owns sanitization, markdown rendering, and `<ruby>` output. Chinese (`pinyin-pro`), Japanese kana (`wanakana`), and Cyrillic (`transliteration`) ship today; adding a language is one provider file plus one registry line.

**Workspace state**: `vocabDefinition` in `src/lib/data.ts` is the shared isomorphic definition. It defines `so.epicenter.vocab`, the flat `conversations` table with its body codec, the KV settings, the Vocab model constant, and the `VocabMessage` shape. Transcripts are body nodes on conversation rows, not child documents. The boot node reads auth and gates: signed out renders the sign-in screen and opens nothing, signed in opens the principal-scoped replica with sync attached.

```txt
vocabDefinition
  -> openVocabResources(account, signal) opens Local and Personal stores
```

**UI state**: split by lifetime. `src/routes/components/VocabShell.svelte` owns the page-local conversation list, active id, and CRUD. The per-conversation runtime lives in `ConversationView.svelte`, mounted via `{#key activeConversationId}`, so each conversation gets a real component lifecycle. `ConversationView` reads the active conversation's body with `data.tables.conversations.body(id)` and hands it to the shared chat controller, which streams the live turn into `$state`, persists finished messages, and exposes `messages` / `isThinking` / `isGenerating` / `error` plus `send` / `stop` / `retry`.

**Auth**: Google OAuth through the shared Epicenter auth path. Sign-in is required to reach the app: there is no unowned store to boot into (ADR-0336), and a signed-out person meets the sign-in screen. `AccountPopover` is the account surface.

The shell constructs the shared inference catalog. Chat owns each conversation’s local connection selection and compares its model with the synced conversation model. The picker receives the selected target and a callback; it owns no selection persistence.

**Providers**: `@epicenter/constants/ai-providers` owns the shared servable model registry. `vocab.ts` owns Vocab's Gemini model.

## File map

```
src/
  lib/
    auth.ts                # Plain auth client
    resources.ts           # Stores and inference resources for one document
    data.ts                # Inert store definition
    auth.svelte.ts        # UI auth tracking
    state/
      dictation.svelte.ts              # dictation state and interruption handling
      recorder.svelte.ts               # speech recorder wiring
    readings/
      registry.ts        # resolveRomanizer(): loads + composes the per-script providers
      pinyin.ts          # Chinese: per-character pinyin over Han (pinyin-pro)
      romaji.ts          # Japanese: romaji over kana (wanakana)
      cyrillic.ts        # Cyrillic: Latin transliteration (transliteration)
      runs.ts            # shared whole-run walker for run-based providers
  routes/
    +layout.svelte         # Root layout with Toaster
    +layout.ts             # SSR disabled (CSR only)
    +page.svelte           # AppBoot acquires resources after mounting
    auth/callback/+page.svelte # OAuth callback return to app shell
    components/
      VocabShell.svelte        # Main layout: chat state, sidebar + chat area + readings toggle
      ConversationView.svelte  # Keyed per-conversation view; binds the message store to the inference stream
      ReadingMarkdown.svelte   # Renders one settled message with its deterministic reading overlay
      DictationButton.svelte   # Speech input control
      VocabSidebar.svelte      # Sidebar conversation list with create/switch/delete

```

## Key decisions

- The mounted AppBoot captures the Account and calls `openVocabResources`.
  It opens independent Local and Personal stores, then acquires hosted inference,
  native transcription, and the account connection catalog separately. The shell
  renders after store acquisition and can observe inference availability later.
  Departure signals stop dictation and chat before navigation to a fresh document.
  Document destruction ends root resources. Switching conversations keeps them
  alive. Callback and route preloading open no library.
- The conversation list and each transcript live in the database document: metadata is ordinary row values and messages are keyed attributes on the row's body node. There is no `chatMessages` table.
- The live answer streams in component `$state`, not the synced doc (ADR-0046): vocab is capability-free, so re-asking is free and only finished messages need to sync. Each finished message is one LWW JSON blob keyed by message id, written the moment a normal app would POST the row.
- The cloud never writes the doc: it is a blind relay plus a stateless metered inference stream (ADR-0033).
- SSR is disabled; the app is CSR-only.
- The system prompt forbids readings (pinyin, romaji, transliteration) in AI responses so the client controls annotation rendering and toggle visibility, and the stored message stays clean for reuse as conversation memory and verbatim entries (ADR-0102, ADR-0105).

## Scripts

```sh
bun dev:vocab      # Start the local API and Vocab UI from the repo root
bun dev:vocab:ui   # Start only the Vocab UI
bun run build      # Production build, from apps/vocab
bun run preview    # Preview production build, from apps/vocab
bun run typecheck  # svelte-check, from apps/vocab
```
