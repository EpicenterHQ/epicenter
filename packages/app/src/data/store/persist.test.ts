/**
 * The three ordinary outcomes, because two of them look like failures.
 */
import { describe, expect, test } from 'bun:test';
import { requestPersistentStorage } from './persist.js';

type Manager = {
	persisted?: () => Promise<boolean>;
	persist?: () => Promise<boolean>;
};

function withStorage<T>(manager: Manager | undefined, run: () => T): T {
	const global = globalThis as { navigator?: { storage?: Manager } };
	const before = global.navigator;
	global.navigator = { ...before, storage: manager } as typeof before;
	try {
		return run();
	} finally {
		global.navigator = before;
	}
}

describe('requestPersistentStorage', () => {
	test('a runtime with no Storage API is not an error', async () => {
		// Bun, a worker, an old browser. A store has to open in all of them.
		expect(await withStorage(undefined, requestPersistentStorage)).toBe(false);
	});

	test('an origin already persisted is not asked again', async () => {
		let asked = 0;
		const granted = await withStorage(
			{
				persisted: async () => true,
				persist: async () => {
					asked += 1;
					return true;
				},
			},
			requestPersistentStorage,
		);
		expect(granted).toBe(true);
		expect(asked).toBe(0);
	});

	test('a refusal is an ordinary answer, not a failure', async () => {
		// Chrome and Safari decide from engagement heuristics, so a first-visit
		// tab is refused as a matter of course.
		const granted = await withStorage(
			{ persisted: async () => false, persist: async () => false },
			requestPersistentStorage,
		);
		expect(granted).toBe(false);
	});

	test('a permissions policy that throws is also just a refusal', async () => {
		const granted = await withStorage(
			{
				persisted: async () => {
					throw new Error('blocked by permissions policy');
				},
			},
			requestPersistentStorage,
		);
		expect(granted).toBe(false);
	});
});
