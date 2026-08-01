import { describe, expect, test } from 'bun:test';
import { pinyin } from 'pinyin-pro';
import { createPinyinRomanizer, resolveRomanizer } from './readings.js';

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

	test('Chinese characters get a reading; everything else does not', () => {
		const segments = pinyinRomanizer('你 a');
		expect(segments.find((s) => s.text === '你')?.reading).toBeTruthy();
		expect(segments.find((s) => s.text.includes('a'))?.reading).toBeUndefined();
	});

	test('one segment per Chinese character (per-character ruby)', () => {
		const chinese = pinyinRomanizer('你好').filter((s) => s.reading);
		expect(chinese).toHaveLength(2);
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

describe('resolveRomanizer', () => {
	test('Chinese text resolves to a romanizer that reads Han', async () => {
		const romanize = await resolveRomanizer('你好');
		expect(romanize('你好').find((s) => s.text === '你')?.reading).toBeTruthy();
	});

	test('all-Latin text resolves to identity (no readings)', async () => {
		const romanize = await resolveRomanizer('hello world');
		expect(romanize('hello world')).toEqual([{ text: 'hello world' }]);
	});

	// The abstain guard is what keeps the pinyin dictionary away from a passage
	// whose Han is Japanese or Korean. A missing reading beats a wrong one.
	test('kana- or hangul-bearing text resolves to identity, Han and all', async () => {
		for (const input of ['今日は学校に行きます', '한국어 학교']) {
			const romanize = await resolveRomanizer(input);
			expect(romanize(input)).toEqual([{ text: input }]);
		}
	});

	test('the resolved romanizer is shared, not rebuilt per message', async () => {
		expect(await resolveRomanizer('你好')).toBe(await resolveRomanizer('世界'));
	});
});
