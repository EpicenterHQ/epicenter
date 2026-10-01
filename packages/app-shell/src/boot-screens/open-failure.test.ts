/**
 * The sentence a person reads for a failed open, the repair beside it, and the
 * cause underneath.
 *
 * The table is the whole arm set: two failures that change what a person can
 * do, and everything else. A row asserts all three fields together, because
 * they are one decision, and the fallback rows pin the printed detail rather
 * than the fact that there is one: a screen shows a string, and a boolean would
 * pass over the wrong string.
 *
 * Key behaviors:
 * - Each named failure gets its own sentence, in the application's noun, with no detail
 * - `LocksUnsupported` is the one arm that offers no repair
 * - Every other failure, store-named or not, object or not, gets the fallback and its cause
 */

import { expect, test } from 'bun:test';
import { openFailure } from './open-failure.js';

const HONEYCRISP = { appName: 'Honeycrisp', noun: 'notes' };

const FALLBACK =
	'Your notes could not be opened. Check your connection and try again.';

const CASES = [
	{
		case: 'another window holds the claim',
		error: {
			name: 'AlreadyOpen',
			message:
				'epicenter/v5/so.epicenter.honeycrisp/p_1/so.epicenter.honeycrisp/3 is open in another context',
		},
		failure: {
			message:
				'Another Honeycrisp window already has your notes open. Close it, then try again.',
			repair: 'retry',
		},
	},
	{
		case: 'the runtime ships no Web Locks',
		error: { name: 'LocksUnsupported', message: 'navigator.locks is missing' },
		failure: {
			message:
				'This browser is too old to open your notes safely. Update it, or use a different one.',
			repair: 'none',
		},
	},
	{
		case: 'a store failure with no sentence of its own',
		error: { name: 'ClaimFailed', message: 'the lock request threw' },
		failure: {
			message: FALLBACK,
			repair: 'retry',
			detail: 'the lock request threw',
		},
	},
	{
		case: 'a failure from outside the store',
		error: { name: 'OpenerThrew', message: 'listing the account timed out' },
		failure: {
			message: FALLBACK,
			repair: 'retry',
			detail: 'listing the account timed out',
		},
	},
	{
		case: 'something that is not an object at all',
		error: 'boom',
		failure: { message: FALLBACK, repair: 'retry', detail: 'boom' },
	},
	{
		case: 'nothing, spelled null',
		error: null,
		failure: { message: FALLBACK, repair: 'retry', detail: 'null' },
	},
	{
		case: 'nothing, spelled undefined',
		error: undefined,
		failure: { message: FALLBACK, repair: 'retry', detail: 'undefined' },
	},
] as const;

for (const row of CASES) {
	test(row.case, () => {
		expect(openFailure(row.error, HONEYCRISP)).toEqual(row.failure);
	});
}

test('the noun and the app name come from the application', () => {
	expect(
		openFailure(
			{ name: 'AlreadyOpen' },
			{ appName: 'Whispering', noun: 'recordings' },
		).message,
	).toBe(
		'Another Whispering window already has your recordings open. Close it, then try again.',
	);
});
