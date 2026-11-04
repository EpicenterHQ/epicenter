import { trackReads } from '@epicenter/svelte/tracked';
import type { ConversationHandle } from '../agent/loop.js';

/**
 * Bridge a conversation (`createConversation` from `@epicenter/ai/agent`)
 * into Svelte's graph, on the helper under every capability's adapter
 * (`trackReads`): each field of its snapshot becomes a getter that tracks
 * while read in a template, `$derived` or effect, and is a snapshot
 * elsewhere. Its actions carry through, and disposing the adapter disposes
 * the conversation.
 */
export function fromConversation(handle: ConversationHandle) {
	return trackReads(
		handle.subscribe,
		{
			messages: () => handle.snapshot().messages,
			streaming: () => handle.snapshot().streaming,
			isThinking: () => handle.snapshot().isThinking,
			isGenerating: () => handle.snapshot().isGenerating,
			error: () => handle.snapshot().error,
			unsaved: () => handle.snapshot().unsaved,
			isSaving: () => handle.snapshot().isSaving,
			saveError: () => handle.snapshot().saveError,
			unreadable: () => handle.snapshot().unreadable,
		},
		{
			ready: handle.ready,
			send: handle.send,
			stop: handle.stop,
			retry: handle.retry,
			save: handle.save,
			[Symbol.dispose]: () => handle[Symbol.dispose](),
		},
	);
}
export type ReactiveConversation = ReturnType<typeof fromConversation>;
