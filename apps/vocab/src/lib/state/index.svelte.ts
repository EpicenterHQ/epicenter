import { createAgentChatState } from '@epicenter/app-shell/agent-chat';
import { VOCAB_MODEL, VOCAB_SYSTEM_PROMPT } from '@epicenter/vocab';
import type { VocabBrowser } from '@epicenter/vocab/browser';
import { createEntriesState } from './entries.svelte.js';
import { inferenceConnections } from './inference-connections.svelte.js';

export function createVocabState(vocab: VocabBrowser) {
	const entries = createEntriesState(vocab);
	const chat = createAgentChatState({
		table: vocab.tables.conversations,
		connections: inferenceConnections,
		agent: {
			buildSystemPrompts: () => [VOCAB_SYSTEM_PROMPT],
			defaultModel: VOCAB_MODEL,
		},
	});

	return {
		/** Resolves after both live SQLite projections have their initial state. */
		whenReady: Promise.all([entries.whenReady, chat.whenReady]).then(
			() => undefined,
		),
		entries,
		chat,
		[Symbol.dispose]() {
			chat[Symbol.dispose]();
			entries[Symbol.dispose]();
		},
	};
}
