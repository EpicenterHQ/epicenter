/**
 * Polish reads the ready document at invocation, preserves raw text on cancellation
 * and failure, and sends no request for disabled or missing selections.
 */
import { expect, mock, test } from 'bun:test';
import { createAiConnections } from '@epicenter/app/ai-connections';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openConnectionCatalog } from '../../../../../packages/app/src/connection-catalog.js';
import {
	type AiTransport,
} from '../../../../../packages/app/src/inference.js';
import { createInferenceCatalog } from '../../../../../packages/app-shell/src/inference-picker/catalog.svelte.js';
import type { WhisperingApp } from '../whispering/app.js';
import { runPolish } from './run-polish.js';

Reflect.set(globalThis, '$state', { raw: <T>(value: T) => value });

async function setup() {
	const values = new Map<string, unknown>([
		['completionModel', 'chosen'],
		['polishEnabled', true],
		['polishInstructions', 'Wrong device instructions.'],
		['dictionary', ['Wrong device dictionary']],
	]);
	const kv = {
		get: (key: string) => values.get(key),
		update: (changes: Record<string, unknown>) => {
			for (const [key, value] of Object.entries(changes))
				values.set(key, value);
		},
	};
	const savedConnections = new Map<string, string>();
	const records = createAiConnections({
		storageKey: 'polish',
		storage: {
			getItem: (key) => savedConnections.get(key) ?? null,
			setItem: (key, value) => {
				savedConnections.set(key, value);
			},
		},
	});
	const controller = new AbortController();
	const requests: unknown[] = [];
	let fail = false;
	let delayed = false;
	const started = Promise.withResolvers<void>();
	const customFetch: AiTransport['fetch'] = async (_input, init) => {
		requests.push(JSON.parse(String(init?.body)));
		if (fail) throw new Error('unavailable');
		if (delayed) {
			started.resolve();
			await new Promise<void>((_resolve, reject) => {
				const signal = init?.signal;
				if (signal?.aborted) reject(signal.reason);
				else
					signal?.addEventListener('abort', () => reject(signal.reason), {
						once: true,
					});
			});
		}
		return Response.json({
			choices: [{ message: { content: 'Hello, Epicenter.' } }],
		});
	};
	const owner = await openConnectionCatalog({
		...records,
		transport(record) {
			return { baseURL: record.baseUrl, fetch: customFetch };
		},
	});
	const ai = { account: null, runtime: null, connections: owner };
	const id = await ai.connections!.add({
		name: 'Chosen',
		baseUrl: 'https://chosen.example/v1',
		models: ['chosen'],
	});
	kv.update({ completionConnection: id, completionModel: 'chosen' });
	const personalValues = new Map<string, unknown>([
		['polishInstructions', 'Fix punctuation.'],
		['dictionary', ['Epicenter']],
	]);
	const app = {
		signal: controller.signal,
		local: { kv },
		personal: { kv: { get: (key: string) => personalValues.get(key) } },
		catalog: createInferenceCatalog({
			ai: ai,
			hostedModels: [],
		}),
	} as unknown as WhisperingApp;
	mock.module('../whispering/local.js', () => ({
		local: Reflect.get(app, 'local'),
	}));
	app.personalReady = Promise.resolve(Reflect.get(app, 'personal'));

	return {
		app,
		values,
		kv,
		requests,
		ai: ai,
		id,
		started: started.promise,
		delay() {
			delayed = true;
		},
		fail() {
			fail = true;
		},
		async close() {
			controller.abort();
			await owner.close();
		},
	};
}

test('Polish reads current settings and sends the selected model and dictionary', async () => {
	const fixture = await setup();
	try {
		expect(
			expectOk(await runPolish(fixture.app, { input: 'hello epicenter' })),
		).toBe('Hello, Epicenter.');
		expect(fixture.requests[0]).toMatchObject({
			model: 'chosen',
			messages: [
				{ role: 'system' },
				{ role: 'user', content: 'hello epicenter' },
			],
		});
		expect(JSON.stringify(fixture.requests[0])).toContain('Epicenter');
	} finally {
		await fixture.close();
	}
});

test('disabled, empty, and missing selections return raw input without inference', async () => {
	const fixture = await setup();
	try {
		fixture.values.set('polishEnabled', false);
		expect(expectOk(await runPolish(fixture.app, { input: 'raw' }))).toBe(
			'raw',
		);
		fixture.values.set('polishEnabled', true);
		expect(expectOk(await runPolish(fixture.app, { input: '  ' }))).toBe('  ');
		await fixture.ai.connections!.remove(fixture.id);
		expect(expectOk(await runPolish(fixture.app, { input: 'raw' }))).toBe(
			'raw',
		);
		expect(fixture.requests).toHaveLength(0);
	} finally {
		await fixture.close();
	}
});

test('cancellation returns raw text and request failure carries a raw fallback', async () => {
	const fixture = await setup();
	try {
		const controller = new AbortController();
		controller.abort();
		expect(
			expectOk(
				await runPolish(fixture.app, {
					input: 'raw',
					signal: controller.signal,
				}),
			),
		).toBe('raw');
		fixture.fail();
		expect(
			expectErr(await runPolish(fixture.app, { input: 'raw' })).fallback,
		).toBe('raw');
	} finally {
		await fixture.close();
	}
});

test('retained operations refuse a closed App', async () => {
	const fixture = await setup();
	await fixture.close();
	await expect(runPolish(fixture.app, { input: 'raw' })).rejects.toBe(
		fixture.app.signal.reason,
	);
	expect(fixture.requests).toHaveLength(0);
});

test('ship raw cancels an in-flight Polish request', async () => {
	const fixture = await setup();
	try {
		fixture.delay();
		const controller = new AbortController();
		const pending = runPolish(fixture.app, {
			input: 'raw',
			signal: controller.signal,
		});
		await fixture.started;
		controller.abort();
		expect(expectOk(await pending)).toBe('raw');
		expect(fixture.requests).toHaveLength(1);
	} finally {
		await fixture.close();
	}
});

test('App retirement cancels an in-flight Polish request and preserves its raw fallback', async () => {
	const fixture = await setup();
	fixture.delay();
	const pending = runPolish(fixture.app, { input: 'raw' });
	await fixture.started;
	await fixture.close();
	expect(expectErr(await pending).fallback).toBe('raw');
	expect(fixture.requests).toHaveLength(1);
});
