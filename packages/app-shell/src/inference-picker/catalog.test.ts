import { createRuntimeTranscriber } from '../../../app/src/runtime-transcriber.js';
/**
 * Explicit inference destination tests. Identical model ids cannot redirect a
 * workflow to another connection, and missing selections never use hosted auth.
 * Discovery suggests models but cannot revoke a user's explicit selection.
 */
import { expect, test } from 'bun:test';
import {
	type AiTransport,
	createInference,
} from '../../../app/src/inference.js';
import { openConnectionCatalog } from '../../../app/src/connection-catalog.js';
import type { InferenceSources } from '../inference-target.js';
import { createAiConnections } from '@epicenter/app/ai-connections';
import { expectOk } from 'wellcrafted/testing';
import { createInferenceSelections } from '../inference-selections.js';
import { createInferenceCatalog } from './catalog.svelte.js';

Reflect.set(globalThis, '$state', { raw: <T>(value: T) => value });

async function setup(
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

	const hosted = {
		baseURL: 'https://epicenter.example/v1',
		fetch: () => Promise.resolve(Response.json({ data: [] })),
	};
	const account = {
		...createInference(hosted),
		identity: {
			authorityId: 'https://epicenter.example',
			principalId: principalId as NonNullable<
				InferenceSources['account']
			>['identity']['principalId'],
		},
	};
	const runtimeHandle = runtime ? createRuntimeTranscriber(async () => { const result = await runtime.fetch(`${runtime.baseURL}/models`); const data = await result.json(); return data.data.map((model: { id: string }) => ({ ...model, active: false, installed: true })); }) : null;
	const connections = await openConnectionCatalog(records);
	const ai = { account, runtime: runtimeHandle, connections };
	const catalog = createInferenceCatalog({
		ai,
		hostedModels: [{ id: 'shared-model', label: 'Hosted', credits: 1 }],
	});
	const selections = createInferenceSelections({
		storageKey: 'test',
		storage: {
			getItem: (key) => values.get(key) ?? null,
			setItem: (key, value) => {
				values.set(key, value);
			},
		},
	});

	return {
		catalog,
		selections,
		hosted,
		values,
		close: () => {
			return Promise.all([
				account.close(),
				runtimeHandle?.close(),
				connections.close(),
			]);
		},
	};
}

test('the same model selects either custom connection or hosted independently', async () => {
	const { catalog, selections, hosted } = await setup();
	const first = 'http://localhost:11434/v1';
	const second = 'http://localhost:1234/v1';
	const firstId = await catalog.ai.connections!.add({
		baseUrl: first,
		models: ['shared-model'],
	});
	const secondId = await catalog.ai.connections!.add({
		baseUrl: second,
		models: ['shared-model'],
	});
	selections.set('first', {
		connectionId: firstId,
		model: 'shared-model',
	});
	selections.set('second', {
		connectionId: secondId,
		model: 'shared-model',
	});
	selections.set('paid', {
		connectionId: catalog.accountId!,
		model: 'shared-model',
	});
	expect(catalog.resolve(selections.get('first'))).toMatchObject({
		model: 'shared-model',
		source: 'custom',
	});
	expect(catalog.resolve(selections.get('paid'))?.source).toBe('account');
	expect(catalog.resolve(selections.get('first'))).toMatchObject({ client: { baseURL: first } });
	expect(catalog.resolve(selections.get('second'))).toMatchObject({
		client: { baseURL: second },
	});
	expect(catalog.resolve(selections.get('paid'))).toMatchObject({
		client: { baseURL: hosted.baseURL },
	});
	await catalog.ai.connections!.add({
		baseUrl: first,
		models: ['shared-model'],
	});
	expect(catalog.resolve(selections.get('second'))).toMatchObject({
		client: { baseURL: second },
	});
});

test('missing selections and empty models have no transport', async () => {
	const { catalog, selections } = await setup();
	expect(catalog.resolve(selections.get('new-device'))).toBeNull();
	expect(
		catalog.resolve({ connectionId: catalog.accountId!, model: '   ' }),
	).toBeNull();
});

test('removing then readding a connection does not resurrect its selections', async () => {
	const { catalog, selections } = await setup();
	const baseUrl = 'http://localhost:11434/v1';
	const id = await catalog.ai.connections!.add({
		baseUrl,
		models: ['shared-model'],
	});
	selections.set('conversation', {
		connectionId: id,
		model: 'shared-model',
	});
	await catalog.ai.connections!.remove(id);
	expect(selections.get('conversation')?.connectionId).toBe(id);
	expect(catalog.resolve(selections.get('conversation'))).toBeNull();
	const replacement = await catalog.ai.connections!.add({
		baseUrl,
		models: ['shared-model'],
	});
	expect(replacement).not.toBe(id);
	expect(catalog.resolve(selections.get('conversation'))).toBeNull();
});

