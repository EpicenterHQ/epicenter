/**
 * Entry Candidate Tests
 *
 * Verifies the model prompt and parser that turn one settled tutor message into
 * transient savable entry candidates.
 *
 * Key behaviors:
 * - Prompt requests English spans only
 * - Parser accepts clean one-span-per-line output
 * - Parser strips common model formatting without inventing entries
 */
import { describe, expect, test } from 'bun:test';
import { ENTRY_CANDIDATE_PROMPT, parseEntryCandidates } from './candidates.js';

describe('ENTRY_CANDIDATE_PROMPT', () => {
	test('asks for English expressions without importing multilingual readings', () => {
		const prompt = ENTRY_CANDIDATE_PROMPT.toLowerCase();
		expect(prompt).toContain('english');
		for (const leak of ['chinese', 'mandarin', 'pinyin', '简体']) {
			expect(prompt).not.toContain(leak);
		}
	});

	test('asks for spans only, no meaning or gloss', () => {
		const prompt = ENTRY_CANDIDATE_PROMPT.toLowerCase();
		expect(prompt).toContain('one span per line');
		expect(prompt).toContain('do not add a meaning');
	});
});

describe('parseEntryCandidates', () => {
	test('clean one-span-per-line input passes through verbatim, in order', () => {
		const raw = 'lucid\nby and large\nsubtle';
		expect(parseEntryCandidates(raw)).toEqual([
			'lucid',
			'by and large',
			'subtle',
		]);
	});

	test('preserves inner spacing of a legitimate multi-word phrase', () => {
		expect(parseEntryCandidates('by and large')).toEqual(['by and large']);
	});

	test('does not split a hyphenated word without surrounding spaces', () => {
		expect(parseEntryCandidates('state-of-the-art')).toEqual([
			'state-of-the-art',
		]);
	});

	test('strips numbered list markers', () => {
		const raw = '1. lucid\n2) subtle\n3. articulate';
		expect(parseEntryCandidates(raw)).toEqual([
			'lucid',
			'subtle',
			'articulate',
		]);
	});

	test('strips bullet markers (-, *, •)', () => {
		const raw = '- lucid\n* subtle\n• articulate';
		expect(parseEntryCandidates(raw)).toEqual([
			'lucid',
			'subtle',
			'articulate',
		]);
	});

	test('recovers the span when the model appends a gloss', () => {
		const raw = 'lucid - clear\nsubtle — hard to notice';
		expect(parseEntryCandidates(raw)).toEqual(['lucid', 'subtle']);
	});

	test('recovers the span before a colon gloss', () => {
		const raw = 'lucid: clear\nsubtle: hard to notice';
		expect(parseEntryCandidates(raw)).toEqual(['lucid', 'subtle']);
	});

	test('drops header and preamble lines ending in a colon', () => {
		const raw = 'Vocabulary:\nlucid\nsubtle\nWords:';
		expect(parseEntryCandidates(raw)).toEqual(['lucid', 'subtle']);
	});

	test('strips markdown emphasis and backtick wrapping', () => {
		const raw = '**lucid**\n`subtle`\n*articulate*';
		expect(parseEntryCandidates(raw)).toEqual([
			'lucid',
			'subtle',
			'articulate',
		]);
	});

	test('drops code-fence lines and blank lines', () => {
		const raw = '```\nlucid\n\nsubtle\n```';
		expect(parseEntryCandidates(raw)).toEqual(['lucid', 'subtle']);
	});

	test('dedupes to the first occurrence, order preserved', () => {
		const raw = 'lucid\nsubtle\nlucid\narticulate\nsubtle';
		expect(parseEntryCandidates(raw)).toEqual([
			'lucid',
			'subtle',
			'articulate',
		]);
	});

	test('empty or whitespace-only input yields no candidates', () => {
		expect(parseEntryCandidates('')).toEqual([]);
		expect(parseEntryCandidates('\n  \n\t\n')).toEqual([]);
	});

	test('handles a numbered list that also carries a gloss', () => {
		const raw = '1. lucid - clear\n2. subtle - hard to notice';
		expect(parseEntryCandidates(raw)).toEqual(['lucid', 'subtle']);
	});
});
