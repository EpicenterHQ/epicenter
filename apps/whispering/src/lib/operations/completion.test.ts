import { createRuntimeTranscriber } from '../../../../../packages/app/src/runtime-transcriber.js';
/**
 * Completion uses the selected App AI client and model without substitution.
 * Missing, removed, and blank selections never send text to another client.
 */

import { expect, mock, test } from 'bun:test';
import { createAiConnections } from '@epicenter/app/ai-connections';
import type { AccountIdentity } from '@epicenter/principal';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openConnectionCatalog } from '../../../../../packages/app/src/connection-catalog.js';
import {
	type AiTransport,
	createInference,
} from '../../../../../packages/app/src/inference.js';
import { createInferenceCatalog } from '../../../../../packages/app-shell/src/inference-picker/catalog.svelte.js';
import { completionDestination } from '../state/polish.js';
import type { WhisperingApp } from '../whispering/app.js';
import {
	completeWithGlobalDefault,
	resolveCompletionTarget,
} from './completion.js';

Reflect.set(globalThis, '$state', { raw: <T>(value: T) => value });

async function setup(
	values = new Map<string, string>(),
	principalId = 'A',
	runtime: ReturnType<typeof createRuntimeTranscriber> | null = null,
	settings = new Map<string, unknown>([['completionModel', 'same-model']]),
) {
	const kv = {
		get: (key: string) => settings.get(key),
		update: (changes: Record<string, unknown>) => {
			for (const [key, value] of Object.entries(changes))
				settings.set(key, value);
		},
	};
	const requests: { url: string; key: string | null; model: string }[] = [];
	const records = createAiConnections({
		storageKey: 'completion-test',
		storage: {
			getItem: (key) => values.get(key) ?? null,
			setItem: (key, value) => {
				values.set(key, value);
			},
		},
	});
	const controller = new AbortController();
	const accountOptions: AiTransport & { identity: AccountIdentity } = {
		baseURL: 'https://hosted.example/v1',
		identity: {
			authorityId: 'https://hosted.example',
			principalId: principalId as AccountIdentity['principalId'],
		},
		fetch: async (input, init) => {
			requests.push({
				url: String(input),
				key: 'hosted',
				model: JSON.parse(String(init?.body)).model,
			});
			return Response.json({
				choices: [{ message: { content: 'hosted result' } }],
			});
		},
	};
	const account = {
		...createInference(accountOptions),
		identity: accountOptions.identity,
	};
	const customFetch: AiTransport['fetch'] = async (input, init) => {
		if (String(input).endsWith('/models')) return Response.json({ data: [] });
		requests.push({
			url: String(input),
			key: new Headers(init?.headers).get('Authorization'),
			model: JSON.parse(String(init?.body)).model,
		});
		return Response.json({
			choices: [{ message: { content: 'custom result' } }],
		});
	};
	const owner = await openConnectionCatalog({
		...records,
		transport(record) {
			return { baseURL: record.baseUrl, fetch: customFetch };
		},
	});
	const ai = {
		account: account,
		runtime,
		connections: owner,
	};
	const connections = createInferenceCatalog({
		ai: ai,
		hostedModels: [{ id: 'same-model', label: 'Hosted', credits: 1 }],
	});

	const app = {
		signal: controller.signal,
		local: { kv },
		catalog: connections,
	} as unknown as WhisperingApp;
	mock.module('../whispering/local.js', () => ({
		local: Reflect.get(app, 'local'),
	}));
	app.personalReady = Promise.resolve(Reflect.get(app, 'personal'));

	const run = () =>
		completeWithGlobalDefault(app, {
			systemPrompt: 'Fix grammar',
			userPrompt: 'hello',
		});
	return {
		app,
		values,
		settings,
		kv,
		close: () => {
			controller.abort();
			return Promise.all([
				owner.close(),
				ai.account?.close(),
				ai.runtime?.close(),
			]);
		},
		connections,
		requests,
		run,
	};
}

