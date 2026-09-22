/** Inference access tests: captured credentials, streamed-body retirement, and honest request drain. */
import { expect, test } from 'bun:test';
import OpenAI from 'openai';
import { openConnectionCatalog } from './connection-catalog.js';
import { type AiTransport, createInference } from './inference.js';

function setup(fetch: AiTransport['fetch']) {
	const inference = createInference({
		baseURL: 'https://account.example/v1',
		fetch,
	});
	return { inference, close: inference.close };
}

test('reads construct actual SDK clients without requests or ambient credentials', async () => {
	let requests = 0;
	let authorization: string | null = null;
	const { inference, close } = setup(async (_input, init) => {
		requests++;
		authorization = new Headers(init?.headers).get('authorization');
		return Response.json({ data: [{ id: 'chosen' }] });
	});
	expect(inference.client).toBeInstanceOf(OpenAI);
	expect(requests).toBe(0);
	const retained = inference.client;
	expect((await retained.models.list()).data[0]?.id).toBe('chosen');
	expect(authorization).toBeNull();
	await close();
	await expect((async () => await retained.models.list())()).rejects.toThrow();
	expect(requests).toBe(1);
});

test('close rejects stream reads and waits for underlying cancellation', async () => {
	const cancelled = Promise.withResolvers<void>();
	const drain = Promise.withResolvers<void>();
	const { inference, close } = setup(
		async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
							),
						);
					},
					async cancel() {
						cancelled.resolve();
						await drain.promise;
					},
				}),
				{ headers: { 'content-type': 'text/event-stream' } },
			),
	);
	const stream = await inference.client.chat.completions.create({
		model: 'chosen',
		messages: [],
		stream: true,
	});
	const iterator = stream[Symbol.asyncIterator]();
	expect((await iterator.next()).value?.choices[0]?.delta.content).toBe(
		'hello',
	);
	let closed = false;
	const closing = close().then(() => {
		closed = true;
	});
	await cancelled.promise;
	expect(closed).toBe(false);
	// SDK streams may end normally on AbortError; no further content may escape.
	const next = await iterator.next().catch(() => ({ done: true }));
	expect(next.done).toBe(true);
	drain.resolve();
	await closing;
	expect(closed).toBe(true);
});

test('close drains a transport that ignores abort before returning its headers', async () => {
	const started = Promise.withResolvers<void>();
	const response = Promise.withResolvers<Response>();
	const { inference, close } = setup(async () => {
		started.resolve();
		return response.promise;
	});
	const request = (async () => await inference.client.models.list())();
	const failed = request.then(
		() => {
			throw new Error('Request unexpectedly succeeded');
		},
		() => undefined,
	);
	await started.promise;
	let closed = false;
	const closing = close().then(() => {
		closed = true;
	});
	await Promise.resolve();
	expect(closed).toBe(false);
	response.resolve(Response.json({ data: [] }));
	await failed;
	await closing;
	expect(closed).toBe(true);
});

