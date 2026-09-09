/**
 * Completion uses the selected App AI client and model without substitution.
 * Missing, removed, and mismatched selections never send text to another client.
 */
import { expect, mock, test } from 'bun:test';
import { createAppAi } from '@epicenter/app/ai';
import { createAiConfiguration } from '@epicenter/app/ai-configuration';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createInferenceConnections } from '../../../../../packages/app-shell/src/inference-picker/connections.svelte.js';
import { resolveCompletionState as resolveCompletionPresentation } from '../state/completion.svelte.js';
import {
	completeWithGlobalDefault,
	resolveCompletionState,
} from './completion.js';

let currentApp: unknown;
Reflect.set(globalThis, '$state', { raw: <T>(value: T) => value });
mock.module('../application.js', () => ({ getApp: () => currentApp }));

function setup(values = new Map<string, string>(), principalId = 'A') {
	let model = 'same-model';
	const requests: { url: string; key: string | null; model: string }[] = [];
	const configuration = createAiConfiguration({
		storageKey: 'completion-test',
		storage: {
			getItem: (key) => values.get(key) ?? null,
			setItem: (key, value) => {
				values.set(key, value);
			},
			removeItem: (key) => {
				values.delete(key);
			},
		},
	});
	const controller = new AbortController();
	const owner = createAppAi({
		configuration,
		lifetime: {
			signal: controller.signal,
			assertUsable: () => controller.signal.throwIfAborted(),
		},
		runtime: null,
		account: {
			baseURL: 'https://hosted.example/v1',
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
		app: {
			ai: owner.value.ai,
			account: {
				authorityId: 'https://hosted.example',
				principalId,
			} as NonNullable<
				Parameters<typeof createInferenceConnections>[0]['app']['account']
			>,
		},
		hostedModels: [{ id: model, label: 'Hosted', credits: 1 }],
	});

	currentApp = {
		ai: owner.value.ai,
		account: { authorityId: 'https://hosted.example', principalId },
		kv: { get: () => model },
	};
	const run = () =>
		completeWithGlobalDefault({
			systemPrompt: 'Fix grammar',
			userPrompt: 'hello',
		});
	return {
		values,
		close: () => {
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
		const id = connections.add({ baseUrl, apiKey: path }, ['same-model']);
		connections.select('completion', {
			connectionId: id,
			model: 'same-model',
		});
		expect(expectOk(await run())).toBe('custom result');
	}
	connections.select('completion', {
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
	const id = connections.add({ baseUrl });
	connections.select('completion', {
		connectionId: id,
		model: 'same-model',
	});
	setModel('changed-on-another-device');
	expectErr(await run());
	setModel('same-model');
	connections.remove(id);
	expectErr(await run());
	connections.add({ baseUrl });
	expectErr(await run());
	expect(requests).toEqual([]);
});

test('manual model survives empty discovery and transcription selection stays independent', async () => {
	const { connections, requests, run } = setup();
	const baseUrl = 'http://localhost:11434/v1';
	const id = connections.add({ baseUrl });
	connections.select('completion', {
		connectionId: id,
		model: 'same-model',
	});
	connections.select('transcription', {
		connectionId: connections.accountId!,
		model: 'same-model',
	});
	await connections.refresh(id);
	expect(resolveCompletionState().canRun).toBe(true);
	expect(expectOk(await run())).toBe('custom result');
	expect(requests[0]?.url).toBe(`${baseUrl}/chat/completions`);
});

test('destination labels distinguish paths and omit URL secrets', () => {
	const { connections } = setup();
	const baseUrl = 'https://user:secret@proxy.example/first/v1?token=secret';
	const id = connections.add({ baseUrl });
	connections.select('completion', {
		connectionId: id,
		model: 'same-model',
	});
	expect(resolveCompletionPresentation().destination).toBe(
		'https://proxy.example/first/v1',
	);
});

test('an account A completion selection sends no text after opening account B', async () => {
	const first = setup();
	first.connections.select('completion', {
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
	const first = fixture.connections.add({ baseUrl, apiKey: 'first' });
	const second = fixture.connections.add({ baseUrl, apiKey: 'second' });
	expect(first).not.toBe(second);
	for (const id of [first, second]) {
		fixture.connections.select('completion', {
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
