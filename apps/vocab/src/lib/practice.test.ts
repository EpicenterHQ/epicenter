import { describe, expect, test } from 'bun:test';
import { buildPracticeOpening } from './practice.js';

describe('buildPracticeOpening: the opening turn', () => {
	test('lists each entry verbatim, one bullet per entry, in order', () => {
		const { opening } = buildPracticeOpening(['你好', '学习中文', 'chengyu']);
		expect(opening).toContain('- 你好\n- 学习中文\n- chengyu');
	});

	test('does not normalize or trim the given text', () => {
		const { opening } = buildPracticeOpening(['  spaced  phrase  ']);
		expect(opening).toContain('-   spaced  phrase  ');
	});

	test('handles a single entry', () => {
		expect(buildPracticeOpening(['你好']).opening).toContain('- 你好');
	});
});

describe('buildPracticeOpening: the conversation title', () => {
	test('names the chosen entries, so the conversation is findable later', () => {
		expect(buildPracticeOpening(['你好', '学习中文']).title).toBe(
			'Practice: 你好, 学习中文',
		);
	});

	test('summarizes the rest once past the named few', () => {
		expect(buildPracticeOpening(['一', '二', '三', '四', '五']).title).toBe(
			'Practice: 一, 二, 三 +2',
		);
	});

	test('two different selections do not collide in the conversation list', () => {
		expect(buildPracticeOpening(['你好', '再见']).title).not.toBe(
			buildPracticeOpening(['学习', '中文']).title,
		);
	});

	// The shared registry's auto-title only overwrites 'New Chat'. Colliding with
	// that placeholder would hand the conversation back to the auto-title and put
	// every practice session under the same generic name again.
	test('is never the blank-conversation placeholder', () => {
		expect(buildPracticeOpening(['你好']).title).not.toBe('New Chat');
		expect(buildPracticeOpening([]).title).not.toBe('New Chat');
	});

	test('trims for display without touching the verbatim opening turn', () => {
		const { title, opening } = buildPracticeOpening(['  你好  ']);
		expect(title).toBe('Practice: 你好');
		expect(opening).toContain('-   你好  ');
	});

	test('stays a usable label when nothing nameable was passed', () => {
		expect(buildPracticeOpening([]).title).toBe('Practice');
		expect(buildPracticeOpening(['   ']).title).toBe('Practice');
	});
});
