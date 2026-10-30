/**
 * Agent Conversation Binding Tests
 *
 * `bindAgentConversation` mirrors a framework-agnostic conversation handle
 * into Svelte state: each change the handle reports bumps a version the
 * snapshot derived reads only through `void version;`. The module loads
 * through the DOM harness, so this file also guards that harness's
 * transpiling of `.svelte.ts`: a transpiler that drops the bare `void` read
 * leaves the derived with no dependency, and readers keep the first snapshot.
 *
 * Key behaviors:
 * - A change the handle reports reaches the next read of the binding
 */
import './svelte-dom.test-support.js';
import { expect, test } from 'bun:test';
import type {
	ConversationHandle,
	ConversationSnapshot,
} from '@epicenter/agent';

const { bindAgentConversation } = await import(
	'./agent-conversation.svelte.ts'
);

test('a change the handle reports reaches the next read', () => {
	let snapshot = { isThinking: false } as ConversationSnapshot;
	const listeners = new Set<() => void>();
	const handle = {
		snapshot: () => snapshot,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		[Symbol.dispose]() {},
	} as unknown as ConversationHandle;
	const conversation = bindAgentConversation(handle);
	expect(conversation.isThinking).toBe(false);

	snapshot = { isThinking: true } as ConversationSnapshot;
	for (const listener of listeners) listener();

	expect(conversation.isThinking).toBe(true);
	conversation[Symbol.dispose]();
});