test('manual models resolve even when discovery returns an empty list', async () => {
	const server = Bun.serve({
		port: 0,
		fetch: () => Response.json({ data: [] }),
	});
	try {
		const { catalog, selections } = await setup();
		const baseUrl = `${server.url}v1`;
		const id = await catalog.ai.connections!.add({
			baseUrl,
			models: ['manual-model'],
		});
		selections.set('conversation', {
			connectionId: id,
			model: 'manual-model',
		});
		await catalog.refresh(id);
		expect(catalog.custom[0]?.models).toContain('manual-model');
		expect(catalog.resolve(selections.get('conversation'))).toMatchObject({ client: { baseURL: baseUrl } });
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
		const { catalog, selections, hosted } = await setup();
		hosted.fetch = () => {
			throw new Error('Hosted transport must not run');
		};
		const baseUrl = `${server.url}v1`;
		const id = await catalog.ai.connections!.add({
			baseUrl,
			apiKey: 'custom-key',
		});
		selections.set('conversation', {
			connectionId: id,
			model: 'manual-model',
		});
		const transport = catalog.resolve(selections.get('conversation'));
		if (!transport || transport.source === 'runtime') throw new Error('Expected selected custom connection');
		await transport.client.models.list();
		expect(received.authorization).toBe('Bearer custom-key');
	} finally {
		server.stop(true);
	}
});

test('adding a manual model to a saved connection retains earlier model choices', async () => {
	const { catalog } = await setup();
	const baseUrl = 'http://localhost:1234/v1';
	const id = await catalog.ai.connections!.add({
		baseUrl,
		apiKey: 'key',
		models: ['first'],
	});
	await catalog.ai.connections!.update(id, {
		models: [...catalog.custom[0]!.models, 'second'],
	});
	expect(catalog.custom[0]?.models).toEqual(['first', 'second']);
});

test('a saved account A selection cannot resolve through account B', async () => {
	const first = await setup();
	first.selections.set('chat', {
		connectionId: first.catalog.accountId!,
		model: 'shared-model',
	});
	await first.close();
	const second = await setup(first.values, 'B');
	expect(second.selections.get('chat')?.connectionId).toBe(
		first.catalog.accountId!,
	);
	expect(second.catalog.resolve(second.selections.get('chat'))).toBeNull();
	expect(second.catalog.accountId).not.toBe(first.catalog.accountId!);
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
	const fixture = await setup();
	try {
		const first = await fixture.catalog.ai.connections!.add({
			baseUrl: String(server.url),
			apiKey: 'first',
		});
		const second = await fixture.catalog.ai.connections!.add({
			baseUrl: String(server.url),
			apiKey: 'second',
		});
		expect(first).not.toBe(second);
		for (const id of [first, second]) {
			fixture.selections.set('chat', {
				connectionId: id,
				model: 'manual',
			});
			const target = fixture.catalog.resolve(fixture.selections.get('chat'));
            if (!target || target.source === 'runtime') throw new Error('Expected network target');
            await target.client.models.list();
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
	const fixture = await setup(undefined, 'A', runtime);
	expect(requests).toBe(0);
	await fixture.catalog.refreshRuntime();
	expect(fixture.catalog.runtimeModels).toEqual(['installed-model']);
	expect(fixture.catalog.resolve(fixture.selections.get('audio'))).toBeNull();
	fixture.selections.set('audio', {
		connectionId: fixture.catalog.runtimeId!,
		model: 'manual-model',
	});
	expect(fixture.catalog.resolve(fixture.selections.get('audio'))?.source).toBe(
		'runtime',
	);
	expect(
		fixture.catalog.runtimeId,
	).toBe('runtime:native-transcription');
	await fixture.close();
	const absent = await setup(fixture.values);
	expect(absent.catalog.resolve(absent.selections.get('audio'))).toBeNull();
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
	const fixture = await setup();
	try {
		const id = await fixture.catalog.ai.connections!.add({
			baseUrl: String(server.url),
			apiKey: 'saved-key',
		});
		const result = await fixture.catalog.discover(
			fixture.catalog.ai.connections!.get(id)!.client,
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
	const fixture = await setup();
	try {
		const id = await fixture.catalog.ai.connections!.add({
			baseUrl: String(server.url),
			models: ['manual-model'],
		});
		fixture.values.set = () => {
			throw new Error('Storage is full.');
		};
		await expect(fixture.catalog.refresh(id)).rejects.toThrow(
			'Storage is full.',
		);
		expect(fixture.catalog.ai.connections!.get(id)?.models).toEqual([
			'manual-model',
		]);
	} finally {
		await fixture.close();
		server.stop(true);
	}
});


test('pending optional inference leaves a usable catalog that reports its acquisition failure', async () => {
    const pending = Promise.withResolvers<InferenceSources>();
    const catalog = createInferenceCatalog({ ai: pending.promise, hostedModels: [] });
    expect(catalog.loading).toBe(true);
    expect(catalog.custom).toEqual([]);
    expect(catalog.resolve(null)).toBeNull();
    pending.resolve({ account: null, runtime: null, connections: null, errors: ['Saved connections could not open.'] });
    await catalog.ready;
    expect(catalog.loading).toBe(false);
    expect(catalog.errors).toEqual(['Saved connections could not open.']);
});

test('departure cancels model discovery before it can publish saved model suggestions', async () => {
    const fixture = await setup();
    const departure = new AbortController();
    const entered = Promise.withResolvers<AbortSignal>();
    const catalog = createInferenceCatalog({ ai: fixture.catalog.ai, hostedModels: [], signal: departure.signal });
    const result = catalog.discover(new (await import('openai')).default({
        baseURL: 'https://discovery.example/v1', apiKey: 'test', dangerouslyAllowBrowser: true, maxRetries: 0,
        fetch: async (_input, init) => {
            const signal = init!.signal!;
            entered.resolve(signal);
            return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        },
    }));
    const requestSignal = await entered.promise;
    departure.abort();
    expect(requestSignal.aborted).toBe(true);
    expect((await result).error).not.toBeNull();
    await fixture.close();
});
