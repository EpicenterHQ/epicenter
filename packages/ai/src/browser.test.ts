/**
 * Browser storage key tests.
 * Pins the exact localStorage key a browser holds connections under, so a
 * rename cannot strand saved data. Lock names and storage event matching
 * derive from the same key and are not exercised here. Model choices are
 * `models.md` through `@epicenter/local`, whose own tests pin its key.
 */
import { afterEach, expect, test } from 'bun:test';
import { createBrowserConnections } from './device-settings.js';

const original = Object.getOwnPropertyDescriptor(globalThis, 'window');

function stubWindow() {
	const values = new Map<string, string>();
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: Object.assign(new EventTarget(), {
			localStorage: {
				getItem: (key: string) => values.get(key) ?? null,
				setItem: (key: string, value: string) => void values.set(key, value),
			},
		}),
	});
	return values;
}

afterEach(() => {
	if (original) Object.defineProperty(globalThis, 'window', original);
	else Reflect.deleteProperty(globalThis, 'window');
});

test('connections are saved under their browser key', async () => {
	const values = stubWindow();
	const connections = createBrowserConnections();
	await connections.add({ baseUrl: 'https://example.com/v1' });
	await connections.close();
	expect([...values.keys()]).toEqual(['epicenter/ai.app-ai-connections']);
});

test('connections saved in an earlier session read back', async () => {
	const values = stubWindow();
	values.set(
		'epicenter/ai.app-ai-connections',
		JSON.stringify({
			version: 1,
			connections: [
				{
					id: 'saved',
					name: 'Saved',
					baseUrl: 'https://example.com/v1',
					models: [],
				},
			],
		}),
	);
	const connections = createBrowserConnections();
	expect(connections.getAll().map(({ id }) => id)).toEqual(['saved']);
	await connections.close();
});
