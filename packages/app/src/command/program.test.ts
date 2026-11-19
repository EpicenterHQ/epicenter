import { expect, test } from 'bun:test';
import { Type } from 'typebox';
import { Ok } from 'wellcrafted/result';
import { defineAction } from '../action.ts';
import { defineEpicenter } from '../epicenter.ts';
import { field } from '../field.ts';
import { programProblems } from './program.ts';

const count = defineAction({
	description: 'Count to a number',
	input: { to: field.integer({ min: 1 }) },
	run: ({ to }) => Ok(to),
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

test('serve refuses an app that is not one, an action not made by defineAction, and a schema that does not compile', () => {
	const odd = defineAction({
		description: 'Has a raw pattern that is not a regular expression',
		input: { code: Type.String({ pattern: '[' }) },
		run: () => Ok(null),
	});
	const problems = programProblems({
		apps: {
			// The app function, not what it returns: a common slip.
			flights: () => ({ description: 'Flights', actions: {} }),
			counter: { description: 'Counts', actions: { count, odd, plain: {} } },
		},
	});
	expect(problems).toHaveLength(3);
	expect(problems[0]).toBe(
		'apps.flights must be what its app returns: { description, actions }',
	);
	expect(problems[1]).toStartWith(
		'apps.counter.odd has an input schema that does not compile: Invalid regular expression',
	);
	expect(problems[2]).toBe('apps.counter.plain must be made with defineAction');
});
