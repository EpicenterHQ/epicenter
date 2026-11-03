/**
 * Transcript tests verify message classification and ordered activity groups.
 */
import { expect, test } from 'bun:test';
import type { ThreadItem } from './protocol.js';
import {
	isConversationMessage,
	segmentTurnItems,
} from './transcript.js';

test('segments messages and consecutive activity in their original order', () => {
	const user: ThreadItem = { type: 'userMessage', id: 'u', content: [] };
	const note: ThreadItem = {
		type: 'agentMessage',
		id: 'n',
		text: 'note',
		phase: 'commentary',
	};
	const unknown: ThreadItem = { type: 'futureItem' };
	const answer: ThreadItem = {
		type: 'agentMessage',
		id: 'a',
		text: 'answer',
		phase: 'final_answer',
	};
	expect(segmentTurnItems([user, note, unknown, answer, unknown])).toEqual([
		{ kind: 'message', item: user },
		{ kind: 'activity', items: [note, unknown] },
		{ kind: 'message', item: answer },
		{ kind: 'activity', items: [unknown] },
	]);
	expect(segmentTurnItems([])).toEqual([]);
});

test('commentary is activity while final and unphased answers are messages', () => {
	for (const phase of ['commentary', 'final_answer', null] as const)
		expect(
			isConversationMessage({ type: 'agentMessage', id: 'a', text: '', phase }),
		).toBe(phase !== 'commentary');
	expect(isConversationMessage({ type: 'futureItem' })).toBe(false);
});
