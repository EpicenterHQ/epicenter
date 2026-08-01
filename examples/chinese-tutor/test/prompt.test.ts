/**
 * Prompt composition: one persona plus at most one session block, and each
 * block says only what its own intent owns.
 */

import { describe, expect, test } from 'bun:test';
import {
	buildConversationBlock,
	buildPracticeBlock,
	buildRevisitBlock,
	composeSystemPrompt,
	countSessionBlocks,
	INTENT_BLOCK_HEADERS,
	TUTOR_PROMPT,
} from '../src/prompt.ts';
import { openSession } from '../src/session.ts';
import { PHRASES, SESSIONS } from './fixtures.ts';

const sources = { phrases: PHRASES, sessions: SESSIONS };

describe('the persona is shared', () => {
	test('every opening composes onto the same tutor prompt', () => {
		for (const request of [
			{ intent: 'chat' },
			{ intent: 'conversation' },
			{ intent: 'practice' },
			{ intent: 'revisit' },
		] as const) {
			const seed = openSession(request, sources);
			expect(seed.systemPrompt.startsWith(TUTOR_PROMPT)).toBe(true);
		}
	});

	test('the persona forbids readings, so the derived overlay stays possible', () => {
		expect(TUTOR_PROMPT).toContain('Never add pinyin');
	});
});

describe('chat is the default surface', () => {
	test('chat composes the bare persona with no block and no opening turn', () => {
		const seed = openSession({ intent: 'chat' }, sources);
		expect(seed.systemPrompt).toBe(TUTOR_PROMPT);
		expect(countSessionBlocks(seed.systemPrompt)).toBe(0);
		expect(seed.opening).toBeNull();
		expect(seed.focus).toEqual([]);
	});
});

describe('conversation follows the user', () => {
	test('the block names no phrases and forbids steering', () => {
		const block = buildConversationBlock();
		expect(block).toContain(INTENT_BLOCK_HEADERS.conversation);
		expect(block).toContain('Do not steer toward vocabulary');
		for (const phrase of PHRASES) {
			expect(block).not.toContain(phrase.text);
		}
	});

	test('the seed puts nothing in play even though the pool is full', () => {
		const seed = openSession({ intent: 'conversation' }, sources);
		expect(seed.focus).toEqual([]);
		expect(seed.opening).not.toBeNull();
	});
});

describe('practice deliberately uses targets', () => {
	test('stage splits the focus into introduce and elicit roles', () => {
		const block = buildPracticeBlock([
			{ id: 'a', text: '学习', note: '', stage: 'new', createdAt: 1 },
			{ id: 'b', text: '你好', note: '', stage: 'understood', createdAt: 2 },
		]);
		expect(block).toContain(INTENT_BLOCK_HEADERS.practice);
		expect(block).toContain('Introduce these in your own lines');
		expect(block).toContain('学习');
		expect(block).toContain('let them supply the phrase');
		expect(block).toContain('你好');
	});

	test('a role with no phrases contributes no line', () => {
		const block = buildPracticeBlock([
			{ id: 'a', text: '学习', note: '', stage: 'new', createdAt: 1 },
		]);
		expect(block).toContain('Introduce these in your own lines');
		expect(block).not.toContain('let them supply the phrase');
	});

	test('an empty pool degrades practice to plain chat rather than an empty list', () => {
		expect(buildPracticeBlock([])).toBeNull();
		const seed = openSession({ intent: 'practice' }, { ...sources, phrases: [] });
		expect(seed.systemPrompt).toBe(TUTOR_PROMPT);
		expect(seed.focus).toEqual([]);
	});
});

describe('revisit compiles prior context', () => {
	test('the block carries the excerpt and the phrases that occurred in it', () => {
		const seed = openSession({ intent: 'revisit', topic: 'restaurant' }, sources);
		expect(seed.systemPrompt).toContain(INTENT_BLOCK_HEADERS.revisit);
		expect(seed.systemPrompt).toContain('restaurant');
		expect(seed.systemPrompt).toContain('What was said before:');
		expect(seed.systemPrompt).toContain('点菜');
		expect(seed.revisited.map((session) => session.id)).toEqual(['s3', 's1']);
	});

	test('phrases alone are enough when there is no history', () => {
		const block = buildRevisitBlock({
			excerpt: '',
			focus: [{ id: 'a', text: '你好', note: '', stage: 'understood', createdAt: 1 }],
		});
		expect(block).toContain('你好');
		expect(block).not.toContain('What was said before:');
	});

	test('an empty revisit degrades to plain chat', () => {
		expect(buildRevisitBlock({ excerpt: '', focus: [] })).toBeNull();
		const seed = openSession({ intent: 'revisit' }, { phrases: [], sessions: [] });
		expect(seed.systemPrompt).toBe(TUTOR_PROMPT);
	});
});

describe('composition is structural', () => {
	test('composeSystemPrompt appends at most one block', () => {
		expect(countSessionBlocks(composeSystemPrompt(null))).toBe(0);
		expect(countSessionBlocks(composeSystemPrompt(buildConversationBlock()))).toBe(1);
	});
});
