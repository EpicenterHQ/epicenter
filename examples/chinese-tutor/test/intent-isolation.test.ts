/**
 * Intent isolation: an opening decides what a session is given, and nothing
 * else. Three properties, all falsifiable:
 *
 *  1. A composed prompt carries at most one session block, and only its own.
 *  2. A phrase reachable by one opening never appears in another's prompt.
 *  3. The engine behaves identically across intents. Feed two seeds the same
 *     user turn and every recorded request matches except the system prompt.
 */

import { describe, expect, test } from 'bun:test';
import { INTENT_BLOCK_HEADERS, countSessionBlocks } from '../src/prompt.ts';
import type { SessionRequest } from '../src/session.ts';
import { openSession } from '../src/session.ts';
import { createTutorSession } from '../src/tutor.ts';
import {
	createCounters,
	createRecordingModel,
	createTestStore,
	PHRASES,
	SESSIONS,
} from './fixtures.ts';

const sources = { phrases: PHRASES, sessions: SESSIONS };

const ALL_REQUESTS: SessionRequest[] = [
	{ intent: 'chat' },
	{ intent: 'conversation' },
	{ intent: 'practice' },
	{ intent: 'revisit', topic: 'restaurant' },
];

describe('one block per session', () => {
	test('every opening composes at most one session block', () => {
		for (const request of ALL_REQUESTS) {
			const seed = openSession(request, sources);
			expect(countSessionBlocks(seed.systemPrompt)).toBeLessThanOrEqual(1);
		}
	});

	test('a session never carries another opening’s header', () => {
		for (const request of ALL_REQUESTS) {
			const { systemPrompt } = openSession(request, sources);
			for (const [intent, header] of Object.entries(INTENT_BLOCK_HEADERS)) {
				expect(systemPrompt.includes(header)).toBe(intent === request.intent);
			}
		}
	});
});

describe('focus does not leak across openings', () => {
	// 学习 and 练习 appear in no past session, so Practice is the only opening
	// that can reach them.
	const practiceOnly = ['学习', '练习'];

	test('practice puts them in play', () => {
		const seed = openSession({ intent: 'practice' }, sources);
		const focusText = seed.focus.map((phrase) => phrase.text);
		for (const text of practiceOnly) expect(focusText).toContain(text);
	});

	test('no other opening names them', () => {
		for (const request of ALL_REQUESTS) {
			if (request.intent === 'practice') continue;
			const seed = openSession(request, sources);
			for (const text of practiceOnly) {
				expect(seed.systemPrompt).not.toContain(text);
			}
		}
	});

	test('chat and conversation put nothing in play at all', () => {
		for (const intent of ['chat', 'conversation'] as const) {
			expect(openSession({ intent }, sources).focus).toEqual([]);
		}
	});

	test('revisit reaches only what its own thread mentioned', () => {
		const seed = openSession({ intent: 'revisit', topic: 'restaurant' }, sources);
		expect(seed.focus.map((phrase) => phrase.text)).toEqual([
			'服务员',
			'点菜',
			'好吃',
		]);
	});

	test('a topical revisit reaches only phrases from that thread', () => {
		const seed = openSession({ intent: 'revisit', topic: 'weather' }, sources);
		expect(seed.revisited.map((session) => session.id)).toEqual(['s2']);
		for (const text of practiceOnly) {
			expect(seed.systemPrompt).not.toContain(text);
		}
	});
});

describe('targets stay in the system layer', () => {
	// The property is independence, not word-avoidance. An opening written in
	// natural Chinese will sometimes contain a word the learner happens to have
	// saved (the practice opening says 练习, which is in the pool). What matters
	// is that the target set cannot be read back out of the transcript, and that
	// requires the opening to be the same line whatever is in play.
	test('the opening turn does not depend on the focus set', () => {
		const other = [
			{ id: 'z', text: '咖啡', note: '', stage: 'new' as const, createdAt: 1 },
		];
		for (const request of ALL_REQUESTS) {
			const withPool = openSession(request, sources);
			const withOther = openSession(request, { ...sources, phrases: other });
			expect(withPool.opening).toBe(withOther.opening);
		}
	});

	test('a driven practice session persists no target list', async () => {
		const seed = openSession({ intent: 'practice' }, sources);
		const store = createTestStore();
		const { model, requests } = createRecordingModel();
		const session = createTutorSession({
			seed,
			model,
			store,
			...createCounters(),
		});

		await session.start();
		await session.send('好的，我们开始吧。');

		expect(requests).toHaveLength(2);
		// The block is re-sent every turn, and never written down.
		for (const request of requests) {
			expect(request.systemPrompt).toBe(seed.systemPrompt);
		}
		// The target set is not recoverable from what was written down: no block,
		// and no enumeration of the phrases.
		const transcript = store.all().map((message) => message.text).join('\n');
		expect(transcript).not.toContain(INTENT_BLOCK_HEADERS.practice);
		expect(transcript).not.toContain(
			seed.focus.map((phrase) => phrase.text).join('、'),
		);
		expect(seed.focus.filter((phrase) => transcript.includes(phrase.text))
			.length).toBeLessThan(seed.focus.length);
	});
});

describe('the engine is shared', () => {
	test('two intents produce identical requests except the system prompt', async () => {
		const drive = async (request: SessionRequest) => {
			const seed = openSession(request, sources);
			const store = createTestStore();
			const { model, requests } = createRecordingModel();
			const session = createTutorSession({
				seed,
				model,
				store,
				...createCounters(),
			});
			// Skip `start()` so both sessions send exactly the same user text.
			await session.send('你好！');
			return { seed, requests, messages: store.all() };
		};

		const practice = await drive({ intent: 'practice' });
		const conversation = await drive({ intent: 'conversation' });

		expect(practice.requests[0]?.messages).toEqual(
			conversation.requests[0]?.messages ?? [],
		);
		expect(practice.messages).toEqual(conversation.messages);
		expect(practice.requests[0]?.systemPrompt).not.toBe(
			conversation.requests[0]?.systemPrompt,
		);
	});

	test('chat has no opening turn, so start() sends nothing', async () => {
		const seed = openSession({ intent: 'chat' }, sources);
		const store = createTestStore();
		const { model, requests } = createRecordingModel();
		const session = createTutorSession({
			seed,
			model,
			store,
			...createCounters(),
		});

		await session.start();
		expect(requests).toHaveLength(0);
		expect(store.all()).toEqual([]);

		await session.send('你好');
		expect(store.all().map((message) => message.role)).toEqual([
			'user',
			'tutor',
		]);
	});

	test('a failed turn persists nothing but the durable user turn', async () => {
		const seed = openSession({ intent: 'chat' }, sources);
		const store = createTestStore();
		const session = createTutorSession({
			seed,
			store,
			model: () =>
				(async function* () {
					yield '好';
					throw new Error('stream died');
				})(),
			...createCounters(),
		});

		await session.send('你好');
		expect(store.all().map((message) => message.role)).toEqual(['user']);
		expect(session.snapshot().error).toBe('stream died');
		expect(session.snapshot().streaming).toBeNull();
	});
});
