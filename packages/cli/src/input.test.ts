/** Action matching separates name words from values and flags; a refusal names the field as the caller gave it. */

import { expect, test } from 'bun:test';
import { defineAction, field } from '@epicenter/app';
import { checkInput, matchAction } from './input.ts';

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