test('speech cleanup uses the exact connection when model IDs collide', async () => {
	const { connections, requests, run, kv, close } = await setup();
	for (const path of ['first', 'second']) {
		const baseUrl = `https://server.example/${path}/v1`;
		const id = await connections.ai.connections!.add({
			baseUrl,
			apiKey: path,
			models: ['same-model'],
		});
		kv.update({
			completionConnection: id,
			completionModel: 'same-model',
		});
		expect(expectOk(await run())).toBe('custom result');
	}
	kv.update({
		completionConnection: connections.accountId!,
		completionModel: 'same-model',
	});
	expect(expectOk(await run())).toBe('hosted result');
	expect(requests).toEqual([
		{
			url: 'https://server.example/first/v1/chat/completions',
			key: 'Bearer first',
			model: 'same-model',
		},
		{
			url: 'https://server.example/second/v1/chat/completions',
			key: 'Bearer second',
			model: 'same-model',
		},
		{
			url: 'https://hosted.example/v1/chat/completions',
			key: 'hosted',
			model: 'same-model',
		},
	]);
	await close();
});

test('missing, removed, and blank model selections send no text', async () => {
	const { connections, requests, run, kv, close } = await setup();
	expectErr(await run());
	const baseUrl = 'http://localhost:11434/v1';
	const id = await connections.ai.connections!.add({ baseUrl });
	kv.update({
		completionConnection: id,
		completionModel: 'same-model',
	});
	kv.update({ completionModel: '  ' });
	expectErr(await run());
	kv.update({ completionModel: 'same-model' });
	await connections.ai.connections!.remove(id);
	expectErr(await run());
	await connections.ai.connections!.add({ baseUrl });
	expectErr(await run());
	expect(requests).toEqual([]);
	await close();
});

test('manual model survives empty discovery and transcription selection stays independent', async () => {
	const { app, connections, requests, run, kv, close } = await setup();
	const baseUrl = 'http://localhost:11434/v1';
	const id = await connections.ai.connections!.add({ baseUrl });
	kv.update({
		completionConnection: id,
		completionModel: 'same-model',
	});
	kv.update({
		transcriptionConnection: connections.accountId!,
		transcriptionModel: 'same-model',
	});
	await connections.refresh(id);
	expect(resolveCompletionTarget(app)).not.toBeNull();
	expect(expectOk(await run())).toBe('custom result');
	expect(requests[0]?.url).toBe(`${baseUrl}/chat/completions`);
	await close();
});

test('destination labels distinguish paths', async () => {
	const { app, connections, kv, close } = await setup();
	const baseUrl = 'https://proxy.example/first/v1';
	const id = await connections.ai.connections!.add({ baseUrl });
	kv.update({
		completionConnection: id,
		completionModel: 'same-model',
	});
	expect(completionDestination(resolveCompletionTarget(app))).toBe(
		'https://proxy.example/first/v1',
	);
	await close();
});

test('an account A completion selection sends no text after opening account B', async () => {
	const first = await setup();
	first.kv.update({
		completionConnection: first.connections.accountId!,
		completionModel: 'same-model',
	});
	await first.close();
	const second = await setup(first.values, 'B', null, first.settings);
	expectErr(await second.run());
	expect(second.requests).toEqual([]);
	expect(second.kv.get('completionConnection')).toBe(
		first.connections.accountId!,
	);
	await second.close();
});

test('same URL configured IDs send completion with their own credentials', async () => {
	const fixture = await setup();
	const baseUrl = 'https://same.example/v1';
	const first = await fixture.connections.ai.connections!.add({
		baseUrl,
		apiKey: 'first',
	});
	const second = await fixture.connections.ai.connections!.add({
		baseUrl,
		apiKey: 'second',
	});
	expect(first).not.toBe(second);
	for (const id of [first, second]) {
		fixture.kv.update({
			completionConnection: id,
			completionModel: 'same-model',
		});
		expectOk(await fixture.run());
	}
	expect(fixture.requests.map(({ key }) => key)).toEqual([
		'Bearer first',
		'Bearer second',
	]);
	await fixture.close();
});

test('native text completion refuses the unsupported operation without falling back to account', async () => {
	const invoke = mock(async () => []);
	const fixture = await setup(new Map(), 'A', createRuntimeTranscriber(invoke));
	fixture.kv.update({
		completionConnection: fixture.connections.runtimeId!,
		completionModel: 'same-model',
	});
	const failure = expectErr(await fixture.run());
	expect(failure.name).toBe('TransportFailed');
	expect(fixture.requests).toEqual([]);
	expect(invoke).not.toHaveBeenCalled();
	await fixture.close();
});

test('retired completion returns a failure Result without sending text', async () => {
	const fixture = await setup();
	fixture.kv.update({
		completionConnection: fixture.connections.accountId!,
		completionModel: 'same-model',
	});
	await fixture.close();
	expect(expectErr(await fixture.run()).name).toBe('TransportFailed');
	expect(fixture.requests).toHaveLength(0);
});
