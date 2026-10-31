/**
 * Browser storage key tests.
 * Pins the exact localStorage keys browsers already hold connections and
 * choices under, so a rename cannot strand saved data. Lock names and storage
 * event matching derive from the same key and are not exercised here.
 */
import { afterEach, expect, test } from 'bun:test';
import { createBrowserConnections } from './browser.js';
import { createBrowserInferenceSelections } from './selections.js';

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

test('connections and choices are saved under their browser keys', async () => {
	const values = stubWindow();
	const connections = createBrowserConnections();
	const connectionId = await connections.add({
		baseUrl: 'https://example.com/v1',
	});
	await connections.close();
	const selections = createBrowserInferenceSelections('vocab');
	selections.set('chat', { connectionId, model: 'manual' });
	selections[Symbol.dispose]();

	expect([...values.keys()].sort()).toEqual([
		'epicenter/ai.app-ai-connections',
		'vocab/ai.app-ai-selections',
	]);
});

test('connections and choices saved in an earlier session read back', async () => {
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
	values.set(
		'vocab/ai.app-ai-selections',
		JSON.stringify({
			version: 1,
			selections: { chat: { connectionId: 'saved', model: 'manual' } },
		}),
	);

	const connections = createBrowserConnections();
	expect(connections.getAll().map(({ id }) => id)).toEqual(['saved']);
	await connections.close();
	const selections = createBrowserInferenceSelections('vocab');
	expect(selections.get('chat')).toEqual({
		connectionId: 'saved',
		model: 'manual',
	});
	selections[Symbol.dispose]();
});
