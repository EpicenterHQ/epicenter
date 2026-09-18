/**
 * Saved transcription captures its exact SDK client/model before reading audio.
 * Tests multipart bytes, hints, account/configured isolation, removed selections,
 * retirement, and output suppression through actual App AI SDK clients.
 */

import { expect, mock, test } from 'bun:test';
import { type AppAi, createAppAi } from '@epicenter/app/ai';
import { createAiConnections } from '@epicenter/app/ai-connections';
import {
	createInferenceSelections,
	type InferenceSelections,
} from '@epicenter/app-shell/inference-selections';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { WhisperingApp, WhisperingAppHandle } from '../whispering/app.js';

let activeApp: WhisperingAppHandle;
let currentSelections: InferenceSelections;
mock.module('../application.js', () => ({
	getApp: () => activeApp,
	getSelections: () => currentSelections,
}));
const { transcribeAudio, transcribeAndPersist, captureTranscription } =
	await import('./transcribe.js');

async function setup({
	response = () => Response.json({ text: '  spoken words  ' }),
	principal = 'alice',
	selectModel = true,
}: {
	response?: () => Response | Promise<Response>;
	principal?: string;
	selectModel?: boolean;
} = {}) {
	const requests: Request[] = [];
	const savedConnections = new Map<string, string>();
	const records = createAiConnections({
		storageKey: 'test',
		storage: {
			getItem: (key) => savedConnections.get(key) ?? null,
			setItem: (key, value) => {
				savedConnections.set(key, value);
			},
		},
	});
	const selections = createInferenceSelections({
		storageKey: 'selection-test',
		storage: { getItem: () => null, setItem() {} },
	});
	currentSelections = selections;
	const controller = new AbortController();
	const owner = createAppAi({
		connections: records,
		lifetime: {
			signal: controller.signal,
			assertUsable: () => controller.signal.throwIfAborted(),
		},
		runtime: null,
		account: {
			baseURL: 'https://account.example/v1',
			identity: {
				authorityId: 'https://account.example',
				principalId: 'me' as NonNullable<
					AppAi['account']
				>['identity']['principalId'],
			},
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return response();
			},
		},
		configuredFetch: async (input, init) => {
			requests.push(new Request(input, init));
			return response();
		},
	});
	const values = new Map<string, unknown>([
		['transcriptionModel', 'saved-model'],
		['transcriptionLanguage', 'en'],
		['transcriptionPrompt', '  Spell carefully  '],
		['dictionary', ['Epicenter', 'Yjs']],
	]);
	const audio = new Blob([new Uint8Array([1, 2, 3])], {
		type: 'audio/ogg;codecs=opus',
	});
	let load = async () => Ok(audio);
	const app = {
		signal: controller.signal,
		account: {
			identity: { authorityId: 'server', principalId: principal },
			connection: owner.value.ai.account,
		},
		device: {
			connections: {
				runtime: owner.value.ai.runtime,
				custom: owner.value.ai.connections,
			},
			kv: { get: (key: string) => values.get(key) },
		},
		blobs: { get: () => load() },
	} as unknown as WhisperingAppHandle;
	activeApp = app;
	const id = await owner.value.ai.connections!.add({
		name: 'Chosen',
		baseUrl: 'https://chosen.example/custom/v1',
		apiKey: 'chosen-key',
		models: [],
	});
	if (selectModel)
		selections.set('transcription', {
			connectionId: id,
			model: 'saved-model',
		});
	return {
		app,
		values,
		selections,
		id,
		requests,
		controller,
		audio,
		setLoad(next: typeof load) {
			load = next;
		},
		run: () =>
			transcribeAudio('recording-id', {
				signal: controller.signal,
				recordings: {
					get: () => ({ id: 'recording-id' }),
					readAudio: () => load(),
				},
			} as unknown as WhisperingApp),
		close: async () => {
			selections[Symbol.dispose]();
			controller.abort();
			await owner.close();
		},
	};
}

