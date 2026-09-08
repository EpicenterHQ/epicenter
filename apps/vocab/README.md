# Vocab

Multilingual chat tutor. A learner asks about a word, phrase, or sentence; the tutor answers in the language being studied alongside English, inferring that language from the conversation (ADR-0105). The client annotates non-Latin scripts with pronunciation readings (pinyin over Han, romaji over kana, Latin over Cyrillic) using `<ruby>` tags, produced by a deterministic offline registry. The system prompt tells the tutor to write plain text and never include readings itself.

## How it works

**Live answer in state, finished messages in the row content node**: Vocab is capability-free (ADR-0043), so the open browser tab answers its own turns, and the live answer needs nothing durable (re-asking is free). `src/routes/+page.svelte` builds the shared `createAgentChatState()` controller with Vocab's system prompt and default model, and `ConversationView.svelte` renders the active `AgentChatThread`. Only finished messages persist (ADR-0046): the user turn the moment it is sent, the assistant turn on a clean finish, each written once as one JSON blob into the conversation row's content node. A stopped or failed turn writes nothing; the durable user turn stays, ready to retry. On open, the controller reads the row and observes its content node, so a message finished on another device shows up here.

**Markdown + readings**: Settled assistant messages render through `@epicenter/ui/markdown` via `ReadingMarkdown.svelte`, which resolves the deterministic per-script romanizers whose script appears in the passage (`src/lib/readings/`, ADR-0105) and composes them behind the shared Markdown component. Readings are a client-side derived view over clean text: pure, offline, lazily loaded per script, with no model call and no network, so a reading can only be missing, never wrong. The shared Markdown component owns sanitization, markdown rendering, and `<ruby>` output. Chinese (`pinyin-pro`), Japanese kana (`wanakana`), and Cyrillic (`transliteration`) ship today; adding a language is one provider file plus one registry line.

**Workspace state**: `vocabDefinition` in `vocab.ts` is the shared isomorphic definition. It defines `epicenter-vocab`, the flat `conversations` table with its content codec, the KV settings, the Vocab model constant, and the `VocabMessage` shape. Transcripts are content nodes on conversation rows, not child documents. The boot node reads auth and gates: signed out renders the sign-in screen and opens nothing, signed in opens the principal-scoped replica with sync attached.

```txt
vocabDefinition
  -> openVocabBrowser() opens with a browser connection
```

**UI state**: split by lifetime. `src/routes/components/VocabShell.svelte` owns the page-local conversation list, active id, and CRUD. The per-conversation runtime lives in `ConversationView.svelte`, mounted via `{#key activeConversationId}`, so each conversation gets a real component lifecycle. `ConversationView` reads the active row's `content` node and hands it to the shared chat controller, which streams the live turn into `$state`, persists finished messages, and exposes `messages` / `isThinking` / `isGenerating` / `error` plus `send` / `stop` / `retry`.

**Auth**: Google OAuth through the shared Epicenter auth path. Sign-in is required to reach the app: there is no unowned store to boot into (ADR-0336), and a signed-out person meets the sign-in screen. `AccountPopover` is the account surface.

**Providers**: `@epicenter/constants/ai-providers` owns the shared servable model registry. `vocab.ts` owns Vocab's Gemini model.

## File map

```
src/
  lib/
    platform/auth.ts       # OAuth auth client
    epicenter.svelte.ts    # the one handle: createEpicenter
    state/
      dictation.svelte.ts              # dictation state and interruption handling
      inference-connections.svelte.ts  # hosted/custom inference connection registry
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
    +page.svelte             # Opens the store, and renders its four states
    auth/callback/+page.svelte # OAuth callback return to app shell
    components/
      VocabShell.svelte        # Main layout: chat state, sidebar + chat area + readings toggle
      ConversationView.svelte  # Keyed per-conversation view; binds the message store to the inference stream
      ReadingMarkdown.svelte   # Renders one settled message with its deterministic reading overlay
      DictationButton.svelte   # Speech input control
      VocabSidebar.svelte      # Sidebar conversation list with create/switch/delete
vocab.ts                    # Shared isomorphic model (tables, KV, VocabMessage shape, row content)
```

## Key decisions

- `$lib/epicenter.svelte.ts` creates an inert handle from the app id and
  definition. The boot page keys `ConversationsSession` on the selected Account.
  That child calls `epicenter.open(account)`, renders `session.opened`, and passes
  the opened data to `VocabShell`. Retries keep the captured Account; unmounting
  closes the session. The shared opener owns persistence and sync.
- The conversation list and each transcript live in the database document: metadata is ordinary row values and messages are keyed attributes on the row's `content` node. There is no `chatMessages` table.
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
