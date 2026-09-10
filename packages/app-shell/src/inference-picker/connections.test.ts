/**
 * Explicit inference destination tests. Identical model ids cannot redirect a
 * workflow to another connection, and missing selections never use hosted auth.
 * Discovery suggests models but cannot revoke a user's explicit selection.
 */
import { expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import { type AiTransport, createAppAi } from '@epicenter/app/ai';
import { createAiConnections } from '@epicenter/app/ai-connections';
import { createInferenceSelections } from '../inference-selections.js';
import { createInferenceConnections } from './connections.svelte.js';

Reflect.set(globalThis, '$state', { raw: <T>(value: T) => value });

function setup(
	values = new Map<string, string>(),
	principalId = 'A',
	runtime: AiTransport | null = null,
) {
	const records = createAiConnections({
		storageKey: 'test',
		storage: {
			getItem: (key) => values.get(key) ?? null,
			setItem: (key, value) => {
				values.set(key, value);
			},
		},
	});
	const controller = new AbortController();
	const hosted = {
		baseURL: 'https://epicenter.example/v1',
		fetch: () => Promise.resolve(Response.json({ data: [] })),
	};
	const owner = createAppAi({
		connections: records,
		lifetime: {
			signal: controller.signal,
			assertUsable: () => controller.signal.throwIfAborted(),
		},
		account: hosted,
		runtime,
	});
	const connections = createInferenceConnections({
		app: {
			ai: owner.value.ai,
			account: {
				authorityId: 'https://epicenter.example',
				principalId,
			} as NonNullable<
				Parameters<typeof createInferenceConnections>[0]['app']['account']
			>,
		},
		selections: createInferenceSelections({
			storageKey: 'test',
			storage: {
				getItem: (key) => values.get(key) ?? null,
				setItem: (key, value) => {
					values.set(key, value);
				},
			},
		}),
		hostedModels: [{ id: 'shared-model', label: 'Hosted', credits: 1 }],
	});
	return {
		connections,
		hosted,
		values,
		close: () => {
			controller.abort();
			return owner.close();
		},
	};
}

test('the same model selects either custom connection or hosted independently', async () => {
	const { connections, hosted } = setup();
	const first = 'http://localhost:11434/v1';
	const second = 'http://localhost:1234/v1';
	const firstId = await connections.app.ai.connections!.add({
		baseUrl: first,
		models: ['shared-model'],
	});
	const secondId = await connections.app.ai.connections!.add({
		baseUrl: second,
		models: ['shared-model'],
	});
	connections.selections.set('first', {
		connectionId: firstId,
		model: 'shared-model',
	});
	connections.selections.set('second', {
		connectionId: secondId,
		model: 'shared-model',
	});
	connections.selections.set('paid', {
		connectionId: connections.accountId!,
		model: 'shared-model',
	});
	expect(connections.resolve('first', 'shared-model')?.baseURL).toBe(first);
	expect(connections.resolve('second', 'shared-model')?.baseURL).toBe(second);
	expect(connections.resolve('paid', 'shared-model')?.baseURL).toBe(
		hosted.baseURL,
	);
	await connections.app.ai.connections!.add({
		baseUrl: first,
		models: ['shared-model'],
	});
	expect(connections.resolve('second', 'shared-model')?.baseURL).toBe(second);
});

test('missing selections and remotely changed models have no transport', () => {
	const { connections } = setup();
	expect(connections.resolve('new-device', 'shared-model')).toBeNull();
	connections.selections.set('conversation', {
		connectionId: connections.accountId!,
		model: 'shared-model',
	});
	expect(connections.target('conversation', 'other-model')).toBeNull();
	expect(connections.resolve('conversation', 'other-model')).toBeNull();
	expect(connections.canServe('conversation', 'other-model')).toBe(false);
});

test('removing then readding a connection does not resurrect its selections', async () => {
	const { connections } = setup();
	const baseUrl = 'http://localhost:11434/v1';
	const id = await connections.app.ai.connections!.add({
		baseUrl,
		models: ['shared-model'],
	});
	connections.selections.set('conversation', {
		connectionId: id,
		model: 'shared-model',
	});
	await connections.app.ai.connections!.remove(id);
	expect(connections.target('conversation', 'shared-model')?.connectionId).toBe(
		id,
	);
	expect(connections.resolve('conversation', 'shared-model')).toBeNull();
	const replacement = await connections.app.ai.connections!.add({
		baseUrl,
		models: ['shared-model'],
	});
	expect(replacement).not.toBe(id);
	expect(connections.resolve('conversation', 'shared-model')).toBeNull();
});

test('manual models resolve even when discovery returns an empty list', async () => {
	const server = Bun.serve({
		port: 0,
		fetch: () => Response.json({ data: [] }),
	});
	try {
		const { connections } = setup();
		const baseUrl = `${server.url}v1`;
		const id = await connections.app.ai.connections!.add({
			baseUrl,
			models: ['manual-model'],
		});
		connections.selections.set('conversation', {
			connectionId: id,
			model: 'manual-model',
		});
		await connections.refresh(id);
		expect(connections.custom[0]?.models).toContain('manual-model');
		expect(connections.resolve('conversation', 'manual-model')?.baseURL).toBe(
			baseUrl,
		);
	} finally {
		server.stop(true);
	}
});

test('custom requests carry only the custom key instead of using the hosted transport', async () => {
	const received: { authorization: string | null } = { authorization: null };
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			received.authorization = request.headers.get('Authorization');
			return Response.json({ data: [] });
		},
	});
	try {
		const { connections, hosted } = setup();
		hosted.fetch = () => {
			throw new Error('Hosted transport must not run');
		};
		const baseUrl = `${server.url}v1`;
		const id = await connections.app.ai.connections!.add({
			baseUrl,
			apiKey: 'custom-key',
		});
		connections.selections.set('conversation', {
			connectionId: id,
			model: 'manual-model',
		});
		const transport = connections.resolve('conversation', 'manual-model');
		if (!transport) throw new Error('Expected selected custom connection');
		await transport.models.list();
		expect(received.authorization).toBe('Bearer custom-key');
	} finally {
		server.stop(true);
	}
});