test('exact configured client sends multipart bytes, model, credential, and dictionary hints', async () => {
	const fixture = await setup();
	await fixture.app.device.connections.custom!.add({
		baseUrl: 'https://other.example/v1',
		apiKey: 'other-key',
		models: ['saved-model'],
	});
	expect(expectOk(await fixture.run())).toBe('spoken words');
	const request = fixture.requests[0]!;
	expect(request.url).toBe(
		'https://chosen.example/custom/v1/audio/transcriptions',
	);
	expect(request.headers.get('authorization')).toBe('Bearer chosen-key');
	const form = await request.formData();
	expect(form.get('model')).toBe('saved-model');
	expect(form.get('language')).toBe('en');
	expect(form.get('prompt')).toBe('Spell carefully Epicenter, Yjs');
	const file = form.get('file') as File;
	expect(file.name).toBe('audio.ogg');
	expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3]);
	await fixture.close();
});

test('selection and model edits during a delayed blob read cannot retarget an admitted request', async () => {
	const fixture = await setup();
	const loading = Promise.withResolvers<void>();
	fixture.setLoad(async () => {
		await loading.promise;
		return Ok(fixture.audio);
	});
	const pending = fixture.run();
	const other = await fixture.app.device.connections.custom!.add({
		baseUrl: 'https://other.example/v1',
	});
	fixture.values.set('transcriptionModel', 'new-model');
	fixture.selections.set('transcription', {
		connectionId: other,
		model: 'new-model',
	});
	loading.resolve();
	expectOk(await pending);
	expect(fixture.requests[0]!.url).toContain('chosen.example');
	expect((await fixture.requests[0]!.formData()).get('model')).toBe(
		'saved-model',
	);
	await fixture.close();
});

test('removal during blob loading retires the captured client instead of selecting a replacement', async () => {
	const fixture = await setup();
	const loading = Promise.withResolvers<void>();
	fixture.setLoad(async () => {
		await loading.promise;
		return Ok(fixture.audio);
	});
	const pending = fixture.run();
	await fixture.app.device.connections.custom!.remove(fixture.id);
	await fixture.app.device.connections.custom!.add({
		baseUrl: 'https://chosen.example/custom/v1',
		models: ['saved-model'],
	});
	loading.resolve();
	expectErr(await pending);
	expect(fixture.requests).toHaveLength(0);
	await fixture.close();
});

test('missing, mismatched, and another actor selections send no audio', async () => {
	for (const change of [
		(f: Awaited<ReturnType<typeof setup>>) =>
			f.app.device.connections.custom!.remove(f.id),
		(f: Awaited<ReturnType<typeof setup>>) =>
			f.values.set('transcriptionModel', 'mismatch'),
		(f: Awaited<ReturnType<typeof setup>>) =>
			f.selections.set('transcription', {
				connectionId: 'account:["server","bob"]',
				model: 'saved-model',
			}),
	]) {
		const fixture = await setup();
		await change(fixture);
		expect(expectErr(await fixture.run()).name).toBe('SelectionRequired');
		expect(fixture.requests).toHaveLength(0);
		await fixture.close();
	}
});

test('account credit failures stay credit-aware while configured 402 remains a request failure', async () => {
	for (const account of [false, true]) {
		const fixture = await setup({
			response: () =>
				Response.json({ error: { message: 'No credits' } }, { status: 402 }),
		});
		if (account)
			fixture.selections.set('transcription', {
				connectionId: 'account:["https://account.example","me"]',
				model: 'saved-model',
			});
		expect(expectErr(await fixture.run()).name).toBe(
			account ? 'InsufficientCredits' : 'RequestFailed',
		);
		await fixture.close();
	}
});

test('malformed output fails and a retained operation sends nothing after closure', async () => {
	for (const response of [
		() => Response.json({}),
		() => Response.json({ text: 4 }),
		() =>
			new Response('{', { headers: { 'content-type': 'application/json' } }),
	]) {
		const fixture = await setup({ response });
		expect(expectErr(await fixture.run()).name).toBe('Malformed');
		await fixture.close();
		expectErr(await fixture.run());
		expect(fixture.requests).toHaveLength(1);
	}
});

test('capture retains the original inference target before recording exists', async () => {
	const fixture = await setup();
	const domain = {
		signal: fixture.controller.signal,
		recordings: {
			get: () => ({ id: 'recording-id' }),
			readAudio: async () => Ok(fixture.audio),
		},
	} as unknown as WhisperingApp;
	const transcribe = captureTranscription(domain);
	fixture.values.set('transcriptionModel', 'changed-model');
	fixture.selections.set('transcription', {
		connectionId: fixture.id,
		model: 'changed-model',
	});
	expectOk(await transcribe!('recording-id'));
	const sent = await fixture.requests[0]!.formData();
	expect(sent.get('model')).toBe('saved-model');
	await fixture.close();
});

