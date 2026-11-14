/**
 * Local servers over a fake fetch: models appear when a probe finds a
 * server, leave when a probe no longer does, and nothing waits on a probe.
 */
import { expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import { localServers } from './local-servers.js';
import { openAi } from './open-ai.js';

/**
 * Resolves once `condition` holds, polling each millisecond, so a test waits
 * on what it expects rather than a guess at how long a loaded machine takes.
 */
async function until(condition: () => boolean, deadline = 2000) {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > deadline)
			throw new Error(`still waiting after ${deadline} ms`);
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

/** Long enough for several 5 ms interval ticks to fire if any were left. */
const severalTicks = () => new Promise((resolve) => setTimeout(resolve, 25));

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
	await until(() => told > 0);
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
	await until(() => told > 0);
	expect(ai.models().map(({ endpoint, id }) => `${endpoint}/${id}`)).toEqual([
		'lm-studio/qwen',
	]);

	host.running.delete('http://localhost:1234');
	await ai.refresh();
	expect(ai.models()).toEqual([]);
	expect(told).toBe(2);

	// The same answer again changes nothing and tells no one.
	await ai.refresh();
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
	// A refresh settles only once its probes time out, and they find nothing.
	await ai.refresh();
	expect(asked).toBe(4);
	expect(ai.models()).toEqual([]);
	expect(told).toBe(0);
	stop();
});

test('no probe runs before a subscriber or a refresh, and an interval probes while subscribed', async () => {
	const host = computer();
	const [ollama] = localServers({ fetch: host.fetch, interval: 5 });
	expect(host.asked).toEqual([]);
	const stop = ollama!.subscribe!(() => {});
	// The first probe runs on subscribing; the interval asks the rest.
	await until(() => host.asked.length >= 3);
	stop();
	// A probe asks synchronously, so the count at `stop()` is final.
	const whileSubscribed = host.asked.length;
	await severalTicks();
	expect(host.asked.length).toBe(whileSubscribed);
});

test('a request naming Ollama reaches its embeddings endpoint', async () => {
	const calls: { url: string; init?: RequestInit }[] = [];
	const ai = openAi([
		localServers({
			fetch: async (url, init) => {
				calls.push({ url, init });
				return Response.json({
					data: [{ index: 0, embedding: [0.25, 0.5] }],
				});
			},
		}),
	]);
	const answer = expectOk(
		await ai.embed({
			endpoint: 'ollama',
			model: 'nomic-embed-text',
			input: 'a',
		}),
	);
	expect(answer).toEqual({
		data: [{ index: 0, embedding: [0.25, 0.5] }],
	});
	expect(calls.map(({ url }) => url)).toEqual([
		'http://localhost:11434/v1/embeddings',
	]);
	expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
		model: 'nomic-embed-text',
		input: 'a',
	});
});
