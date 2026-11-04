/**
 * `fromAi`: `models` tracks every endpoint while something reads it in an
 * effect, subscribes only then, and is a plain snapshot elsewhere.
 */
import '../../../svelte/src/svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import { flushSync } from 'svelte';
import type { Endpoint, EndpointModel } from '../endpoint.js';
import { openAi } from '../open-ai.js';

const { fromAi } = await import('./ai.svelte.js');
const { follow } = await import(
	'../../../svelte/src/reactive.test-support.svelte.js'
);

function server() {
	let models: EndpointModel[] = [];
	const listeners = new Set<() => void>();
	const endpoint: Endpoint = {
		id: 'ollama',
		name: 'Ollama',
		source: 'local',
		fetch: async () => Response.json({}),
		models: () => models,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	return {
		endpoint,
		listeners,
		find(id: string) {
			models = [{ id, can: ['chat'] }];
			for (const listener of listeners) listener();
		},
	};
}

test('models tracks endpoint changes while read in an effect', () => {
	const local = server();
	const ai = fromAi(openAi([local.endpoint]));
	expect(local.listeners.size).toBe(0);

	const followed = follow(() => ai.models.map(({ id }) => id));
	flushSync();
	expect(local.listeners.size).toBe(1);
	local.find('llama');
	flushSync();
	expect(followed.values).toEqual([[], ['llama']]);

	followed.stop();
	flushSync();
	expect(local.listeners.size).toBe(0);
});

test('a read outside an effect is a snapshot and subscribes to nothing', () => {
	const local = server();
	local.find('qwen');
	const ai = fromAi(openAi([local.endpoint]));
	expect(ai.models.map(({ endpoint, id }) => `${endpoint}/${id}`)).toEqual([
		'ollama/qwen',
	]);
	expect(local.listeners.size).toBe(0);
	expect(ai.endpoints.map(({ id }) => id)).toEqual(['ollama']);
});