test('row deletion during local read prevents sending audio to inference', async () => {
	const fixture = await setup();
	let exists = true;
	const domain = {
		signal: fixture.controller.signal,
		recordings: {
			get: () => (exists ? { id: 'recording-id' } : undefined),
			readAudio: async () => {
				exists = false;
				return Ok(fixture.audio);
			},
		},
	} as unknown as WhisperingApp;
	expect(
		expectErr(await captureTranscription(domain)!('recording-id')).name,
	).toBe('Closed');
	expect(fixture.requests).toHaveLength(0);
	await fixture.close();
});

test('SDK completion after retirement cannot publish transcript or history', async () => {
	const started = Promise.withResolvers<void>();
	const finished = Promise.withResolvers<Response>();
	const fixture = await setup({
		response: () => {
			started.resolve();
			return finished.promise;
		},
	});
	const patch = mock();
	const domain = {
		signal: fixture.controller.signal,
		recordings: {
			get: () => ({ id: 'recording-id' }),
			patch,
			readAudio: async () => Ok(fixture.audio),
		},
	} as unknown as WhisperingApp;
	const pending = transcribeAndPersist(domain, 'recording-id');
	await started.promise;
	const closing = fixture.close();
	finished.resolve(Response.json({ text: 'late words' }));
	await closing;
	expectErr(await pending);
	expect(patch).not.toHaveBeenCalled();
});

test('retired provider settings cannot route audio or adopt a key', async () => {
	for (const provider of [
		'Deepgram',
		'ElevenLabs',
		'Mistral',
		'OpenAI',
		'Groq',
		'speaches',
	]) {
		const fixture = await setup({ selectModel: false });
		fixture.values.set('transcriptionService', provider);
		fixture.values.set('providers.deepgram.apiKey', 'legacy-key');
		expect(expectErr(await fixture.run()).name).toBe('SelectionRequired');
		expect(fixture.requests).toHaveLength(0);
		expect(fixture.values.get('providers.deepgram.apiKey')).toBe('legacy-key');
		await fixture.close();
	}
});

for (const { audio, filename, contentType } of [
	{
		audio: new File(['original'], 'VOICE.WAV'),
		filename: 'audio.wav',
		contentType: 'audio/wav',
	},
	{
		audio: new Blob(['original'], { type: 'video/webm' }),
		filename: 'audio.webm',
		contentType: 'video/webm',
	},
	{
		audio: new Blob(['original']),
		filename: 'audio.bin',
		contentType: 'application/octet-stream',
	},
]) {
	test(`configured SDK transcription sends ${filename} using shared format evidence`, async () => {
		const fixture = await setup();
		try {
			fixture.setLoad(async () => Ok(audio));
			expectOk(await fixture.run());
			const request = fixture.requests[0]!;
			const multipart = await request.clone().text();
			expect(multipart).toContain(`filename="${filename}"`);
			expect(multipart).toContain(`Content-Type: ${contentType}\r\n`);
			const file = (await request.formData()).get('file') as File;
			expect(await file.text()).toBe('original');
		} finally {
			await fixture.close();
		}
	});
}

test('no selection captures audio-only intent; later setup applies only to deliberate transcription', async () => {
	const fixture = await setup({ selectModel: false });
	const readAudio = mock(async () => Ok(fixture.audio));
	const domain = {
		signal: fixture.controller.signal,
		recordings: { get: () => ({ id: 'recording-id' }), readAudio },
	} as unknown as WhisperingApp;
	const captured = captureTranscription(domain);
	expect(captured).toBeNull();
	expect(expectErr(await transcribeAudio('recording-id', domain)).name).toBe(
		'SelectionRequired',
	);
	expect(readAudio).not.toHaveBeenCalled();
	fixture.selections.set('transcription', {
		connectionId: fixture.id,
		model: 'saved-model',
	});
	expect(captured).toBeNull();
	expectOk(await transcribeAudio('recording-id', domain));
	expect(readAudio).toHaveBeenCalledTimes(1);
	expect(fixture.requests).toHaveLength(1);
	await fixture.close();
});
