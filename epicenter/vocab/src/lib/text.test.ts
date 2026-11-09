import { describe, expect, test } from 'bun:test';
import { langOf, markTones, matches, untilLabel } from './text.js';

describe('markTones', () => {
	test('marks the a or e, the o of ou, or else the last vowel', () => {
		expect(markTones('ni3 hao3')).toBe('nǐ hǎo');
		expect(markTones('xie4xie5')).toBe('xièxie');
		expect(markTones('dou1')).toBe('dōu');
		expect(markTones('gui4')).toBe('guì');
		expect(markTones('liu2')).toBe('liú');
		expect(markTones('Zhong1guo2')).toBe('Zhōngguó');
	});

	test('reads v and u: as ü', () => {
		expect(markTones('nv3')).toBe('nǚ');
		expect(markTones('lu:4')).toBe('lǜ');
		expect(markTones('lv')).toBe('lv');
	});

	test('leaves text without tone numbers alone', () => {
		expect(markTones('nǐ hǎo')).toBe('nǐ hǎo');
		expect(markTones('room 101')).toBe('room 101');
	});
});

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
