/**
 * Where Vocab's tutor can run (`createVocabAi`).
 *
 * Key behaviors:
 * - Models list local servers first, then Epicenter's (once signed in), then
 *   the endpoints the learner connected on this device.
 * - The connected endpoints are the same signed in and out.
 * - Connections that cannot be opened are reported and leave the rest usable.
 * - Adding a connection merges again, so its models list at once.
 */
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import type { Account } from '@epicenter/account';
import type { Endpoint } from '@epicenter/ai';
import { createAiConnections } from '@epicenter/ai/connections';

const { createVocabAi } = await import('./ai.svelte.js');

const account = {
	baseURL: 'https://api.epicenter.test',
	signal: new AbortController().signal,
	fetch: async () => Response.json({}),
} as unknown as Account;

const ollama: Endpoint = {
	id: 'ollama',
	name: 'Ollama',
	source: 'local',
	fetch: async () => Response.json({}),
	models: () => [{ id: 'llama3.2', can: ['chat'] }],
};

function memoryConnections() {
	const values = new Map<string, string>();
	return createAiConnections({
		storageKey: 'test',
		storage: {
			getItem: (key) => values.get(key) ?? null,
			setItem: (key, value) => void values.set(key, value),
		},
	});
}

const listed = (ai: ReturnType<typeof createVocabAi>) =>
	ai.current.models.map(({ endpoint, id }) => `${endpoint}/${id}`);

test('signed in, models list local, then hosted, then connected', async () => {
	const connections = memoryConnections();
	const id = await connections.add({
		baseUrl: 'https://api.example.test/v1',
		models: ['gpt-x'],
	});
	const ai = createVocabAi(account, {
		open: async () => connections,
		servers: [ollama],
	});
	await ai.ready;
	expect(listed(ai)).toEqual([
		'ollama/llama3.2',
		'hosted/gemini-3.5-flash',
		'hosted/whisper-1',
		`${id}/gpt-x`,
	]);
	await ai.close();
});

test('signed out, the connected endpoints are there and hosted lists nothing', async () => {
	const connections = memoryConnections();
	const id = await connections.add({
		baseUrl: 'https://api.example.test/v1',
		models: ['gpt-x'],
	});
	const ai = createVocabAi(undefined, {
		open: async () => connections,
		servers: [],
	});
	await ai.ready;
	expect(listed(ai)).toEqual([`${id}/gpt-x`]);
	expect(ai.problem).toBeNull();
	await ai.close();
});

test('connections that cannot be opened are reported, and hosted still works', async () => {
	const ai = createVocabAi(account, {
		open: async () => {
			throw new Error('connections.md could not be read');
		},
		servers: [],
	});
	await ai.ready;
	expect(ai.problem).toBe('connections.md could not be read');
	expect(ai.connections).toBeNull();
	expect(listed(ai)).toEqual(['hosted/gemini-3.5-flash', 'hosted/whisper-1']);
});

test('adding a connection lists its models at once', async () => {
	const connections = memoryConnections();
	const ai = createVocabAi(undefined, {
		open: async () => connections,
		servers: [],
	});
	await ai.ready;
	expect(listed(ai)).toEqual([]);
	const id = await connections.add({
		baseUrl: 'https://api.example.test/v1',
		models: ['gpt-x'],
	});
	expect(listed(ai)).toEqual([`${id}/gpt-x`]);
	await ai.close();
});
