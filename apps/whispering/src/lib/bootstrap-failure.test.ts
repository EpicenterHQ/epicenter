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
let readyApp = false;
let closes = 0;
const navigations: string[] = [];
const lifetime = new AbortController();
const storage = {
	getItem: (key: string) => values.get(key) ?? null,
	setItem(key: string, value: string) {
		values.set(key, value);
	},
};
Object.defineProperties(globalThis, {
	localStorage: { configurable: true, value: storage },
	location: {
		configurable: true,
		value: {
			search: '',
			pathname: '/',
			assign: (path: string) => navigations.push(path),
		},
	},
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
mock.module('@epicenter/app/open', () => ({
	async openApp() {
		opens++;
		expect(listeners.size).toBe(1);
		if (readyApp)
			return {
				signal: lifetime.signal,
				account: { personal: {}, shared: null },
				async close() {
					closes++;
					lifetime.abort();
				},
			};
		throw failure;
	},
}));
mock.module('#platform/auth', () => ({
	authClient: {
		get auth() {
			return readyApp
				? {
						state: {
							account: {
								supportsShared: false,
								authorityId: 'https://test.example',
								principalId: 'person',
							},
						},
						onStateChange() {
							return () => {};
						},
					}
				: null;
		},
		selectedServer: null,
	},
}));

for (const cleanupThrows of [false, true]) {
	test(`App opening rejection removes storage listeners and preserves the error (cleanup throws: ${cleanupThrows})`, async () => {
		listeners.clear();
		cleanupFails = cleanupThrows;
		const before = opens;
		const opened = await import(
			`./bootstrap.ts?failure=${crypto.randomUUID()}`
		);
		await expect(opened.opening).rejects.toBe(failure);
		expect(opens).toBe(before + 1);
		expect(listeners.size).toBe(0);
	});
}

test('an unavailable saved library closes the ready App and can select a fresh page', async () => {
	readyApp = true;
	cleanupFails = false;
	values.set('whispering.library', 'shared');
	const opened = await import(`./bootstrap.ts?choice=${crypto.randomUUID()}`);
	await expect(opened.opening).rejects.toThrow('Sign in to open this library.');
	expect(closes).toBe(1);
	expect(listeners.size).toBe(0);
	expect(opened.departure.state.phase).toBe('opening-failed');
	await opened.selectLibrary('personal');
	expect(values.get('whispering.library')).toBe('personal');
	expect(navigations).toEqual(['/']);
});