test('configured clients preserve names and IDs but retire on credential or destination edits', async () => {
	const { createAiConnections } = await import('./ai-connections.js');
	const values = new Map<string, string>();
	const connections = createAiConnections({
		storageKey: 'test',
		storage: {
			getItem: (key) => values.get(key) ?? null,
			setItem: (key, value) => {
				values.set(key, value);
			},
		},
	});
	const requests: { url: string; authorization: string | null }[] = [];
	const owned = await openConnectionCatalog({
		...connections,
		transport(record) {
			return {
				baseURL: record.baseUrl,
				async fetch(input, init) {
					requests.push({
						url: String(input),
						authorization: new Headers(init?.headers).get('authorization'),
					});
					return Response.json({ data: [] });
				},
			};
		},
	});
	const connectionsApi = owned;
	const first = await connections.add({
		name: 'One',
		baseUrl: 'https://same.example/v1',
		apiKey: 'one',
	});
	const second = await connections.add({
		name: 'Two',
		baseUrl: 'https://same.example/v1',
		apiKey: 'two',
	});
	const retained = connectionsApi.getAll()[0]!.client;
	await retained.models.list();
	await connectionsApi.getAll()[1]!.client.models.list();
	expect(requests.map((entry) => entry.authorization)).toEqual([
		'Bearer one',
		'Bearer two',
	]);
	await connections.update(first, { name: 'Renamed' });
	await connections.reorder([second, first]);
	expect(connectionsApi.getAll()[1]!.client).toBe(retained);
	expect(connectionsApi.getAll()[1]!.name).toBe('Renamed');
	await connections.update(first, {
		baseUrl: 'https://other.example/v1',
		apiKey: 'rotated',
	});
	await expect((async () => await retained.models.list())()).rejects.toThrow();
	const replacement = connectionsApi.getAll()[1]!.client;
	await replacement.models.list();
	expect(requests.at(-1)).toEqual({
		url: 'https://other.example/v1/models',
		authorization: 'Bearer rotated',
	});
	await connections.remove(first);
	await expect(
		(async () => await replacement.models.list())(),
	).rejects.toThrow();
	await owned.close();
});

test('same-owner refresh preserves an account client and sign-out retires its stream', async () => {
	const { createSessionAuth } = await import('@epicenter/auth');
	const { asPrincipalId } = await import('@epicenter/principal');
	let token = 'first';
	const authorizations: (string | null)[] = [];
	const auth = createSessionAuth({
		authorityId: 'epicenter-api',
		baseURL: 'https://account.example',
		persistedAuthStorage: { initial: null, set() {} },
		launcher: { startSignIn: async () => ({ status: 'completed', token }) },
		fetch: async (input, init) => {
			if (String(input).endsWith('/api/session'))
				return Response.json({ principalId: 'alice' });
			if (String(input).endsWith('/models'))
				authorizations.push(new Headers(init?.headers).get('authorization'));
			if (String(input).endsWith('/models')) return Response.json({ data: [] });
			if (!String(input).endsWith('/chat/completions'))
				return new Response(null, { status: 204 });
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"choices":[{"delta":{"content":"first"}}]}\n\n',
							),
						);
						init?.signal?.addEventListener(
							'abort',
							() => controller.error(init.signal?.reason),
							{ once: true },
						);
					},
				}),
				{ headers: { 'content-type': 'text/event-stream' } },
			);
		},
	});
	const { expectOk } = await import('wellcrafted/testing');
	expectOk(await auth.startSignIn());
	const state = auth.getState();
	if (state.status === 'signed-out') throw new Error('Expected Account');
	const account = state.account;
	expect(account.principalId).toBe(asPrincipalId('alice'));
	const { inference, close } = setup(account.fetch);
	await inference.client.models.list();
	token = 'refreshed';
	expectOk(await auth.startSignIn());
	expect(auth.getState().account).toBe(account);
	await inference.client.models.list();
	expect(authorizations).toEqual(['Bearer first', 'Bearer refreshed']);
	const stream = await inference.client.chat.completions.create({
		model: 'chosen',
		messages: [],
		stream: true,
	});
	const iterator = stream[Symbol.asyncIterator]();
	expect((await iterator.next()).value?.choices[0]?.delta.content).toBe(
		'first',
	);
	expectOk(await auth.signOut());
	expect((await iterator.next().catch(() => ({ done: true }))).done).toBe(true);
	await expect(
		(async () => await inference.client.models.list())(),
	).rejects.toThrow();
	await close();
	auth[Symbol.dispose]();
});

