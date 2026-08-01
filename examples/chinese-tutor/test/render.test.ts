/**
 * Derived rendering: deterministic, lossless, and never written down.
 *
 * The three claims under test are the ones that make the overlay cheap. It is
 * pure (same message, same tokens, every time). It is lossless (the tokens
 * reconstruct the message exactly, so nothing downstream has to strip anything).
 * And it is derived (the store still holds the clean text after a full session).
 */

import { describe, expect, test } from 'bun:test';
import { renderMessage, tokensToText } from '../src/render.ts';
import type { SavedPhrase } from '../src/saved.ts';
import { openSession } from '../src/session.ts';
import { createTutorSession } from '../src/tutor.ts';
import {
	createCounters,
	createRecordingModel,
	createTestStore,
	PHRASES,
	SESSIONS,
} from './fixtures.ts';

const MIXED = '你好！The word 学习 means to study. 我们开始吧。';

const phrase = (text: string, stage: SavedPhrase['stage']): SavedPhrase => ({
	id: text,
	text,
	note: '',
	stage,
	createdAt: 1,
});

describe('pinyin is deterministic', () => {
	test('the same message renders identically every time', () => {
		expect(renderMessage(MIXED)).toEqual(renderMessage(MIXED));
	});

	test('readings sit over single Han characters', () => {
		const tokens = renderMessage('学习');
		expect(tokens).toEqual([
			{ text: '学', pinyin: 'xué' },
			{ text: '习', pinyin: 'xí' },
		]);
	});

	test('non-Han passes through unread, as one token per run', () => {
		const tokens = renderMessage('ok 你好 fine');
		expect(tokens.map((token) => token.text)).toEqual([
			'ok ',
			'你',
			'好',
			' fine',
		]);
		expect(tokens[0]?.pinyin).toBeUndefined();
		expect(tokens[3]?.pinyin).toBeUndefined();
	});

	test('turning readings off leaves the text whole', () => {
		const tokens = renderMessage(MIXED, { pinyin: false });
		expect(tokens).toEqual([{ text: MIXED }]);
	});

	test('an empty message renders to no tokens', () => {
		expect(renderMessage('')).toEqual([]);
	});
});

describe('rendering is lossless', () => {
	const inputs = [
		MIXED,
		'',
		'no chinese at all',
		'标点符号，测试！',
		'混合 mixed 文本 text 结束',
	];

	test('tokens reconstruct the message under every combination of overlays', () => {
		const phrases = [phrase('学习', 'new'), phrase('你好', 'understood')];
		for (const input of inputs) {
			for (const options of [
				{},
				{ pinyin: false },
				{ phrases },
				{ pinyin: false, phrases },
			]) {
				expect(tokensToText(renderMessage(input, options))).toBe(input);
			}
		}
	});
});

describe('phrase highlighting is optional and composes', () => {
	test('no phrases means no highlight fields', () => {
		for (const token of renderMessage(MIXED)) {
			expect(token.phrase).toBeUndefined();
		}
	});

	test('a matched phrase marks every character it covers, and keeps its reading', () => {
		const tokens = renderMessage('我要学习中文', {
			phrases: [phrase('学习', 'new')],
		});
		expect(tokens).toEqual([
			{ text: '我', pinyin: 'wǒ' },
			{ text: '要', pinyin: 'yào' },
			{ text: '学', pinyin: 'xué', phrase: phrase('学习', 'new') },
			{ text: '习', pinyin: 'xí', phrase: phrase('学习', 'new') },
			{ text: '中', pinyin: 'zhōng' },
			{ text: '文', pinyin: 'wén' },
		]);
	});

	test('the longest saved phrase wins at each position', () => {
		const tokens = renderMessage('学习', {
			phrases: [phrase('学', 'new'), phrase('学习', 'understood')],
		});
		expect(tokens.map((token) => token.phrase?.text)).toEqual(['学习', '学习']);
	});

	test('the stage travels with the token, so a stage change re-renders for free', () => {
		const asNew = renderMessage('学习', { phrases: [phrase('学习', 'new')] });
		const asUsable = renderMessage('学习', {
			phrases: [phrase('学习', 'usable')],
		});
		expect(asNew[0]?.phrase?.stage).toBe('new');
		expect(asUsable[0]?.phrase?.stage).toBe('usable');
		expect(tokensToText(asNew)).toBe(tokensToText(asUsable));
	});
});

describe('annotations are never persisted', () => {
	test('a driven session stores exactly the clean text the tutor wrote', async () => {
		const reply = '你好！很高兴见到你。Nice to meet you.';
		const seed = openSession({ intent: 'chat' }, {
			phrases: PHRASES,
			sessions: SESSIONS,
		});
		const store = createTestStore();
		const { model } = createRecordingModel(reply);
		const session = createTutorSession({
			seed,
			model,
			store,
			...createCounters(),
		});

		await session.send('你好');

		const tutorTurn = store.all().find((message) => message.role === 'tutor');
		expect(tutorTurn?.text).toBe(reply);
		// The overlay exists only as a view over that stored text.
		const rendered = renderMessage(tutorTurn?.text ?? '', { phrases: PHRASES });
		expect(rendered.some((token) => token.pinyin !== undefined)).toBe(true);
		expect(tokensToText(rendered)).toBe(reply);
		// And it never travels back to the model.
		expect(tutorTurn?.text).not.toContain('nǐ');
	});
});
