/**
 * Skills Application Lifecycle Tests
 *
 * Verifies that acquisition failures and aborts release every runtime the
 * application composition root actually acquires.
 *
 * Key behaviors:
 * - a bind failure releases the opened Epicenter runtime
 * - aborting a pending runtime open rejects without inventing cleanup work
 */

import { expect, test } from 'bun:test';
import { openSkillsApplication } from './application.js';

test('a failed Skills open releases its runtime', async () => {
	const cause = new Error('storage unavailable');
	let releases = 0;

	await expect(
		openSkillsApplication({
			openEpicenter: async () => ({
				bind() {
					throw cause;
				},
				async [Symbol.asyncDispose]() {
					releases += 1;
				},
			}),
			reportBackgroundError() {},
		}),
	).rejects.toBe(cause);

	expect(releases).toBe(1);
});

test('aborting a pending runtime open rejects without a runtime release', async () => {
	const abort = new AbortController();
	let releases = 0;
	const opening = openSkillsApplication(
		{
			openEpicenter: () => new Promise<never>(() => {}),
			reportBackgroundError() {},
		},
		{ signal: abort.signal },
	);

	abort.abort();
	await expect(opening).rejects.toHaveProperty('name', 'AbortError');
	expect(releases).toBe(0);
});
