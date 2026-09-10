/** Desktop snapshot ordering and opening/closing across an asynchronous host boundary. */
import { expect, test } from 'bun:test';
import { createDesktopAiConnections } from './ai-connections.epicenter-host.js';
import { createAppAi } from './ai.js';
import type { AiTransport } from './ai.js';

function fixture(
	fetch: AiTransport['fetch'] = async () => {
		throw new Error('Unexpected request');
	},
) {
	const events: Pick<EventSource, 'onmessage' | 'onerror' | 'close'> = {
		onmessage: null,
		onerror: null,
		close() {
			closed = true;
		},
	};
	let closed = false;
	const connections = createDesktopAiConnections({
		appId: 'vocab',
		storageKey: 'vocab',
		storage: { getItem: () => null },
		baseURL: 'http://127.0.0.1:1234',
		fetch,
		openEvents: () => events,
	});
	const lifetime = new AbortController();
	const owner = createAppAi({
		connections,
		runtime: null,
		account: null,
		lifetime: {
			signal: lifetime.signal,
			assertUsable() {
				lifetime.signal.throwIfAborted();
			},
		},
	});
	return {
		app: owner.value,
		ready: owner.ready,
		publish(revision: number, name = 'Connection') {
			events.onmessage?.call(
				events as EventSource,
				new MessageEvent('message', {
					data: JSON.stringify({
						revision,
						connections: [
							{
								id: 'one',
								name,
								baseUrl: 'https://custom.example/v1',
								models: ['manual'],
								hasApiKey: true,
								accessVersion: 'access',
							},
						],
					}),
				}),
			);
		},
		fail() {
			events.onerror?.call(events as EventSource, new Event('error'));
		},
		get closed() {
			return closed;
		},
		async close() {
			lifetime.abort();
			await owner.close();
		},
	};
}

test('readiness waits for the initial host snapshot and subscribe supplies it immediately', async () => {
	const value = fixture();
	expect(() => value.app.ai.connections!.getAll()).toThrow('not ready');
	value.publish(0);
	await value.ready;
	const names: string[] = [];
	const stop = value.app.ai.connections!.subscribe((records) =>
		names.push(records[0]!.name),
	);
	value.publish(1, 'Renamed');
	stop();
	value.publish(2, 'Stopped');
	expect(names).toEqual(['Connection', 'Renamed']);
	await value.close();
	expect(value.closed).toBe(true);
});

test('an older mutation response cannot overwrite a newer stream snapshot', async () => {
	const response = Promise.withResolvers<Response>();
	const value = fixture(async () => response.promise);
	value.publish(0);
	await value.ready;
	const changing = value.app.ai.connections!.update('one', { name: 'First' });
	value.publish(2, 'Second');
	response.resolve(
		Response.json({
			snapshot: {
				revision: 1,
				connections: [
					{
						id: 'one',
						name: 'First',
						baseUrl: 'https://custom.example/v1',
						models: [],
						hasApiKey: true,
						accessVersion: 'access',
					},
				],
			},
			result: null,
		}),
	);
	await changing;
	expect(value.app.ai.connections!.get('one')!.name).toBe('Second');
	await value.close();
});

test('close before the first event settles opening and releases the subscription', async () => {
	const value = fixture();
	const failed = value.ready.then(
		() => null,
		(error) => error,
	);
	await value.close();
	expect(await failed).toBeInstanceOf(Error);
	expect(value.closed).toBe(true);
});

test('a failed initial event stream rejects readiness and releases observation', async () => {
	const value = fixture();
	value.fail();
	await expect(value.ready).rejects.toThrow('Could not open');
	expect(value.closed).toBe(true);
	await value.close();
});

test('desktop transcription preserves multipart bytes and hints while the broker owns credentials', async () => {
	const audio = new Uint8Array([82, 73, 70, 70, 0, 255, 128, 1]);
	const value = fixture(async (input, init) => {
		const request = new Request(input, init);
		expect(request.url).toBe(
			'http://127.0.0.1:1234/_epicenter/ai/inference/one/access/audio/transcriptions',
		);
		expect(request.method).toBe('POST');
		expect(request.headers.get('authorization')).toBeNull();
		expect(request.headers.get('cookie')).toBeNull();
		expect(request.credentials).toBe('include');
		expect(request.redirect).toBe('error');
		const form = await request.formData();
		const file = form.get('file');
		expect(file).toBeInstanceOf(File);
		expect(new Uint8Array(await (file as File).arrayBuffer())).toEqual(audio);
		expect(form.get('model')).toBe('manual');
		expect(form.get('language')).toBe('en');
		expect(form.get('prompt')).toBe('Epicenter');
		return Response.json({ text: 'Fixture transcript' });
	});
	value.publish(0);
	await value.ready;
	try {
		const result = await value.app.ai
			.connections!.get('one')!
			.client.audio.transcriptions.create(
				{
					model: 'manual',
					file: new File([audio], 'speech.wav', { type: 'audio/wav' }),
					language: 'en',
					prompt: 'Epicenter',
				},
				{
					headers: { authorization: 'Bearer forbidden', cookie: 'forbidden=1' },
				},
			);
		expect(result.text).toBe('Fixture transcript');
	} finally {
		await value.close();
	}
});