test('App retirement never turns partial tool arguments into an executable call', async () => {
	const { createOpenAiAgentEngine } = await import('@epicenter/client');
	const received = Promise.withResolvers<void>();
	const { inference, close } = setup(
		async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tool-1","function":{"name":"remove","arguments":"{"}}]}}]}\n\n',
							),
						);
					},
					pull() {
						received.resolve();
					},
				}),
				{ headers: { 'content-type': 'text/event-stream' } },
			),
	);
	const engine = createOpenAiAgentEngine({
		data: () => ({
			client: inference.client,
			model: 'chosen',
			systemPrompts: [],
		}),
	});
	const caller = new AbortController();
	const chunks = (async () => {
		const result = [];
		for await (const chunk of engine(
			{ messages: [], tools: [] },
			caller.signal,
		))
			result.push(chunk);
		return result;
	})();
	await received.promise;
	await close();
	const result = await chunks;
	expect(caller.signal.aborted).toBe(false);
	expect(result.some((chunk) => chunk.type === 'tool-call')).toBe(false);
	expect(result.some((chunk) => chunk.type === 'run-error')).toBe(true);
});

test('close reports cancellation failure even when headers arrive after retirement', async () => {
	const started = Promise.withResolvers<void>();
	const response = Promise.withResolvers<Response>();
	const { inference, close } = setup(async () => {
		started.resolve();
		return response.promise;
	});
	const request = (async () => await inference.client.models.list())().catch(
		() => undefined,
	);
	await started.promise;
	const closing = close();
	const result = closing.then(
		() => false,
		() => true,
	);
	response.resolve(
		new Response(
			new ReadableStream({
				cancel() {
					throw new Error('Cannot cancel response');
				},
			}),
		),
	);
	await request;
	expect(await result).toBe(true);
});

test('close accepts the stored stream error when fetch aborts before reader cancellation', async () => {
	let cancelCalls = 0;
	const { inference, close } = setup(
		async (_input, init) =>
			new Response(
				new ReadableStream({
					start(controller) {
						init!.signal!.addEventListener(
							'abort',
							() => controller.error(init!.signal!.reason),
							{ once: true },
						);
					},
					cancel() {
						cancelCalls++;
					},
				}),
			),
	);
	const response = await inference.client.models.list().asResponse();
	await expect(close()).resolves.toBeUndefined();
	await expect(response.text()).rejects.toThrow();
	expect(cancelCalls).toBe(0);
});

test('close preserves an underlying cancellation failure even when it is named AbortError', async () => {
	const { inference, close } = setup(
		async () =>
			new Response(
				new ReadableStream({
					cancel() {
						throw new DOMException('Cleanup failed', 'AbortError');
					},
				}),
			),
	);
	await inference.client.models.list().asResponse();
	await expect(close()).rejects.toThrow('Inference cleanup failed.');
});

test('close accepts an already-errored body returned after retirement', async () => {
	const started = Promise.withResolvers<void>();
	const response = Promise.withResolvers<Response>();
	const { inference, close } = setup(async () => {
		started.resolve();
		return response.promise;
	});
	const request = inference.client.models.list().then(
		() => 'sent',
		() => 'rejected',
	);
	await started.promise;
	const closing = close();
	response.resolve(
		new Response(
			new ReadableStream({
				start(controller) {
					controller.error(new DOMException('Fetch aborted', 'AbortError'));
				},
			}),
		),
	);
	await expect(closing).resolves.toBeUndefined();
	expect(await request).toBe('rejected');
});

test('extracted catalog operations and retained clients refuse after catalog closure', async () => {
	const { createAiConnections } = await import('./ai-connections.js');
	const owner = await openConnectionCatalog(
		createAiConnections({
			storageKey: 'test',
			storage: { getItem: () => null, setItem() {} },
			fetch: async () => Response.json({ data: [] }),
		}),
	);
	const { getAll, get, add, update, remove, reorder, subscribe } = owner;
	const id = await add({ baseUrl: 'https://custom/v1' });
	const client = get(id)!.client;
	await client.models.list();
	await owner.close();
	for (const action of [
		() => getAll(),
		() => get(id),
		() => add({ baseUrl: 'https://custom/v1' }),
		() => update(id, {}),
		() => remove(id),
		() => reorder([]),
		() => subscribe(() => {}),
	])
		expect(action).toThrow();
	await expect((async () => await client.models.list())()).rejects.toThrow();
});
