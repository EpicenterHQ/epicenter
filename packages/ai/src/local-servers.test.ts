/**
 * Local servers over a fake fetch: models appear when a probe finds a
 * server, leave when a probe no longer does, and nothing waits on a probe.
 */
import { expect, test } from 'bun:test';
import { localServers } from './local-servers.js';
import { openAi } from './open-ai.js';

const settled = () => new Promise((resolve) => setTimeout(resolve, 5));

/** A fake computer: which servers answer, and with which models. */
function computer() {
	const running = new Map<string, string[]>();
	const asked: string[] = [];
	return {
		running,
		asked,
		fetch: async (url: string) => {
			asked.push(url);
			const origin = new URL(url).origin;
			const models = running.get(origin);
			if (!models) throw new TypeError('connection refused');
			return Response.json({ data: models.map((id) => ({ id })) });
		},
	};
}

test('a server appears when a probe finds it and tells subscribers', async () => {
	const host = computer();
	host.running.set('http://localhost:11434', ['llama3.2', 'nomic-embed-text']);
	const ai = openAi([localServers({ fetch: host.fetch })]);
	let told = 0;
	ai.subscribe(() => told++);
	await settled();
	expect(host.asked.sort()).toEqual([
		'http://localhost:11434/v1/models',
		'http://localhost:1234/v1/models',
	]);
	expect(ai.models()).toEqual([
		{ id: 'llama3.2', can: ['chat'], endpoint: 'ollama', source: 'local' },
		{
			id: 'nomic-embed-text',
			can: ['embed'],
			endpoint: 'ollama',
			source: 'local',
		},
	]);
	expect(told).toBe(1);
});

test('a server that stops is gone after the next probe', async () => {
	const host = computer();
	host.running.set('http://localhost:1234', ['qwen']);
	const ai = openAi([localServers({ fetch: host.fetch })]);
	let told = 0;
	ai.subscribe(() => told++);
	await settled();
	expect(ai.models().map(({ endpoint, id }) => `${endpoint}/${id}`)).toEqual([
		'lm-studio/qwen',
	]);

	host.running.delete('http://localhost:1234');
	ai.refresh();
	await settled();
	expect(ai.models()).toEqual([]);
	expect(told).toBe(2);

	// The same answer again changes nothing and tells no one.
	ai.refresh();
	await settled();
	expect(told).toBe(2);
});

test('nothing waits on a probe, and a server that never answers counts as absent', async () => {
	let asked = 0;
	const servers = localServers({
		fetch: () => {
			asked++;
			return new Promise<Response>(() => {});
		},
		timeout: 10,
	});
	const ai = openAi([servers]);
	let told = 0;
	const stop = ai.subscribe(() => told++);
	// Subscribing returned at once and models answer synchronously.
	expect(asked).toBe(2);
	expect(ai.models()).toEqual([]);
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(ai.models()).toEqual([]);
	expect(told).toBe(0);
	stop();
});

test('no probe runs before a subscriber or a refresh, and an interval probes while subscribed', async () => {
	const host = computer();
	const [ollama] = localServers({ fetch: host.fetch, interval: 5 });
	expect(host.asked).toEqual([]);
	const stop = ollama!.subscribe!(() => {});
	await new Promise((resolve) => setTimeout(resolve, 18));
	const whileSubscribed = host.asked.length;
	expect(whileSubscribed).toBeGreaterThanOrEqual(3);
	stop();
	await new Promise((resolve) => setTimeout(resolve, 18));
	expect(host.asked.length).toBe(whileSubscribed);
});

test('a request reaches the local server that offers the model', async () => {
	const calls: string[] = [];
	const ai = openAi([
		localServers({
			fetch: async (url) => {
				calls.push(url);
				return Response.json({ data: [] });
			},
		}),
	]);
	await ai.embed({ endpoint: 'ollama', model: 'nomic-embed-text', input: 'a' });
	expect(calls).toEqual(['http://localhost:11434/v1/embeddings']);
});
