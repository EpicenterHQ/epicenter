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

test('a direct call hands each update to its listener', async () => {
	const heard: unknown[] = [];
	const answer = await count({ to: 2 }, { onUpdate: (n) => heard.push(n) });
	expect(answer).toEqual(Ok('n=2'));
	expect(heard).toEqual([{ at: 1 }, { at: 2 }]);
});

test('serve refuses an apps object missing, and names that are not names', () => {
	const app = { description: 'Counts', actions: { count } };
	expect(programProblems(defineEpicenter({ apps: { counter: app } }))).toEqual(
		[],
	);
	expect(programProblems({ counter: app })).toEqual([
		'epicenter.ts must default-export defineEpicenter({ apps })',
	]);
	expect(
		programProblems({
			apps: {
				Counter: app,
				counter: { description: 'Counts', actions: { do_it: count } },
			},
		}),
	).toEqual([
		'The app name "Counter" must be lowercase letters, digits and dashes, starting with a letter',
		'apps.counter has the action "do_it", which must be lowercase letters, digits and dashes, starting with a letter',
	]);
});

/** Types only: checked, never run. */
export function typed() {
	const app = { description: 'Counts', actions: { count } };
	// @ts-expect-error: serve is the command's own word.
	defineEpicenter({ apps: { serve: app } });
}
