/**
 * Honeycrisp application lifecycle tests.
 *
 * Key behaviors:
 * - Hydration failure releases the opened Epicenter runtime
 * - Aborting hydration rejects the open and releases the runtime
 */

import { expect, mock, test } from 'bun:test';

mock.module('$app/navigation', () => ({ goto: mock() }));
mock.module('$app/state', () => ({
	page: { url: new URL('https://honeycrisp.local/') },
}));

(globalThis as unknown as { $state: unknown }).$state = Object.assign(
	<TValue>(value: TValue) => value,
	{ raw: <TValue>(value: TValue) => value },
);
(globalThis as unknown as { $derived: unknown }).$derived = Object.assign(
	<TValue>(value: TValue) => value,
	{ by: <TValue>(derive: () => TValue) => derive() },
);

const { openHoneycrispApplication } = await import('./application.js');

function createRuntime(scanFolders: () => Promise<never>) {
	let releases = 0;
	const table = {
		scan: scanFolders,
		subscribe: () => () => {},
	};
	return {
		get releases() {
			return releases;
		},
		value: {
			epicenter: {
				bind: () => ({ tables: { folders: table, notes: table }, values: {} }),
				syncStatus: { state: 'local', lastError: undefined },
				subscribeSyncStatus: () => () => {},
			},
			connectDocument: () => {
				throw new Error('unreachable');
			},
			async [Symbol.asyncDispose]() {
				releases += 1;
			},
		} as never,
	};
}

test('a failed Honeycrisp hydration releases its runtime', async () => {
	const cause = new Error('storage unavailable');
	const runtime = createRuntime(() => Promise.reject(cause));

	await expect(
		openHoneycrispApplication({
			openEpicenter: async () => runtime.value,
			reportBackgroundError() {},
		}),
	).rejects.toBe(cause);

	expect(runtime.releases).toBe(1);
});

test('aborting pending hydration rejects and releases its runtime', async () => {
	const abort = new AbortController();
	const runtime = createRuntime(() => new Promise<never>(() => {}));
	const opening = openHoneycrispApplication(
		{
			openEpicenter: async () => runtime.value,
			reportBackgroundError() {},
		},
		{ signal: abort.signal },
	);

	await new Promise((resolve) => setTimeout(resolve, 0));
	abort.abort();
	await expect(opening).rejects.toHaveProperty('name', 'AbortError');
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(runtime.releases).toBe(1);
});
