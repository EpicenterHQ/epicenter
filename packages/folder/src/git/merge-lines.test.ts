/**
 * Line Merge Tests
 *
 * `mergeLines` splits lines at line feeds and keeps every character, so a
 * lone carriage return, U+2028, and U+2029 stay in their line; lines both
 * sides changed differently make the whole merge `undefined`.
 * `mergeLinesPreferring` gives those lines to one side and keeps every other
 * region from both, naming the lines it replaced.
 */
import { expect, test } from 'bun:test';
import { mergeLines, mergeLinesPreferring } from './merge-lines.js';

test('a line merge keeps lone carriage returns and Unicode line separators', async () => {
	expect(
		await mergeLines({
			base: 'x\u2028y\nmid\nz\n',
			ours: 'X\u2028y\nmid\nz\n',
			theirs: 'x\u2028y\nmid\nZ\n',
		}),
	).toBe('X\u2028y\nmid\nZ\n');
	expect(
		await mergeLines({
			base: 'x\ry\nmid\nz',
			ours: 'x\ry\nmid\nZ',
			theirs: 'X\ry\nmid\nz',
		}),
	).toBe('X\ry\nmid\nZ');
	expect(
		await mergeLines({ base: 'a\nb\n', ours: 'A\nb\n', theirs: 'a2\nb\n' }),
	).toBeUndefined();
});

const BASE = 'one\ntwo\nthree\nfour\nfive\n';

test('a preferring merge keeps both sides where they changed different lines', async () => {
	expect(
		await mergeLinesPreferring(
			{
				base: BASE,
				ours: 'one\ntwo\nthree\nfour\nFIVE (ours)\n',
				theirs: 'ONE (theirs)\ntwo\nthree\nfour\nfive\n',
			},
			'ours',
		),
	).toEqual({
		text: 'ONE (theirs)\ntwo\nthree\nfour\nFIVE (ours)\n',
		replaced: [],
	});
});

test('where both changed one line, the preferred side wins there and the other side keeps its other lines', async () => {
	const versions = {
		base: BASE,
		ours: 'one\ntwo\nTHREE (ours)\nfour\nfive\n',
		theirs: 'ONE (theirs)\ntwo\nTHREE (theirs)\nfour\nfive\n',
	};
	expect(await mergeLines(versions)).toBeUndefined();
	expect(await mergeLinesPreferring(versions, 'ours')).toEqual({
		text: 'ONE (theirs)\ntwo\nTHREE (ours)\nfour\nfive\n',
		replaced: ['THREE (theirs)\n'],
	});
	expect(await mergeLinesPreferring(versions, 'theirs')).toEqual({
		text: 'ONE (theirs)\ntwo\nTHREE (theirs)\nfour\nfive\n',
		replaced: ['THREE (ours)\n'],
	});
});
