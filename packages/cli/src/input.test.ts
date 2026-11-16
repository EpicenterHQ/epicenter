/** An action's command-line input is one JSON object, checked as a page's or an agent's is (ADR-0925). */

import { expect, test } from 'bun:test';
import { defineAction, defineCollection, field } from '@epicenter/app';
import { Type } from 'typebox';
import { checkInput, matchAction, readInput, usageLine } from './input.ts';
import { actionHelp } from './listing.ts';

test('action matching stops at the first word that cannot name an action', () => {
	const actions = { log: {}, 'calendar show': {}, 'calendar add': {} };
	expect(matchAction(actions, ['log', '{"minutes":3}'])).toEqual({
		key: 'log',
		rest: ['{"minutes":3}'],
	});
	expect(matchAction(actions, ['calendar', 'show', '-'])).toEqual({
		key: 'calendar show',
		rest: ['-'],
	});
	expect(matchAction(actions, ['--json'])).toBeUndefined();
});

const add = defineAction({
	description: 'Add a task to do',
	input: {
		title: field.text({ description: 'What to do' }),
		due: field.date({ optional: true, description: 'The day it is due' }),
	},
	run: (input) => input,
});

test('no input is the empty object', async () => {
	const list = defineAction({
		description: 'List',
		input: { tag: field.text({ optional: true }) },
		run: () => [],
	});
	expect(await readInput(list, [])).toEqual({ ok: true, input: {} });
	expect(await readInput(add, [])).toEqual({ error: 'title is needed' });
});

test('one word is the JSON object, checked against the schema', async () => {
	expect(
		await readInput(add, ['{"title":"Call the bank","due":"2026-11-12"}']),
	).toEqual({
		ok: true,
		input: { title: 'Call the bank', due: '2026-11-12' },
	});
	expect(await readInput(add, ['{"title":"x","due":"soon"}'])).toEqual({
		error: 'due must be a day like 2026-11-12',
	});
});

test('text that is not JSON, or JSON that is not an object, is refused with an example', async () => {
	for (const word of ['Call the bank', '{title:"x"}', '--title'])
		expect(await readInput(add, [word])).toEqual({
			error: `The input is not JSON; give one JSON object, such as '{"title":"text"}'`,
		});
	for (const word of ['"Call the bank"', '3', 'null', '[]'])
		expect(await readInput(add, [word])).toEqual({
			error: `The input is not a JSON object; give one, such as '{"title":"text"}'`,
		});
});

test('two or more words are refused: the input is one argument', async () => {
	for (const rest of [
		['{"title":"a"}', '{"due":"2026-11-12"}'],
		['--input', '{"title":"a"}'],
		['-', '-'],
	])
		expect(await readInput(add, rest)).toEqual({
			error: `The input is one argument, a JSON object such as '{"title":"text"}'; quote it whole`,
		});
});

test('a key the action does not take is refused, naming the keys it takes', () => {
	expect(checkInput(add, { title: 'x', titel: 'y' })).toEqual({
		error: '"titel" is not a key this action takes; it takes title, due',
	});
	const sync = defineAction({ description: 'Sync', input: {}, run: () => 1 });
	expect(checkInput(sync, { all: true })).toEqual({
		error: '"all" is not a key this action takes; it takes none',
	});
});

test('no field name is reserved: json, help, and input are keys like any other', async () => {
	const show = defineAction({
		description: 'Show',
		input: {
			json: field.boolean(),
			help: field.text({ optional: true }),
			input: field.text({ optional: true }),
		},
		run: (input) => input,
	});
	expect(
		await readInput(show, ['{"json":true,"help":"h","input":"i"}']),
	).toEqual({ ok: true, input: { json: true, help: 'h', input: 'i' } });
});

test("a pattern's refusal reads as its field's description, after must be", () => {
	const line = defineAction({
		description: 'Add',
		input: {
			title: field.text({
				pattern: '^[^\\r\\n]*\\S[^\\r\\n]*$',
				description: 'one line, not blank',
			}),
		},
		run: ({ title }) => title,
	});
	expect(checkInput(line, { title: 'a\nb' })).toEqual({
		error: 'title must be one line, not blank',
	});
	expect(checkInput(line, { title: 'one line' })).toEqual({
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
	expect(checkInput(rate, { stars: 9, pages: 1 })).toEqual({
		error: 'stars must be a whole number from 1 to 5',
	});
	expect(checkInput(rate, { stars: 2, pages: -1 })).toEqual({
		error: 'pages must be a number of at least 0',
	});
});

const shelves = defineCollection({
	path: 'data/shelves/{shelf}.md',
	fields: {},
});

test('every input shape works: lists of objects, and a reference checked as text only', async () => {
	const invite = defineAction({
		description: 'Invite',
		input: {
			people: field.list(Type.Object({ name: Type.String() })),
			ratings: field.list(field.integer({ min: 1, max: 5 })),
			shelf: field.ref(shelves, { optional: true }),
		},
		run: (input) => input,
	});
	expect(
		await readInput(invite, [
			'{"people":[{"name":"Ada"}],"ratings":[4,5],"shelf":"no-such-shelf"}',
		]),
	).toEqual({
		ok: true,
		input: {
			people: [{ name: 'Ada' }],
			ratings: [4, 5],
			shelf: 'no-such-shelf',
		},
	});
	expect(await readInput(invite, ['{"ratings":[9]}'])).toEqual({
		error: 'ratings must be a list, each a whole number from 1 to 5',
	});
});

test('help lists the keys and prints one example to copy', () => {
	expect(usageLine('tasks', 'add', add)).toBe('epicenter tasks add <input>');
	expect(actionHelp('tasks', 'add', add)).toBe(`epicenter tasks add <input>
Add a task to do

Input, one JSON object, or - to read it from stdin:
  title  required  text. What to do
  due    optional  a day like 2026-11-12. The day it is due

Example:
  epicenter tasks add '{"title":"text"}'`);
});

test('a list with min is required: help says its minimum, its example has an item, and too few is refused', () => {
	const save = defineAction({
		description: 'Save a route',
		input: { airports: field.list(field.text(), { min: 1 }) },
		run: ({ airports }) => airports.length,
	});
	expect(
		actionHelp('flights', 'save', save),
	).toBe(`epicenter flights save <input>
Save a route

Input, one JSON object, or - to read it from stdin:
  airports  required  a list of text with at least 1 item

Example:
  epicenter flights save '{"airports":["text"]}'`);
	expect(checkInput(save, {})).toEqual({ error: 'airports is needed' });
	expect(checkInput(save, { airports: [] })).toEqual({
		error: 'airports must be a list of text with at least 1 item',
	});
});

test('help without required keys shows the input as optional and an example of its first key', () => {
	const list = defineAction({
		description: 'List tasks',
		input: {
			done: field.boolean(),
			tag: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		},
		run: () => [],
	});
	expect(actionHelp('tasks', 'list', list)).toBe(`epicenter tasks list [<input>]
List tasks

Input, one JSON object, or - to read it from stdin:
  done  optional  true or false
  tag   optional  text, or null

Example:
  epicenter tasks list '{"done":true}'`);
	const sync = defineAction({ description: 'Sync', input: {}, run: () => 1 });
	expect(actionHelp('mail', 'sync', sync)).toBe('epicenter mail sync\nSync');
});