test('adding a manual model to a saved connection retains earlier model choices', async () => {
	const { connections } = setup();
	const baseUrl = 'http://localhost:1234/v1';
	const id = await connections.app.ai.connections!.add({
		baseUrl,
		apiKey: 'key',
		models: ['first'],
	});
	await connections.app.ai.connections!.update(id, {
		models: [...connections.custom[0]!.models, 'second'],
	});
	expect(connections.custom[0]?.models).toEqual(['first', 'second']);
});

test('a saved account A selection cannot resolve through account B', async () => {
	const first = setup();
	first.connections.selections.set('chat', {
		connectionId: first.connections.accountId!,
		model: 'shared-model',
	});
	await first.close();
	const second = setup(first.values, 'B');
	expect(second.connections.target('chat', 'shared-model')?.connectionId).toBe(
		first.connections.accountId!,
	);
	expect(second.connections.resolve('chat', 'shared-model')).toBeNull();
	expect(second.connections.accountId).not.toBe(first.connections.accountId!);
	await second.close();
});

test('same URL entries retain independent ids and credentials', async () => {
	const received: (string | null)[] = [];
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			received.push(request.headers.get('Authorization'));
			return Response.json({ data: [] });
		},
	});
	const fixture = setup();
	try {
		const first = await fixture.connections.app.ai.connections!.add({
			baseUrl: String(server.url),
			apiKey: 'first',
		});
		const second = await fixture.connections.app.ai.connections!.add({
			baseUrl: String(server.url),
			apiKey: 'second',
		});
		expect(first).not.toBe(second);
		for (const id of [first, second]) {
			fixture.connections.selections.set('chat', {
				connectionId: id,
				model: 'manual',
			});
			await fixture.connections.resolve('chat', 'manual')!.models.list();
		}
		expect(received).toEqual(['Bearer first', 'Bearer second']);
	} finally {
		await fixture.close();
		server.stop(true);
	}
});

test('native inventory suggests models without selecting or redirecting them', async () => {
	let requests = 0;
	const runtime = {
		baseURL: 'https://native-engine.example/v1',
		fetch: async () => {
			requests++;
			return Response.json({ data: [{ id: 'installed-model' }] });
		},
	};
	const fixture = setup(undefined, 'A', runtime);
	expect(requests).toBe(0);
	await fixture.connections.refreshRuntime();
	expect(fixture.connections.runtimeModels).toEqual(['installed-model']);
	expect(fixture.connections.resolve('audio', 'installed-model')).toBeNull();
	fixture.connections.selections.set('audio', {
		connectionId: fixture.connections.runtimeId!,
		model: 'manual-model',
	});
	expect(fixture.connections.resolve('audio', 'manual-model')?.baseURL).toBe(
		runtime.baseURL,
	);
	await fixture.close();
	const absent = setup(fixture.values);
	expect(absent.connections.resolve('audio', 'manual-model')).toBeNull();
	await absent.close();
});

/** Editing a connection can discover models without retrieving its saved key. */
test('discovery through a saved connection uses that connection credential', async () => {
	const received: (string | null)[] = [];
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			received.push(request.headers.get('authorization'));
			return Response.json({ data: [{ id: 'saved-model' }] });
		},
	});
	const fixture = setup();
	try {
		const id = await fixture.connections.app.ai.connections!.add({
			baseUrl: String(server.url),
			apiKey: 'saved-key',
		});
		const result = await fixture.connections.discover(
			String(server.url),
			undefined,
			id,
		);
		expect(expectOk(result)).toEqual(['saved-model']);
		expect(received).toEqual(['Bearer saved-key']);
	} finally {
		await fixture.close();
		server.stop(true);
	}
});

test('failed refresh persistence rejects and leaves the saved models unchanged', async () => {
	const server = Bun.serve({
		port: 0,
		fetch: () => Response.json({ data: [{ id: 'discovered-model' }] }),
	});
	const fixture = setup();
	try {
		const id = await fixture.connections.app.ai.connections!.add({
			baseUrl: String(server.url),
			models: ['manual-model'],
		});
		fixture.values.set = () => {
			throw new Error('Storage is full.');
		};
		await expect(fixture.connections.refresh(id)).rejects.toThrow(
			'Storage is full.',
		);
		expect(fixture.connections.app.ai.connections!.get(id)?.models).toEqual([
			'manual-model',
		]);
	} finally {
		await fixture.close();
		server.stop(true);
	}
});
