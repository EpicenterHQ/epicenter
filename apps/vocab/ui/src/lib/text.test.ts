import { describe, expect, test } from 'bun:test';
import { langOf, matches, untilLabel } from './text.js';

describe('matches', () => {
	const word = { word: '你好', reading: 'nǐ hǎo', meaning: 'Hello' };

	test('finds a word by its text, its reading without tones, or its meaning', () => {
		expect(matches(word, '你')).toBe(true);
		expect(matches(word, 'nihao')).toBe(true);
		expect(matches(word, 'ni3 hao3')).toBe(true);
		expect(matches(word, 'hell')).toBe(true);
		expect(matches(word, 'bye')).toBe(false);
		expect(matches(word, '  ')).toBe(true);
	});
});

test('langOf tags CJK scripts', () => {
	expect(langOf('你好')).toBe('zh');
	expect(langOf('食べる')).toBe('ja');
	expect(langOf('안녕')).toBe('ko');
	expect(langOf('hello')).toBeUndefined();
});

test('untilLabel says how long until a time', () => {
	const now = new Date('2026-11-10T12:00:00Z');
	const after = (ms: number) => new Date(now.getTime() + ms).toISOString();
	expect(untilLabel(after(-1), now)).toBe('now');
	expect(untilLabel(after(10 * 60_000), now)).toBe('10 min');
	expect(untilLabel(after(5 * 3_600_000), now)).toBe('5 h');
	expect(untilLabel(after(6 * 86_400_000), now)).toBe('6 d');
	expect(untilLabel(after(90 * 86_400_000), now)).toBe('3 mo');
});
