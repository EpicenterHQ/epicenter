import { expect, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import { defineAction, type Update } from './action.ts';
import { defineEpicenter, programProblems } from './epicenter.ts';
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

test('an action that returns no Result rejects when called', async () => {
	const bare = defineAction({
		description: 'Forgets its Result',
		input: {},
		run: () => 'plain' as never,
	});
	await expect(bare({})).rejects.toThrow('must return Ok(data) or Err(error)');
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
		defineAction({ description: ' ', input: {}, run: () => Ok(null) }),
	).toThrow('An action needs a description');
	expect(() => field.text({ pattern: '[' })).toThrow(
		'is not a regular expression',
	);
});

test('defineEpicenter refuses names that are not names, and what defineAction did not make', () => {
	const app = { description: 'Counts', actions: { count } };
	expect(defineEpicenter({ apps: { counter: app } }).apps.counter).toBe(app);
	expect(() => defineEpicenter({ apps: { Counter: app } })).toThrow(
		'The app name "Counter" must be lowercase letters',
	);
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
	expect(() => defineEpicenter({ apps: { serve: app } as never })).toThrow(
		'and not serve',
	);
});

test('serve checks what epicenter.ts exported as defineEpicenter would', () => {
	const app = { description: 'Counts', actions: { count } };
	expect(programProblems(defineEpicenter({ apps: { counter: app } }))).toEqual(
		[],
	);
	expect(programProblems({ counter: app })).toEqual([
		'epicenter.ts must default-export defineEpicenter({ apps })',
	]);
	expect(programProblems({ apps: { counter: { actions: {} } } })).toEqual([
		'apps.counter needs a description',
	]);
});

/** Types only: checked, never run. */
export function typed() {
	const app = { description: 'Counts', actions: { count } };
	// @ts-expect-error: serve is the command's own word.
	defineEpicenter({ apps: { serve: app } });
}
