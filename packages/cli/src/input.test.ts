/** Action matching separates name words from values and flags. */
import { expect, test } from 'bun:test';
import { matchAction } from './input.ts';

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
