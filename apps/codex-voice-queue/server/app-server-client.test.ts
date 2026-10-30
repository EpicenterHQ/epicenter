/**
 * App-server client tests verify initialization, request correlation, failures and process restart.
 */
import { afterEach, expect, test } from 'bun:test';
import {
	type AppServerClient,
	createAppServerClient,
} from './app-server-client.js';
import { createFakeAppServer, waitFor } from './testing/fake-app-server.js';

const clients: AppServerClient[] = [];
afterEach(() => {
	for (const client of clients.splice(0)) client.stop();
});
function setup() {
	const fake = createFakeAppServer();
	const client = createAppServerClient({ spawnProcess: () => fake.transport });
	clients.push(client);
	return { fake, client };
}
test('initializes before initialized and correlates out-of-order responses', async () => {
	const { fake, client } = setup();
	await client.ensureReady();
	expect(fake.messages.map((message) => message.method)).toEqual([
		'initialize',
		'initialized',
	]);
	expect(fake.messages[0]).toEqual({
		id: 1,
		method: 'initialize',
		params: {
			clientInfo: {
				name: 'codex_voice_queue',
				title: 'Codex Voice Queue',
				version: '0.0.1',
			},
			capabilities: { experimentalApi: false, requestAttestation: false },
		},
	});
	const a = client.request('a', {});
	const b = client.request('b', {});
	await waitFor(() => fake.messages.length === 4);
	fake.send({ id: fake.messages[3]?.id, result: 'second' });
	fake.send({ id: fake.messages[2]?.id, result: 'first' });
	expect(await a).toBe('first');
	expect(await b).toBe('second');
});
test('splits partial lines and dispatches multiple notifications in a chunk', async () => {
	const { fake, client } = setup();
	await client.ensureReady();
	const methods: string[] = [];
	client.onNotification((message) => methods.push(message.method));
	fake.chunks([
		'not json\n{"method":"one","params":',
		'{}}\n{"method":"two"}\n',
	]);
	await waitFor(() => methods.length === 2);
	expect(methods).toEqual(['one', 'two']);
});
test('answers server requests with results and JSON-RPC errors', async () => {
	const { fake, client } = setup();
	await client.ensureReady();
	client.onServerRequest(async (request) => {
		if (request.method === 'bad') throw new Error('refused');
		return { accepted: false };
	});
	fake.ask('ok', 'good', {});
	fake.ask('bad', 'bad', {});
	await waitFor(() => fake.messages.some((message) => message.id === 'bad'));
	expect(fake.messages.find((message) => message.id === 'ok')?.result).toEqual({
		accepted: false,
	});
	expect(fake.messages.find((message) => message.id === 'bad')?.error).toEqual({
		code: -32000,
		message: 'refused',
	});
});
test('rejects pending requests on process exit', async () => {
	const { fake, client } = setup();
	await client.ensureReady();
	const response = client.request('hang', {});
	const caught = response.catch((error) => error);
	await waitFor(() =>
		fake.messages.some((message) => message.method === 'hang'),
	);
	fake.exit(1);
	expect(String(await caught)).toContain('Codex app-server stopped');
	expect(client.getState().state).toBe('down');
});
test('times out a request', async () => {
	const { client } = setup();
	await client.ensureReady();
	await expect(client.request('hang', {}, { timeoutMs: 5 })).rejects.toThrow(
		'Timed out waiting for hang',
	);
});
test('restarts lazily after an exit', async () => {
	const first = createFakeAppServer();
	const second = createFakeAppServer();
	const fakes = [first, second];
	let index = 0;
	const client = createAppServerClient({
		spawnProcess: () => {
			const fake = fakes[index++];
			if (!fake) throw new Error('Unexpected restart');
			return fake.transport;
		},
		backoffMs: 0,
	});
	clients.push(client);
	await client.ensureReady();
	first.exit(1);
	await waitFor(() => client.getState().state === 'down');
	await client.ensureReady();
	expect(index).toBe(2);
	expect(client.getState().state).toBe('ready');
});

test('classifies RPC, timeout, disconnect and spawn failures', async () => {
	const { fake, client } = setup();
	await client.ensureReady();
	const rpc = client.request('refuse', {});
	const rpcCaught = rpc.catch((error: unknown) => error);
	await waitFor(() =>
		fake.messages.some((message) => message.method === 'refuse'),
	);
	fake.send({
		id: fake.messages.find((message) => message.method === 'refuse')?.id,
		error: { code: -32001, message: 'refused' },
	});
	expect(await rpcCaught).toMatchObject({ kind: 'rpc', code: -32001 });
	await expect(
		client.request('timeout', {}, { timeoutMs: 5 }),
	).rejects.toMatchObject({ kind: 'timeout' });
	const disconnected = client
		.request('disconnect', {})
		.catch((error: unknown) => error);
	await waitFor(() =>
		fake.messages.some((message) => message.method === 'disconnect'),
	);
	fake.exit(1);
	expect(await disconnected).toMatchObject({ kind: 'disconnected' });
	const unspawnable = createAppServerClient({
		spawnProcess: () => {
			throw new Error('spawn failed');
		},
	});
	clients.push(unspawnable);
	await expect(unspawnable.ensureReady()).rejects.toMatchObject({
		kind: 'disconnected',
		method: 'initialize',
	});
});

test('classifies write failures as disconnected', async () => {
	const { fake, client } = setup();
	await client.ensureReady();
	fake.transport.stdin.write = () => {
		throw new Error('write failed');
	};
	await expect(client.request('send', {})).rejects.toMatchObject({
		kind: 'disconnected',
		method: 'send',
	});
});
