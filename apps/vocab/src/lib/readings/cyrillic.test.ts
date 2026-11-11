import { describe, expect, test } from 'bun:test';
import { transliterate } from 'transliteration';
import { createCyrillicRomanizer, cyrillicProvider } from './cyrillic.js';

const romanize = createCyrillicRomanizer(transliterate);

describe('cyrillicRomanizer', () => {
	test('segments cover the whole input in order, lossless', () => {
		const input = 'Привет, world!';
		expect(
			romanize(input)
				.map((s) => s.text)
				.join(''),
		).toBe(input);
	});

	test('a Cyrillic run gets a Latin reading; Latin passes through', () => {
		const segments = romanize('Привет world');
		const cyrillic = segments.find((s) => s.text === 'Привет');
		const latin = segments.find((s) => s.text.includes('world'));
		expect(cyrillic?.reading).toBe('Privet');
		expect(latin?.reading).toBeUndefined();
	});
});

describe('cyrillicProvider.matches', () => {
	test('claims Cyrillic, abstains otherwise', () => {
		expect(cyrillicProvider.matches('Привет')).toBe(true);
		expect(cyrillicProvider.matches('hello')).toBe(false);
		expect(cyrillicProvider.matches('你好')).toBe(false);
	});
});
