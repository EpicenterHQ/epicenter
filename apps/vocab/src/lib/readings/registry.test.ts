import { describe, expect, test } from 'bun:test';
import type { Romanizer } from '@epicenter/ui/markdown';
import { composeRomanizers, resolveRomanizer } from './registry.js';

// Fake single-letter providers, disjoint like the real script providers: one
// reads every 'a', one reads every 'b'.
const readsA: Romanizer = (text) =>
	text
		.split(/(a)/)
		.filter(Boolean)
		.map((t) => (t === 'a' ? { text: 'a', reading: 'A' } : { text: t }));
const readsB: Romanizer = (text) =>
	text
		.split(/(b)/)
		.filter(Boolean)
		.map((t) => (t === 'b' ? { text: 'b', reading: 'B' } : { text: t }));

describe('composeRomanizers', () => {
	test('each provider reads only the runs earlier ones left plain', () => {
		const romanize = composeRomanizers([readsA, readsB]);
		expect(romanize('cab')).toEqual([
			{ text: 'c' },
			{ text: 'a', reading: 'A' },
			{ text: 'b', reading: 'B' },
		]);
	});

	test('an empty registry is the identity romanizer', () => {
		expect(composeRomanizers([])('你好')).toEqual([{ text: '你好' }]);
	});

	test('lossless: segment text joins back to the input', () => {
		const romanize = composeRomanizers([readsA, readsB]);
		const input = 'a quick brown b';
		expect(
			romanize(input)
				.map((s) => s.text)
				.join(''),
		).toBe(input);
	});
});

describe('resolveRomanizer', () => {
	test('Chinese text resolves to the pinyin romanizer', async () => {
		const romanize = await resolveRomanizer('你好');
		expect(romanize('你好')).toEqual([
			{ text: '你', reading: 'nǐ' },
			{ text: '好', reading: 'hǎo' },
		]);
	});

	test('all-Latin text resolves to identity (no readings)', async () => {
		const romanize = await resolveRomanizer('hello world');
		expect(romanize('hello world')).toEqual([{ text: 'hello world' }]);
	});
});
