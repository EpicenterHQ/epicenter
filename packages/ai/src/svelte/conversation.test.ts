/**
 * `fromConversation`: a conversation's snapshot as getters that track while
 * an effect reads them, on the shared adapter helper.
 *
 * Key behaviors:
 * - A change the conversation reports reaches the next read, tracked or not
 * - It subscribes only while read in an effect, and disposing it disposes
 *   the conversation
 */
import '../../../svelte/src/svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import { flushSync } from 'svelte';
import type {
	ConversationHandle,
	ConversationSnapshot,
} from '../agent/loop.js';

const { fromConversation } = await import('./conversation.js');
const { follow } = await import(
	'../../../svelte/src/reactive.test-support.svelte.js'
);

function handleOf() {
	let snapshot = { isThinking: false } as ConversationSnapshot;
	const listeners = new Set<() => void>();
	let disposed = false;
	const handle = {
		snapshot: () => snapshot,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		[Symbol.dispose]() {
			disposed = true;
		},
	} as unknown as ConversationHandle;
	return {
		handle,
		listeners,
		disposed: () => disposed,
		think() {
			snapshot = { isThinking: true } as ConversationSnapshot;
			for (const listener of listeners) listener();
		},
	};
}

test('a change the conversation reports reaches the next read, and a tracked read reruns', () => {
	const source = handleOf();
	const conversation = fromConversation(source.handle);
	expect(conversation.isThinking).toBe(false);
	expect(source.listeners.size).toBe(0);

	const followed = follow(() => conversation.isThinking);
	flushSync();
	expect(source.listeners.size).toBe(1);
	source.think();
	flushSync();
	expect(followed.values).toEqual([false, true]);
	followed.stop();
	flushSync();
	expect(source.listeners.size).toBe(0);

	conversation[Symbol.dispose]();
	expect(source.disposed()).toBe(true);
});
