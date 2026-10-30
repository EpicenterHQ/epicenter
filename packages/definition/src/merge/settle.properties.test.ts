/**
 * Settle Properties
 *
 * Seeded random edits of notes written in house style, settled as the server
 * and the merge driver settle them. Examples pin each rule; these show the
 * rules hold together over thousands of field and body edits, including body
 * lines that look like fences, keys or conflict delimiters.
 *
 * Key behaviors:
 * - The output always parses, and is in house style
 * - No field is lost: each key ends as the per-key rule says (one side's change lands, the later arrival wins a clash, an edit beats a delete)
 * - Conflict blocks are only in the body, are whole lines of each side, and number at most one per clash
 * - Edits of different words on one line merge with no block (decision 43 shapes a block, it adds none)
 * - Two different insertions at one spot, of words or of lines, always make a block (decision 15, as in diff3)
 * - Two creates keep the first note's fields and the second note whole in one block
 *
 * See also:
 * - `settle.sync.test.ts` for the cases spike 7 ran through Git
 * - `merge.test.ts` for the line merge's own examples and token properties
 */
import { describe, expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import {
	formatNote,
	formatRowSource,
	frameRowText,
	parseRowSource,
	sameValue,
} from '../note/index.js';
import { findConflicts } from './conflict.js';
import { merge } from './merge.js';
import { settle } from './settle.js';

const parties = {
	current: { author: 'alice', time: 't1' },
	incoming: { author: 'bob', time: 't2' },
};
const KEYS = ['title', 'mood', 'tags', 'count', 'meta'];
const VALUES: unknown[] = [
	'a',
	'two words',
	'x: y',
	'---',
	'line one\nline two\n',
	1,
	0,
	true,
	null,
	[1, 2],
	['a'],
	{ n: 1 },
	{ n: 2, m: [1] },
];
/** Body lines that look like fences, keys, list items or conflict delimiters, beside plain ones. */
const LINES = [
	'plain words',
	'other words',
	'',
	'---',
	'a: 1',
	'title: x',
	'- item',
	'# Heading',
	'<<<<<<< x',
	'=======',
	'alpha beta gamma delta',
	'one two three',
];
/** Words a word edit writes into a line. */
const WORDS = ['alpha', 'beta', 'zeta', 'two', 'four', 'x:'];

let state = 0x9e3779b9;
const next = () => {
	state ^= state << 13;
	state ^= state >>> 17;
	state ^= state << 5;
	return (state >>> 0) / 2 ** 32;
};
const choose = <T>(items: readonly T[]) =>
	items[Math.floor(next() * items.length)] as T;

type Note = { fields: Record<string, unknown>; lines: string[] };

const write = ({ fields, lines }: Note) =>
	expectOk(
		formatRowSource(
			{ fields, body: lines.map((line) => `${line}\n`).join('') },
			KEYS,
		),
	).text;

const randomNote = (): Note => ({
	fields: Object.fromEntries(
		KEYS.filter(() => next() < 0.5).map((key) => [key, choose(VALUES)]),
	),
	lines: Array.from({ length: Math.floor(next() * 6) }, () => choose(LINES)),
});

/** One side's edit: fields set or removed, body lines inserted, removed or replaced. */
function edited(note: Note): Note {
	const fields = { ...note.fields };
	const lines = [...note.lines];
	for (let n = 1 + Math.floor(next() * 3); n > 0; n--) {
		const roll = next();
		const at = Math.floor(next() * (lines.length + 1));
		if (roll < 0.25) fields[choose(KEYS)] = choose(VALUES);
		else if (roll < 0.35) delete fields[choose(KEYS)];
		else if (roll < 0.5 && lines.length > 0) {
			// A word edit: one word of a line replaced, the rest of the line kept.
			const index = Math.min(at, lines.length - 1);
			const words = (lines[index] ?? '').split(' ');
			words[Math.floor(next() * words.length)] = choose(WORDS);
			lines[index] = words.join(' ');
		} else if (roll < 0.65) lines.splice(at, 0, choose(LINES));
		else if (lines.length > 0 && roll < 0.8)
			lines.splice(Math.min(at, lines.length - 1), 1);
		else if (lines.length > 0)
			lines[Math.min(at, lines.length - 1)] = choose(LINES);
	}
	return { fields, lines };
}

const fieldsOf = (text: string) =>
	expectOk(parseRowSource(text)).document.fields;

/** RULE (decision 28): what one key ends as. `undefined` is an absent key. */
function expectedValue(base: unknown, current: unknown, incoming: unknown) {
	if (sameValue(current, incoming) || sameValue(incoming, base)) return current;
	if (sameValue(current, base)) return incoming;
	// Both changed: the later arrival wins, unless it deleted a key the other side edited.
	return incoming === undefined ? current : incoming;
}

/** Where a note's body starts: after its front matter, or at 0 with none. */
const bodyStartOf = (text: string) => {
	const frame = frameRowText(text);
	return frame.kind === 'frontmatter' ? frame.bodyStart : 0;
};
const bodyOf = (text: string) => text.slice(bodyStartOf(text));

const ROUNDS = 4_000;

describe('settle over random edits', () => {
	test('the output parses, is in house style, and loses no field', () => {
		for (let k = 0; k < ROUNDS; k++) {
			const base = randomNote();
			const [b, c, i] = [base, edited(base), edited(base)].map(write) as [
				string,
				string,
				string,
			];
			const { text } = settle(b, c, i, { parties, keys: KEYS });
			const context = JSON.stringify({ b, c, i, text });
			if (text === null) throw new Error(`no text: ${context}`);
			const parsed = parseRowSource(text);
			if (parsed.error !== null)
				throw new Error(`does not parse: ${parsed.error.reason} ${context}`);
			expect(expectOk(formatNote(text, KEYS))).toBe(text);
			const [bf, cf, inf, out] = [b, c, i, text].map(fieldsOf) as [
				Record<string, unknown>,
				Record<string, unknown>,
				Record<string, unknown>,
				Record<string, unknown>,
			];
			for (const key of KEYS) {
				const want = expectedValue(bf[key], cf[key], inf[key]);
				if (!sameValue(out[key], want))
					throw new Error(`key ${key} lost: ${context}`);
			}
		}
	});

	test('blocks are only in the body, whole lines of each side, and at most one per clash', () => {
		let blocks = 0;
		for (let k = 0; k < ROUNDS; k++) {
			const base = randomNote();
			const [b, c, i] = [base, edited(base), edited(base)].map(write) as [
				string,
				string,
				string,
			];
			const text = settle(b, c, i, { parties, keys: KEYS }).text ?? '';
			const context = JSON.stringify({ b, c, i, text });
			const found = findConflicts(text);
			blocks += found.length;
			const clashes = merge(b, c, i).overlaps.filter(
				(o) => o.unit === 'body' || o.unit === 'block',
			).length;
			if (found.length > clashes)
				throw new Error(`more blocks than clashes: ${context}`);
			const bodyStart = bodyStartOf(text);
			for (const conflict of found) {
				const wholeLines =
					conflict.from >= bodyStart &&
					text[conflict.from - 1] === '\n' &&
					conflict.raw.endsWith('\n');
				const fromSides =
					bodyOf(c).includes(conflict.current) &&
					bodyOf(i).includes(conflict.incoming) &&
					bodyOf(b).includes(conflict.base) &&
					[conflict.current, conflict.base, conflict.incoming].every(
						(section) => section === '' || section.endsWith('\n'),
					);
				if (!wholeLines || !fromSides)
					throw new Error(
						`a block is not whole lines of its sides: ${context}`,
					);
			}
		}
		// The generator does reach clashes.
		expect(blocks).toBeGreaterThan(ROUNDS / 20);
	});

	test('two creates keep the first note and the second whole in one block', () => {
		for (let k = 0; k < ROUNDS / 4; k++) {
			const [c, i] = [write(randomNote()), write(randomNote())];
			const settled = settle(null, c, i, { parties, keys: KEYS });
			const text = settled.text ?? '';
			if (c === i) {
				expect(settled).toEqual({ text: c, blocks: false });
				continue;
			}
			expect(fieldsOf(text)).toEqual(fieldsOf(c));
			const found = findConflicts(text);
			expect(found).toHaveLength(1);
			expect(found[0]?.incoming).toBe(i);
		}
	});

	test('settle is deterministic', () => {
		for (let k = 0; k < ROUNDS / 4; k++) {
			const base = randomNote();
			const [b, c, i] = [base, edited(base), edited(base)].map(write) as [
				string,
				string,
				string,
			];
			expect(settle(b, c, i, { parties })).toEqual(
				settle(b, c, i, { parties }),
			);
		}
	});

	test('edits of different words on one line merge with no block', () => {
		for (let k = 0; k < ROUNDS; k++) {
			const words = Array.from(
				{ length: 2 + Math.floor(next() * 6) },
				(_, n) => `w${n}`,
			);
			const [j, m] = [
				Math.floor(next() * words.length),
				Math.floor(next() * words.length),
			];
			if (j === m) continue;
			const around = randomNote();
			const at = Math.floor(next() * (around.lines.length + 1));
			const withLine = (line: string[]): Note => ({
				fields: around.fields,
				lines: around.lines.toSpliced(at, 0, line.join(' ')),
			});
			const mine = words.with(j, 'mine');
			const theirs = words.with(m, 'theirs');
			const settled = settle(
				write(withLine(words)),
				write(withLine(mine)),
				write(withLine(theirs)),
				{ parties, keys: KEYS },
			);
			const both = words.with(j, 'mine').with(m, 'theirs').join(' ');
			if (settled.blocks || !bodyOf(settled.text ?? '').includes(`${both}\n`))
				throw new Error(
					`a clean word merge made a block or lost an edit: ${JSON.stringify({ words, j, m, text: settled.text })}`,
				);
		}
	});

	test('two different insertions at one spot always make a block', () => {
		let pairs = 0;
		for (let k = 0; k < ROUNDS; k++) {
			const base = randomNote();
			const at = Math.floor(next() * (base.lines.length + 1));
			const [mine, theirs] = [choose(LINES), choose(LINES)];
			// A copy of a neighbouring line is as well an insertion one line over: no single spot.
			const neighbours = [base.lines[at - 1], base.lines[at]];
			if (neighbours.includes(mine) || neighbours.includes(theirs)) continue;
			const words = base.lines[at - 1];
			const wordPair = next() < 0.5 && words !== undefined && words !== '';
			const [c, i] = wordPair
				? [`${words} ${choose(WORDS)}`, `${words} ${choose(WORDS)}`].map(
						(line): Note => ({
							fields: base.fields,
							lines: base.lines.with(at - 1, line),
						}),
					)
				: [mine, theirs].map(
						(line): Note => ({
							fields: base.fields,
							lines: base.lines.toSpliced(at, 0, line),
						}),
					);
			const [b, cText, iText] = [base, c as Note, i as Note].map(write) as [
				string,
				string,
				string,
			];
			if (cText === iText) continue;
			pairs++;
			const settled = settle(b, cText, iText, { parties, keys: KEYS });
			if (!settled.blocks)
				throw new Error(
					`a same-spot insertion pair merged with no block: ${JSON.stringify({ b, c: cText, i: iText, text: settled.text })}`,
				);
		}
		expect(pairs).toBeGreaterThan(ROUNDS / 3);
	});
});
