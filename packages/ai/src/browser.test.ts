/**
 * Browser storage key tests.
 * Pins the exact localStorage keys a browser holds connections and model
 * choices under, so a rename cannot strand saved data. Lock names and
 * storage event matching derive from the same key and are not exercised here.
 */
import { afterEach, expect, test } from 'bun:test';
import { createBrowserConnections, modelChoices } from './device-settings.js';

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
	const choices = modelChoices();
	await choices.set('chat', { endpoint: connectionId, model: 'manual' });
	choices[Symbol.dispose]();

	expect([...values.keys()].sort()).toEqual([
		'epicenter/ai.app-ai-connections',
		'epicenter/ai.model-choices',
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
		'epicenter/ai.model-choices',
		JSON.stringify({
			version: 1,
			choices: { chat: { endpoint: 'saved', model: 'manual' } },
		}),
	);

	const connections = createBrowserConnections();
	expect(connections.getAll().map(({ id }) => id)).toEqual(['saved']);
	await connections.close();
	const choices = modelChoices();
	await choices.ready;
	expect(choices.get('chat')).toEqual({ endpoint: 'saved', model: 'manual' });
	choices[Symbol.dispose]();
});

test('malformed saved choices are left as they are, and leave only the defaults', async () => {
	for (const raw of [
		'secret invalid JSON',
		JSON.stringify({ version: 2, choices: {} }),
		JSON.stringify({
			version: 1,
			choices: { chat: { endpoint: 'one', model: 'm', apiKey: 'secret' } },
		}),
	]) {
		const values = stubWindow();
		values.set('epicenter/ai.model-choices', raw);
		const choices = modelChoices({ chat: { endpoint: 'hosted', model: 'd' } });
		await choices.ready;
		expect(choices.problem()).toBe('Invalid persisted model choices.');
		expect(choices.get('chat')).toEqual({ endpoint: 'hosted', model: 'd' });
		expect(values.get('epicenter/ai.model-choices')).toBe(raw);
		choices[Symbol.dispose]();
	}
});
