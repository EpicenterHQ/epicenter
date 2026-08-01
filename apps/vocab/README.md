# Vocab

A chat-first Chinese conversation companion. You talk with a tutor that answers in Chinese and English together: English carries the explanation, Chinese carries the vocabulary, the examples, and the conversational lines (ADR-0195). Anything worth keeping is saved by hand into one flat entry pool, and the client renders pinyin over Han as a `<ruby>` overlay the tutor never writes itself.

One app, one learning goal. There is no language setting, no learner profile, and no provider registry: a second language would be a second app.

## How it works

**Three ways in, one mechanism**: every intentional session opens a new conversation. You type the first turn; or you accept a proactive seed, a topic opener the app ships as plain text; or you pick saved phrases and start Practice over them. The second and third compose a real title plus one opening user turn and hand both to `chat.createConversation()`, so a composed session never steers whatever thread happened to be open. Returning to a topic is the conversation list, sorted by recency; double-click a row to rename it, since a composed session titles a conversation you never named. There is no mode, no route, and no stored session state.

**Steering is the persona, never the pool**: the saved entries never enter a system prompt. Ordinary conversation follows you, and the tutor may offer useful Chinese the way a conversation partner does. Deliberate steering exists only where you asked for it, and then it is visible in the transcript as the turn that asked. Nothing a session does writes back: no entry is marked practiced, no counter moves, no due date is set.

**Live answer in state, finished messages in the doc**: Vocab is capability-free, so the open browser tab runs the agent loop itself and the live answer needs nothing durable, since re-asking is free (ADR-0047). `src/routes/+page.svelte` builds the shared `createAgentChatState()` controller with Vocab's system prompt and default model, and `ConversationView.svelte` renders the active `AgentChatThread`. Only finished messages persist: the user turn the moment it is sent, the assistant turn on a clean finish, each written once as one JSON blob into the conversation's row document, a last-write-wins store keyed by message id. A stopped or failed turn writes nothing; the durable user turn stays, ready to retry. On open, the controller hydrates from the store and observes it, so a message finished on another device shows up here.

**Markdown + readings**: settled assistant messages render through `@epicenter/ui/markdown` via `ReadingMarkdown.svelte`, which resolves the pinyin romanizer for a passage that has Chinese to read (`src/lib/readings.ts`, ADR-0105) and hands it to the shared Markdown component. Readings are a client-side derived view over clean text: pure, offline, one lazily loaded dictionary (`pinyin-pro`), with no model call and no network, so a reading can only be missing, never wrong. Pinyin abstains on a passage carrying kana or hangul, where shared Han takes a non-Mandarin reading. The shared Markdown component owns sanitization, markdown rendering, and `<ruby>` output.

**Entries**: `entries` is one flat pool of verbatim spans, human-curated end to end (ADR-0102). A span reaches it by an explicit save: drag a selection in the transcript and press Save entry, ask a settled message for entry candidates and tap the ones you want, or type one into the sidebar. `stage` is the one acquisition dial, an ordered ladder of `new`, `understood`, `usable`, and `note` is yours: no code path machine-writes either. There is no gloss, no dictionary, no provenance, and no scheduler.

**Replica state**: `vocabLens` in `vocab.ts` is the shared isomorphic definition. It declares the `so.epicenter.vocab` namespace, the canonical `conversations` table interpreted under it, the `entries` table, and the `showReadings` value, alongside the Vocab model, dictation model, and system-prompt constants. Transcripts are not a table: each conversation row owns a document opened as `vocab.tables.conversations.openDocument(conversationId)`. `openVocabApplication()` opens the replica and binds the Lens once; `openVocabBrowserEpicenter()` supplies the browser runtime and attaches sync when auth is signed in (ADR-0088: sign-in is an enhancement, never a door).

```txt
defineLens()
  -> vocabLens
    -> openVocabApplication() binds it to a browser replica
```

**UI state**: split by lifetime. `src/routes/+page.svelte` owns the page-local concerns: the chat controller, the readings toggle, and the composed-session entry points. The per-conversation runtime lives in the shared `createAgentChatState()` handle registry, one handle per conversation row, and `ConversationView.svelte` renders whichever handle is active plus the selection-capture and entry-candidate affordances.

