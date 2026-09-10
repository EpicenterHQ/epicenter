/** App opening failure releases the actual page selection storage subscription. */
import { afterAll, expect, mock, test } from 'bun:test';

const originalGlobals = new Map(
	['window', 'localStorage', 'location', 'navigator'].map((key) => [
		key,
		Object.getOwnPropertyDescriptor(globalThis, key),
	]),
);
const listeners = new Set<unknown>();
const values = new Map<string, string>();
const failure = new Error('App resources could not open');
let cleanupFails = false;
let opens = 0;
const storage = {
	getItem: (key: string) => values.get(key) ?? null,
	setItem(key: string, value: string) {
		values.set(key, value);
	},
};
Object.defineProperties(globalThis, {
	localStorage: { configurable: true, value: storage },
	location: { configurable: true, value: { search: '' } },
	navigator: {
		configurable: true,
		value: {
			locks: {
				request: async (_name: string, callback: () => unknown) => callback(),
			},
		},
	},
	window: {
		configurable: true,
		value: {
			localStorage: storage,
			addEventListener(event: string, listener: unknown) {
				if (event === 'storage') listeners.add(listener);
			},
			removeEventListener(event: string, listener: unknown) {
				if (event !== 'storage') return;
				listeners.delete(listener);
				if (cleanupFails)
					throw new Error('Storage subscription cleanup failed');
			},
		},
	},
});
afterAll(() => {
	for (const [key, descriptor] of originalGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});
mock.module('@epicenter/app', () => ({
	defineApplication: () => ({
		openPersonal() {
			opens++;
			expect(listeners.size).toBe(1);
			throw failure;
		},
	}),
}));
mock.module('./data.js', () => ({ vocabDefinition: {} }));
mock.module('./auth.js', () => ({
	authStartup: { auth: { state: { status: 'signed-in', account: {} } } },
}));

for (const cleanupThrows of [false, true]) {
	test(`synchronous App opening failure removes storage listeners and preserves the error (cleanup throws: ${cleanupThrows})`, async () => {
		listeners.clear();
		cleanupFails = cleanupThrows;
		const before = opens;
		await expect(
			import(`./application.ts?sync-failure=${crypto.randomUUID()}`),
		).rejects.toBe(failure);
		expect(opens).toBe(before + 1);
		expect(listeners.size).toBe(0);
	});
}
