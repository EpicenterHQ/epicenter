/**
 * One shared pool for every test, so "the surfaces read the same data" is a
 * property of the fixtures too, not just a claim in the README.
 *
 * The pool is arranged so that intent isolation is falsifiable: 学习 and 练习
 * are Practice-only (they appear in no past session), while 点菜 and 服务员 are
 * Revisit-reachable (they appear in the restaurant sessions). A leak in either
 * direction shows up as a phrase in the wrong prompt.
 */

import type { PastSession, SavedPhrase } from '../src/saved.ts';
import type { Message, MessageStore, TutorModel } from '../src/tutor.ts';

function phrase(
	id: string,
	text: string,
	stage: SavedPhrase['stage'],
	createdAt: number,
): SavedPhrase {
	return { id, text, note: '', stage, createdAt };
}

export const PHRASES: SavedPhrase[] = [
	phrase('p1', '学习', 'new', 1),
	phrase('p2', '练习', 'new', 2),
	phrase('p3', '你好', 'understood', 3),
	phrase('p4', '谢谢', 'usable', 4),
	phrase('p5', '点菜', 'understood', 5),
	phrase('p6', '服务员', 'new', 6),
	phrase('p7', '买单', 'new', 7),
	phrase('p8', '好吃', 'understood', 8),
];

export const SESSIONS: PastSession[] = [
	{
		id: 's1',
		intent: 'conversation',
		startedAt: 100,
		turns: [
			{ role: 'user', text: 'I want to order at a restaurant.' },
			{ role: 'tutor', text: '在饭馆你可以说 点菜。The word means to order dishes.' },
			{ role: 'user', text: 'What do I call the waiter?' },
			{ role: 'tutor', text: '服务员 is what you call out. 这个很好吃 means this is delicious.' },
		],
	},
	{
		id: 's2',
		intent: 'chat',
		startedAt: 200,
		turns: [
			{ role: 'user', text: 'How is the weather today?' },
			{ role: 'tutor', text: '今天天气很好。The weather is nice.' },
		],
	},
	{
		id: 's3',
		intent: 'practice',
		startedAt: 300,
		turns: [
			{ role: 'user', text: 'Back to the restaurant please.' },
			{ role: 'tutor', text: '好的。你要点菜吗？' },
		],
	},
];

/** A store plus the raw list, so a test can inspect what was persisted. */
export function createTestStore(): MessageStore & { raw: Message[] } {
	const messages: Message[] = [];
	return {
		raw: messages,
		append(message) {
			messages.push(message);
		},
		all: () => [...messages].sort((a, b) => a.createdAt - b.createdAt),
	};
}

export type RecordedRequest = { systemPrompt: string; messages: Message[] };

/** A model that answers with a fixed reply and records every request verbatim. */
export function createRecordingModel(reply = '好的。That sounds good.'): {
	model: TutorModel;
	requests: RecordedRequest[];
} {
	const requests: RecordedRequest[] = [];
	const model: TutorModel = ({ systemPrompt, messages }) => {
		requests.push({
			systemPrompt,
			messages: messages.map((message) => ({ ...message })),
		});
		return (async function* () {
			yield reply;
		})();
	};
	return { model, requests };
}

/** Deterministic ids and clock, so a whole session run is reproducible. */
export function createCounters(): {
	generateId: () => string;
	now: () => number;
} {
	let id = 0;
	let time = 0;
	return {
		generateId: () => `m${++id}`,
		now: () => ++time,
	};
}