**Auth**: Google OAuth through the shared Epicenter auth path. Sign-in is optional: Vocab boots into the local replica first, then attaches principal-scoped sync on signed-in boots. `AccountPopover` is the account surface.

**Providers**: `@epicenter/constants/ai-providers` owns the shared servable model registry. `vocab.ts` owns Vocab's Gemini model and its dictation model.

## File map

```
src/
  lib/
    application.ts         # openVocabApplication(): replica + bound Lens + entry pool
    VocabAppProvider.svelte  # opens the application for the tree and provides it
    context.ts             # the app handle's Svelte context
    instance.ts            # self-hosted instance connection setting
    session.ts             # SessionOpening; practiceOpening(): title + opening turn for a practice session
    seeds.ts               # the hand-written topic openers a blank thread offers
    entry-candidates.ts    # the extraction prompt and its output parser
    readings.ts            # resolveRomanizer(): the lazy per-character pinyin overlay
    platform/auth.ts       # OAuth auth client
    state/
      entries.svelte.ts                # the one entry pool: save / setStage / setNote / remove
      dictation.svelte.ts              # dictation state and interruption handling
      inference-connections.svelte.ts  # hosted/custom inference connection registry
  routes/
    +layout.svelte         # Root layout with Toaster
    +layout.ts             # SSR disabled (CSR only)
    +page.svelte             # Main layout: chat state, sidebar + chat area + readings toggle
    auth/callback/+page.svelte # OAuth callback return to app shell
    components/
      ConversationView.svelte  # The active thread, selection capture, and entry candidates
      ReadingMarkdown.svelte   # Renders one settled message with its deterministic reading overlay
      DictationButton.svelte   # Speech input control
      EntriesPanel.svelte      # The entry pool: add, stage, note, delete, and Practice
      VocabSidebar.svelte      # Conversation list plus the entries panel
vocab.ts                    # Shared isomorphic Lens (tables, values, prompt and model constants)
vocab.browser.ts            # openVocabBrowserEpicenter runtime wiring
```

## Key decisions

- Vocab teaches Chinese and says so. Every prompt the app composes names it directly, and the multilingual tutor, the language column, and the "add a language" seam are withdrawn (ADR-0195, amending ADR-0105).
- Every intentional session opens a new conversation, distinguished only by the turn it was composed with. There is no session, mode, intent, or focus column, so the canonical conversations table stays unforked (ADR-0195, ADR-0055).
- The conversation list lives in the replica's root document (`conversations` table); each transcript lives in its own synced row document, a per-id LWW message store. There is no `chatMessages` table.
- The live answer streams in component `$state`, not the synced document (ADR-0047): Vocab is capability-free, so re-asking is free and only finished messages need to sync. Each finished message is one LWW JSON blob keyed by message id, written the moment a normal app would POST the row.
- The cloud never writes the document: it is a blind relay plus a stateless metered inference stream (ADR-0033).
- SSR is disabled; the app is CSR-only.
- The system prompt forbids readings (pinyin, romaji, transliteration) in AI responses so the client controls annotation rendering and toggle visibility, and the stored message stays clean for reuse as conversation memory and verbatim entries (ADR-0102, ADR-0105).
- One language, one romanizer. The provider registry, its script dispatch, and the Japanese and Cyrillic providers are gone with the multilingual tutor that needed them; a second language costs a second app, not a provider file (ADR-0195). The abstain guard stays: a missing reading beats a wrong one.
- Saved entries are human-curated end to end: no machine writes a phrase, a note, or a comfort mark, and there is no SRS, no due date, and no stored gloss (ADR-0102).

## Scripts

```sh
bun dev:vocab      # Start the local API and Vocab UI from the repo root
bun dev:vocab:ui   # Start only the Vocab UI
bun run build      # Production build, from apps/vocab
bun run preview    # Preview production build, from apps/vocab
bun run typecheck  # svelte-check, from apps/vocab
```
