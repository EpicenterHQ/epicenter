import { describe, expect, test } from 'bun:test';
import { pinyin } from 'pinyin-pro';
import { createPinyinRomanizer, pinyinProvider } from './pinyin.js';

const pinyinRomanizer = createPinyinRomanizer(pinyin);

describe('pinyinRomanizer', () => {
	test('segments cover the whole input in order, lossless', () => {
		const input = 'Hello 你好, world 世界!';
		expect(
			pinyinRomanizer(input)
				.map((s) => s.text)
				.join(''),
		).toBe(input);
	});

	test('Chinese characters get their pinyin; everything else stays plain', () => {
		const segments = pinyinRomanizer('你好 a');
		expect(segments.slice(0, 2)).toEqual([
			{ text: '你', reading: 'nǐ' },
			{ text: '好', reading: 'hǎo' },
		]);
		expect(segments.find((s) => s.text.includes('a'))?.reading).toBeUndefined();
	});

	test('Japanese text (kana present) gets no readings, so shared Han never gets Mandarin', () => {
		// 今日 and 学校 are Han shared with Chinese; the kana は/に/き/ま/す mark the
		// run as Japanese, so the whole run passes through with no reading.
		const input = '今日は学校に行きます';
		expect(pinyinRomanizer(input)).toEqual([{ text: input }]);
	});

	test('Korean text (hangul present) gets no readings', () => {
		const input = '학교';
		expect(pinyinRomanizer(input)).toEqual([{ text: input }]);
	});
});

describe('pinyinProvider.matches', () => {
	test('claims Chinese, abstains on Latin and kana/hangul-bearing text', () => {
		expect(pinyinProvider.matches('你好')).toBe(true);
		expect(pinyinProvider.matches('hello world')).toBe(false);
		expect(pinyinProvider.matches('今日は')).toBe(false);
		expect(pinyinProvider.matches('학교')).toBe(false);
	});
});
