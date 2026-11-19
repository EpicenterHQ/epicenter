import { expect, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import { defineAction, type Update } from './action.ts';
import { defineEpicenter } from './epicenter.ts';
import { field } from './field.ts';

const count = defineAction({
	description: 'Count to a number, saying each one',
	input: {
		to: field.integer({ min: 1 }),
		label: field.text({ optional: true }),
	},
	async run({ to, label = 'n' }, update: Update<{ at: number }>) {
		for (let at = 1; at <= to; at++) update({ at });
		return Ok(`${label}=${to}`);
	},
});

test('an action carries its description and its input as one JSON Schema object', () => {
	expect(count.description).toBe('Count to a number, saying each one');
	expect(JSON.parse(JSON.stringify(count.input))).toEqual({
		type: 'object',
		properties: {
			to: { type: 'integer', minimum: 1 },
			label: { type: 'string' },
		},
		required: ['to'],
		additionalProperties: false,
	});
});

test('run reports through update, and onUpdate hears each one before the answer', async () => {
	const heard: number[] = [];
	const answer = await count(
		{ to: 3 },
		{ onUpdate: ({ at }) => heard.push(at) },
	);
	expect(heard).toEqual([1, 2, 3]);
	expect(answer).toEqual(Ok('n=3'));
});

test('a listener that throws does not stop the action', async () => {
	const answer = await count(
		{ to: 2 },
		{
			onUpdate: () => {
				throw new Error('listener broke');
			},
		},
	);
	expect(answer).toEqual(Ok('n=2'));
});

test('an action that returns no Result throws when called', () => {
	const bare = defineAction({
		description: 'Forgets its Result',
		input: {},
		run: () => 'plain' as never,
	});
	expect(() => bare({})).toThrow('must return Ok(data) or Err(error)');
});

test('a definition is refused for what its types cannot say', () => {
	expect(() =>
		defineAction({
			description: 'Has a default',
			input: { limit: { type: 'number', default: 5 } as never },
			run: () => Ok(null),
		}),
	).toThrow('has a default in "limit"');
	expect(() =>
		defineAction({
			description: '',
			input: {},
			run: () => Ok(null),
			mcp: false,
		} as never),
	).toThrow('has "mcp", which an action does not take');
});

test('defineEpicenter refuses names that are not names, and serve', () => {
	const app = { description: 'Counts', actions: { count } };
	expect(defineEpicenter({ apps: { counter: app } }).apps.counter).toBe(app);
	expect(() => defineEpicenter({ apps: { Counter: app } })).toThrow(
		'The app name "Counter" must be lowercase letters',
	);
	expect(() =>
		// @ts-expect-error: serve is the command's own word.
		defineEpicenter({ apps: { serve: app } }),
	).toThrow('An app cannot be named serve');
	expect(() =>
		defineEpicenter({
			apps: {
				counter: { description: 'Counts', actions: { Count: count } },
			},
		}),
	).toThrow('has the action "Count", which must be lowercase letters');
	expect(() =>
		defineEpicenter({
			apps: {
				counter: {
					description: 'Counts',
					actions: { count: (() => Ok(1)) as never },
				},
			},
		}),
	).toThrow('apps.counter.actions.count is not an action');
});
