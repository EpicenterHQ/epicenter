/**
 * Line Merge Tests
 *
 * `mergeLines` splits lines at line feeds and keeps every character, so a
 * lone carriage return, U+2028, and U+2029 stay in their line. One pass
 * answers both sides: `ours` wins every region both sides changed
 * differently, `theirs` wins them, and each keeps every other change of both.
 * Changes to neighboring lines do not compete, and both are kept. Two
 * different insertions at one place both survive, theirs first; identical
 * ones, and one that extends the other, are one.
 */
import { expect, test } from 'bun:test';
import { mergeLines } from './merge-lines.js';

/** The merge when nothing competes, checking that both sides agree. */
async function clean(versions: Parameters<typeof mergeLines>[0]) {
	const merged = await mergeLines(versions);
	expect(merged.regions).toEqual([]);
	expect(merged.theirs).toBe(merged.ours);
	return merged.ours;
}

test('a line merge keeps lone carriage returns and Unicode line separators', async () => {
	expect(
		await clean({
			base: 'x y\nmid\nz\n',
			ours: 'X y\nmid\nz\n',
			theirs: 'x y\nmid\nZ\n',
		}),
	).toBe('X y\nmid\nZ\n');
	expect(
		await clean({
			base: 'x\ry\nmid\nz',
			ours: 'x\ry\nmid\nZ',
			theirs: 'X\ry\nmid\nz',
		}),
	).toBe('X\ry\nmid\nZ');
});

const BASE = 'one\ntwo\nthree\nfour\nfive\n';

test('changes to different lines merge on both sides', async () => {
	expect(
		await clean({
			base: BASE,
			ours: 'one\ntwo\nthree\nfour\nFIVE (ours)\n',
			theirs: 'ONE (theirs)\ntwo\nthree\nfour\nfive\n',
		}),
	).toBe('ONE (theirs)\ntwo\nthree\nfour\nFIVE (ours)\n');
});

test("where both changed one line, each side wins there and keeps the other side's other lines", async () => {
	expect(
		await mergeLines({
			base: BASE,
			ours: 'one\ntwo\nTHREE (ours)\nfour\nFIVE (ours)\n',
			theirs: 'ONE (theirs)\ntwo\nTHREE (theirs)\nfour\nfive\n',
		}),
	).toEqual({
		ours: 'ONE (theirs)\ntwo\nTHREE (ours)\nfour\nFIVE (ours)\n',
		theirs: 'ONE (theirs)\ntwo\nTHREE (theirs)\nfour\nFIVE (ours)\n',
		regions: [{ line: 2, kept: 'THREE (ours)\n', theirs: 'THREE (theirs)\n' }],
	});
});

test('changes to neighboring lines do not compete: both are kept', async () => {
	expect(
		await clean({
			base: BASE,
			ours: 'ONE (ours)\ntwo\nthree\nfour\nfive\n',
			theirs: 'one\nTWO (theirs)\nthree\nfour\nfive\n',
		}),
	).toBe('ONE (ours)\nTWO (theirs)\nthree\nfour\nfive\n');
	// A removal next to an edit, and an insertion after an edited line.
	expect(
		await clean({
			base: BASE,
			ours: 'one\nthree\nfour\nfive\n',
			theirs: 'one\ntwo\nTHREE (theirs)\nadded\nfour\nfive\n',
		}),
	).toBe('one\nTHREE (theirs)\nadded\nfour\nfive\n');
});

test('two insertions at one place both survive, theirs first', async () => {
	expect(
		await clean({
			base: BASE,
			ours: 'one\napple\ntwo\nthree\nfour\nfive\n',
			theirs: 'one\nzebra\ntwo\nthree\nfour\nfive\n',
		}),
	).toBe('one\nzebra\napple\ntwo\nthree\nfour\nfive\n');
});

test('an insertion that extends the other at one place stands alone', async () => {
	for (const [ours, theirs, merged] of [
		['a\nx\n', 'a\nx\ny\n', 'a\nx\ny\n'],
		['a\nx\ny\n', 'a\nx\n', 'a\nx\ny\n'],
		['a\nx\n', 'a\nw\nx\n', 'a\nw\nx\n'],
		['a\nx\n', 'a\nx\nx\n', 'a\nx\nx\n'],
	] as const)
		expect(await clean({ base: 'a\n', ours, theirs })).toBe(merged);
});

test('a result ends with a line feed as the version its last line came from', async () => {
	// A side cleared to no text says nothing about the line feed.
	expect(await clean({ base: 'a\n', ours: '', theirs: 'a\nb\n' })).toBe(
		'b\n',
	);
	// Text typed with no line feed yet does not take the other side's away.
	expect(
		await clean({ base: 'A\n', ours: 'A\nHel', theirs: 'A\nX\n' }),
	).toBe('A\nX\nHel');
	expect(
		await clean({ base: 'A\n', ours: 'A\nX\n', theirs: 'A\nHel' }),
	).toBe('A\nHel\nX\n');
});

test('identical insertions at one place are one', async () => {
	expect(
		await clean({
			base: '',
			ours: 'The answer.\n',
			theirs: 'The answer.\n',
		}),
	).toBe('The answer.\n');
});

test('appends to a text with no line feed at its end both survive', async () => {
	expect(
		await clean({ base: 'hello', ours: 'hello\nmine', theirs: 'hello\nyours' }),
	).toBe('hello\nyours\nmine');
	// The final line feed is the last line's: replacing that line replaces it.
	expect(await clean({ base: 'a\nb', ours: 'a\nb\n', theirs: 'a\nB' })).toBe(
		'a\nB',
	);
});

test('an insertion beside a replacement of the lines after it is not one region', async () => {
	expect(
		await clean({
			base: BASE,
			ours: 'one\nadded\ntwo\nthree\nfour\nfive\n',
			theirs: 'one\nTWO\nthree\nfour\nfive\n',
		}),
	).toBe('one\nadded\nTWO\nthree\nfour\nfive\n');
});
