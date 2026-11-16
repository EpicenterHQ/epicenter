/** Action matching separates name words from values and flags; a refusal names the field as the caller gave it. */

import { expect, test } from 'bun:test';
import { defineAction, defineCollection, field } from '@epicenter/app';
import { Type } from 'typebox';
import { checkInput, matchAction, readInput, usageLine } from './input.ts';

test('action matching leaves negative numbers and dates as values and rejects leading flags', () => {
	const actions = { log: {}, 'calendar show': {}, 'calendar add': {} };
	expect(matchAction(actions, ['log', '-3'])).toEqual({
		key: 'log',
		rest: ['-3'],
	});
	expect(matchAction(actions, ['calendar', 'show', '2026-11-08'])).toEqual({
		key: 'calendar show',
		rest: ['2026-11-08'],
	});
	expect(matchAction(actions, ['--json'])).toBeUndefined();
});

test("a pattern's refusal reads as its field's description, after must be", () => {
	const add = defineAction({
		description: 'Add',
		input: {
			title: field.text({
				pattern: '^[^\\r\\n]*\\S[^\\r\\n]*$',
				description: 'one line, not blank',
			}),
		},
		run: ({ title }) => title,
	});
	const flag = (key: string) => `--${key}`;
	expect(checkInput(add, { title: 'a\nb' }, flag)).toEqual({
		error: '--title must be one line, not blank',
	});
	expect(checkInput(add, { title: 'one line' }, flag)).toEqual({
		ok: true,
		input: { title: 'one line' },
	});
});

test("a number's refusal names its bounds", () => {
	const rate = defineAction({
		description: 'Rate',
		input: {
			stars: field.integer({ min: 1, max: 5 }),
			pages: field.number({ min: 0 }),
		},
		run: ({ stars }) => stars,
	});
	const flag = (key: string) => `--${key}`;
	expect(checkInput(rate, { stars: 9, pages: 1 }, flag)).toEqual({
		error: '--stars must be a whole number from 1 to 5',
	});
	expect(checkInput(rate, { stars: 2, pages: -1 }, flag)).toEqual({
		error: '--pages must be a number of at least 0',
	});
});

const shelves = defineCollection({
	path: 'data/shelves/{shelf}.md',
	fields: {},
});

const shelve = defineAction({
	description: 'Shelve',
	input: {
		ratings: field.list(field.integer({ min: 1, max: 5 })),
		platforms: field.list(field.select(['x', 'threads'])),
		days: field.list(field.date()),
		shelf: field.ref(shelves, { optional: true }),
		shelves: field.list(field.ref(shelves)),
		tags: field.list(field.text()),
	},
	positional: ['tags'],
	run: (input) => input,
});

test('a list takes each item from a repeated flag, read as its item, and every word left as its last positional', async () => {
	expect(
		await readInput(shelve, [
			'--ratings',
			'4',
			'--ratings=5',
			'--platforms',
			'threads',
			'--days',
			'2026-11-08',
			'--shelf',
			'essays',
			'--shelves',
			'essays',
			'--shelves',
			'poems',
			'a',
			'b',
		]),
	).toEqual({
		ok: true,
		input: {
			ratings: [4, 5],
			platforms: ['threads'],
			days: ['2026-11-08'],
			shelf: 'essays',
			shelves: ['essays', 'poems'],
			tags: ['a', 'b'],
		},
	});
	expect(await readInput(shelve, [])).toEqual({
		ok: true,
		input: {},
	});
});

test('a list item that does not fit is refused by what each must be', async () => {
	expect(await readInput(shelve, ['--ratings', 'four'])).toEqual({
		error: '--ratings needs a number',
	});
	expect(await readInput(shelve, ['--ratings', '9'])).toEqual({
		error: '--ratings must be a list, each a whole number from 1 to 5',
	});
	expect(await readInput(shelve, ['--platforms', 'mastodon'])).toEqual({
		error: '--platforms must be a list, each one of x, threads',
	});
});

test('a list the command line cannot spell is refused as flags and taken in --input', async () => {
	const invite = defineAction({
		description: 'Invite',
		input: { people: field.list(Type.Object({ name: Type.String() })) },
		run: (input) => input,
	});
	expect(await readInput(invite, ['--people', 'Ada'])).toEqual({
		error:
			'--people is a list the command line cannot spell; give the whole input as one JSON object with --input',
	});
	expect(
		await readInput(invite, ['--input', '{"people":[{"name":"Ada"}]}']),
	).toEqual({ ok: true, input: { people: [{ name: 'Ada' }] } });
	expect(usageLine('party', 'invite', invite)).toBe(
		'epicenter party invite [--people (only in --input)]',
	);
	expect(usageLine('books', 'shelve', shelve)).toBe(
		'epicenter books shelve [<tags>...] [--ratings <number>...] [--platforms <x|threads>...] [--days <date>...] [--shelf <text>] [--shelves <text>...]',
	);
});

test('a reference in an action input is checked as text only', async () => {
	expect(await readInput(shelve, ['--shelf', 'no-such-shelf'])).toEqual({
		ok: true,
		input: { shelf: 'no-such-shelf' },
	});
});
