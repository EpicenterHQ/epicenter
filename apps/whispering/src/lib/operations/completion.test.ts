/**
 * Completion uses the selected App AI client and model without substitution.
 * Missing, removed, and mismatched selections never send text to another client.
 */

import { expect, mock, test } from 'bun:test';
import { type AiTransport, type AppAi, createAppAi } from '@epicenter/app/ai';
import { createAiConnections } from '@epicenter/app/ai-connections';
import { createNativeTransport } from '@epicenter/app/native-ai';
import {
	createInferenceSelections,
	type InferenceSelections,
} from '@epicenter/app-shell/inference-selections';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createInferenceConnections } from '../../../../../packages/app-shell/src/inference-picker/connections.svelte.js';
import { resolveCompletionState as resolveCompletionPresentation } from '../state/completion.svelte.js';
import {
	completeWithGlobalDefault,
	resolveCompletionState,
} from './completion.js';

let currentApp: unknown;
let currentSelections: InferenceSelections;
Reflect.set(globalThis, '$state', { raw: <T>(value: T) => value });
mock.module('../application.js', () => ({
	getApp: () => currentApp,
	getSelections: () => currentSelections,
}));

function setup(
	values = new Map<string, string>(),
	principalId = 'A',
	runtime: AiTransport | null = null,
) {
	let model = 'same-model';
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
	const selections = createInferenceSelections({
		storageKey: 'selection-test',
		storage: {
			getItem: (key) => values.get(key) ?? null,
			setItem: (key, value) => {
				values.set(key, value);
			},
		},
	});
	currentSelections = selections;
	const controller = new AbortController();
	const owner = createAppAi({
		connections: records,
		lifetime: {
			signal: controller.signal,
			assertUsable: () => controller.signal.throwIfAborted(),
		},
		runtime,
		account: {
			baseURL: 'https://hosted.example/v1',
			identity: {
				authorityId: 'https://hosted.example',
				principalId: principalId as NonNullable<
					AppAi['account']
				>['identity']['principalId'],
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
		},
		configuredFetch: async (input, init) => {
			if (String(input).endsWith('/models')) return Response.json({ data: [] });
			requests.push({
				url: String(input),
				key: new Headers(init?.headers).get('Authorization'),
				model: JSON.parse(String(init?.body)).model,
			});
			return Response.json({
				choices: [{ message: { content: 'custom result' } }],
			});
		},
	});
	const connections = createInferenceConnections({
		selections,
		connections: {
			runtime: owner.value.ai.runtime,
			custom: owner.value.ai.connections,
		},
		accountConnection: owner.value.ai.account,
		hostedModels: [{ id: model, label: 'Hosted', credits: 1 }],
	});

	currentApp = {
		device: {
			connections: {
				runtime: owner.value.ai.runtime,
				custom: owner.value.ai.connections,
			},
			kv: { get: () => model },
		},
		account: {
			identity: { authorityId: 'https://hosted.example', principalId },
			connection: owner.value.ai.account,
		},
	};

	const run = () =>
		completeWithGlobalDefault({
			systemPrompt: 'Fix grammar',
			userPrompt: 'hello',
		});
	return {
		values,
		close: () => {
			selections[Symbol.dispose]();
			controller.abort();
			return owner.close();
		},
		connections,
		requests,
		run,
		setModel(value: string) {
			model = value;
		},
	};
}

test('Polish and Recipe completion uses the exact connection when model IDs collide', async () => {
	const { connections, requests, run } = setup();
	for (const path of ['first', 'second']) {
		const baseUrl = `https://server.example/${path}/v1`;
		const id = await connections.ai.connections!.add({
			baseUrl,
			apiKey: path,
			models: ['same-model'],
		});
		connections.selections.set('completion', {
			connectionId: id,
			model: 'same-model',
		});
		expect(expectOk(await run())).toBe('custom result');
	}
	connections.selections.set('completion', {
		connectionId: connections.accountId!,
		model: 'same-model',
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
});

test('missing, removed, and synced-model-mismatched selections send no text', async () => {
	const { connections, requests, run, setModel } = setup();
	expectErr(await run());
	const baseUrl = 'http://localhost:11434/v1';
	const id = await connections.ai.connections!.add({ baseUrl });
	connections.selections.set('completion', {
		connectionId: id,
		model: 'same-model',
	});
	setModel('changed-on-another-device');
	expectErr(await run());
	setModel('same-model');
	await connections.ai.connections!.remove(id);
	expectErr(await run());
	await connections.ai.connections!.add({ baseUrl });
	expectErr(await run());
	expect(requests).toEqual([]);
});

test('manual model survives empty discovery and transcription selection stays independent', async () => {
	const { connections, requests, run } = setup();
	const baseUrl = 'http://localhost:11434/v1';
	const id = await connections.ai.connections!.add({ baseUrl });
	connections.selections.set('completion', {
		connectionId: id,
		model: 'same-model',
	});
	connections.selections.set('transcription', {
		connectionId: connections.accountId!,
		model: 'same-model',
	});
	await connections.refresh(id);
	expect(resolveCompletionState().canRun).toBe(true);
	expect(expectOk(await run())).toBe('custom result');
	expect(requests[0]?.url).toBe(`${baseUrl}/chat/completions`);
});

test('destination labels distinguish paths and omit URL secrets', async () => {
	const { connections } = setup();
	const baseUrl = 'https://user:secret@proxy.example/first/v1?token=secret';
	const id = await connections.ai.connections!.add({ baseUrl });
	connections.selections.set('completion', {
		connectionId: id,
		model: 'same-model',
	});
	expect(resolveCompletionPresentation().destination).toBe(
		'https://proxy.example/first/v1',
	);
});

test('an account A completion selection sends no text after opening account B', async () => {
	const first = setup();
	first.connections.selections.set('completion', {
		connectionId: first.connections.accountId!,
		model: 'same-model',
	});
	await first.close();
	const second = setup(first.values, 'B');
	expectErr(await second.run());
	expect(second.requests).toEqual([]);
	expect(
		second.connections.target('completion', 'same-model')?.connectionId,
	).toBe(first.connections.accountId!);
	await second.close();
});

test('same URL configured IDs send completion with their own credentials', async () => {
	const fixture = setup();
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
		fixture.connections.selections.set('completion', {
			connectionId: id,
			model: 'same-model',
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
	const fixture = setup(new Map(), 'A', createNativeTransport(invoke));
	fixture.connections.selections.set('completion', {
		connectionId: fixture.connections.runtimeId!,
		model: 'same-model',
	});
	const failure = expectErr(await fixture.run());
	expect(failure.name).toBe('TransportFailed');
	expect(fixture.requests).toEqual([]);
	expect(invoke).not.toHaveBeenCalled();
	await fixture.close();
});
