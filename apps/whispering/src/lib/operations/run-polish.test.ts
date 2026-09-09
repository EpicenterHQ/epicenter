/**
 * Polish reads the ready document at invocation, preserves raw text on cancellation
 * and failure, and sends no request for disabled or missing selections.
 */
import { expect, mock, test } from 'bun:test';
import { createAppAi } from '@epicenter/app/ai';
import { createAiConfiguration } from '@epicenter/app/ai-configuration';
import { expectErr, expectOk } from 'wellcrafted/testing';

let currentApp: unknown;
let reads = 0;
mock.module('../application.js', () => ({
	getApp() {
		reads++;
		return currentApp;
	},
}));
const { runPolish } = await import('./run-polish.js');

function setup() {
	const values = new Map<string, unknown>([
		['completionModel', 'chosen'],
		['polishEnabled', true],
		['polishInstructions', 'Fix punctuation.'],
		['dictionary', ['Epicenter']],
	]);
	const configuration = createAiConfiguration({
		storageKey: 'polish',
		storage: { getItem: () => null, setItem() {}, removeItem() {} },
	});
	const controller = new AbortController();
	const requests: unknown[] = [];
	let fail = false;
	let delayed = false;
	const started = Promise.withResolvers<void>();
	const owner = createAppAi({
		configuration,
		account: null,
		runtime: null,
		lifetime: {
			signal: controller.signal,
			assertUsable: () => controller.signal.throwIfAborted(),
		},
		configuredFetch: async (_input, init) => {
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
		},
	});
	const id = configuration.add({
		name: 'Chosen',
		baseUrl: 'https://chosen.example/v1',
		models: ['chosen'],
	});
	configuration.select('completion', { connectionId: id, model: 'chosen' });
	currentApp = {
		ai: owner.value.ai,
		account: null,
		kv: { get: (key: string) => values.get(key) },
	};
	return {
		values,
		requests,
		configuration,
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

test('importing Polish reads no App or device configuration', () => {
	expect(reads).toBe(0);
});

test('Polish reads current settings and sends the selected model and dictionary', async () => {
	const fixture = setup();
	try {
		expect(expectOk(await runPolish({ input: 'hello epicenter' }))).toBe(
			'Hello, Epicenter.',
		);
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
	const fixture = setup();
	try {
		fixture.values.set('polishEnabled', false);
		expect(expectOk(await runPolish({ input: 'raw' }))).toBe('raw');
		fixture.values.set('polishEnabled', true);
		expect(expectOk(await runPolish({ input: '  ' }))).toBe('  ');
		fixture.configuration.remove(fixture.id);
		expect(expectOk(await runPolish({ input: 'raw' }))).toBe('raw');
		expect(fixture.requests).toHaveLength(0);
	} finally {
		await fixture.close();
	}
});

test('cancellation returns raw text and request failure carries a raw fallback', async () => {
	const fixture = setup();
	try {
		const controller = new AbortController();
		controller.abort();
		expect(
			expectOk(await runPolish({ input: 'raw', signal: controller.signal })),
		).toBe('raw');
		fixture.fail();
		expect(expectErr(await runPolish({ input: 'raw' })).fallback).toBe('raw');
	} finally {
		await fixture.close();
	}
});

test('retained operations refuse a closed App', async () => {
	const fixture = setup();
	await fixture.close();
	await expect(runPolish({ input: 'raw' })).rejects.toThrow('closed');
	expect(fixture.requests).toHaveLength(0);
});

test('ship raw cancels an in-flight Polish request', async () => {
	const fixture = setup();
	try {
		fixture.delay();
		const controller = new AbortController();
		const pending = runPolish({ input: 'raw', signal: controller.signal });
		await fixture.started;
		controller.abort();
		expect(expectOk(await pending)).toBe('raw');
		expect(fixture.requests).toHaveLength(1);
	} finally {
		await fixture.close();
	}
});
