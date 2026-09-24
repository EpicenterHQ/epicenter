/**
 * Saved transcription captures its exact SDK client/model before reading audio.
 * Tests multipart bytes, hints, account/configured isolation, removed selections,
 * retirement, and output suppression through actual App AI SDK clients.
 */

import { expect, mock, test } from 'bun:test';
import { createAiConnections } from '@epicenter/app/ai-connections';
import type { AccountIdentity } from '@epicenter/principal';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openConnectionCatalog } from '../../../../../packages/app/src/connection-catalog.js';
import {
	type AiTransport,
	createInference,
} from '../../../../../packages/app/src/inference.js';
import { createInferenceCatalog } from '../../../../../packages/app-shell/src/inference-picker/catalog.svelte.js';
import type { WhisperingApp as ProductApp } from '../whispering/app.js';
import { createPendingSaves } from '../whispering/pending-saves.js';
import {
	captureTranscription,
	transcribeAndPersist,
	transcribeAudio,
} from './transcribe.js';

Reflect.set(globalThis, '$state', { raw: <T>(value: T) => value });

async function setup({
	response = () => Response.json({ text: '  spoken words  ' }),
	selectModel = true,
}: {
	response?: () => Response | Promise<Response>;
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
	const controller = new AbortController();
	const accountOptions: AiTransport & { identity: AccountIdentity } = {
		baseURL: 'https://account.example/v1',
		identity: {
			authorityId: 'https://account.example',
			principalId: 'me' as AccountIdentity['principalId'],
		},
		fetch: async (input, init) => {
			requests.push(new Request(input, init));
			return response();
		},
	};
	const account = {
		...createInference(accountOptions),
		identity: accountOptions.identity,
	};
	const customFetch: AiTransport['fetch'] = async (input, init) => {
		requests.push(new Request(input, init));
		return response();
	};
	const owner = await openConnectionCatalog({
		...records,
		transport(record) {
			return { baseURL: record.baseUrl, fetch: customFetch };
		},
	});
	const ai = { account: account, runtime: null, connections: owner };
	const values = new Map<string, unknown>([
		['transcriptionModel', 'saved-model'],
		['transcriptionLanguage', 'en'],
		['transcriptionPrompt', 'Wrong device prompt'],
		['dictionary', ['Wrong device dictionary']],
	]);
	const kv = {
		get: (key: string) => values.get(key),
		update: (changes: Record<string, unknown>) => {
			for (const [key, value] of Object.entries(changes))
				values.set(key, value);
		},
	};
	const audio = new Blob([new Uint8Array([1, 2, 3])], {
		type: 'audio/ogg;codecs=opus',
	});
	let load = async () => Ok(audio);
	const personalValues = new Map<string, unknown>([
		['transcriptionPrompt', '  Spell carefully  '],
		['dictionary', ['Epicenter', 'Yjs']],
	]);
	const app = {
		signal: controller.signal,
		pendingSaves: createPendingSaves(controller.signal),
		local: { kv },
		personal: { kv: { get: (key: string) => personalValues.get(key) } },
		catalog: createInferenceCatalog({
			ai: ai,
			hostedModels: [],
		}),
		store: {
			blobs: { get: () => load() },
			tables: {
				recordings: {
					get: () => ({ id: 'recording-id', audioBlobId: 'audio.wav' }),
				},
			},
		},
		localBlobs: { get: () => load() },
		remoteBlobs: null,
	} as unknown as WhisperingApp;

	mock.module('../whispering/local.js', () => ({ local: app.local }));
	app.personalReady = Promise.resolve(app.personal);
	const id = await ai.connections!.add({
		name: 'Chosen',
		baseUrl: 'https://chosen.example/custom/v1',
		apiKey: 'chosen-key',
		models: [],
	});
	if (selectModel)
		kv.update({
			transcriptionConnection: id,
			transcriptionModel: 'saved-model',
		});
	return {
		app,
		values,
		kv,
		id,
		requests,
		controller,
		audio,
		setLoad(next: typeof load) {
			load = next;
		},
		run: () => transcribeAudio('recording-id', app, app.store),
		close: async () => {
			controller.abort();
			await owner.close();
		},
	};
}

test('exact configured client sends multipart bytes, model, credential, and dictionary hints', async () => {
	const fixture = await setup();
	await fixture.app.catalog.ai.connections!.add({
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

test('signed-out transcription never falls back to device-authored prompts or dictionary', async () => {
	const fixture = await setup();
	const app = { ...fixture.app, personalReady: Promise.resolve(undefined) };
	expect(expectOk(await transcribeAudio('recording-id', app, app.store))).toBe(
		'spoken words',
	);
	const form = await fixture.requests[0]!.formData();
	expect(form.get('prompt')).toBeNull();
	expect(form.get('language')).toBe('en');
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
	const other = await fixture.app.catalog.ai.connections!.add({
		baseUrl: 'https://other.example/v1',
	});
	fixture.kv.update({
		transcriptionConnection: other,
		transcriptionModel: 'new-model',
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
	await fixture.app.catalog.ai.connections!.remove(fixture.id);
	await fixture.app.catalog.ai.connections!.add({
		baseUrl: 'https://chosen.example/custom/v1',
		models: ['saved-model'],
	});
	loading.resolve();
	expectErr(await pending);
	expect(fixture.requests).toHaveLength(0);
	await fixture.close();
});

test('missing, blank, and another actor selections send no audio', async () => {
	for (const change of [
		(f: Awaited<ReturnType<typeof setup>>) =>
			f.app.catalog.ai.connections!.remove(f.id),
		(f: Awaited<ReturnType<typeof setup>>) =>
			f.values.set('transcriptionModel', '  '),
		(f: Awaited<ReturnType<typeof setup>>) =>
			f.kv.update({
				transcriptionConnection: 'account:["server","bob"]',
				transcriptionModel: 'saved-model',
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
			fixture.kv.update({
				transcriptionConnection: 'account:["https://account.example","me"]',
				transcriptionModel: 'saved-model',
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
	const transcribe = captureTranscription(fixture.app, fixture.app.store);
	fixture.kv.update({
		transcriptionConnection: fixture.id,
		transcriptionModel: 'changed-model',
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
		...fixture.app,
		store: {
			...fixture.app.store,
			blobs: {
				get: async () => {
					exists = false;
					return Ok(fixture.audio);
				},
			},
			tables: {
				recordings: {
					get: () =>
						exists
							? { id: 'recording-id', audioBlobId: 'audio.wav' }
							: undefined,
				},
			},
		},
	} as unknown as WhisperingApp;
	expect(
		expectErr(await captureTranscription(domain, domain.store)!('recording-id'))
			.name,
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
		...fixture.app,
		store: {
			...fixture.app.store,
			tables: {
				recordings: {
					get: () => ({ id: 'recording-id', audioBlobId: 'audio.wav' }),
					update: patch,
				},
			},
		},
	} as unknown as WhisperingApp;
	const pending = transcribeAndPersist(domain, domain.store, 'recording-id');
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
		...fixture.app,
		store: { ...fixture.app.store, blobs: { get: readAudio } },
	} as unknown as WhisperingApp;
	const captured = captureTranscription(domain, domain.store);
	expect(captured).toBeNull();
	expect(
		expectErr(await transcribeAudio('recording-id', domain, domain.store)).name,
	).toBe('SelectionRequired');
	expect(readAudio).not.toHaveBeenCalled();
	fixture.kv.update({
		transcriptionConnection: fixture.id,
		transcriptionModel: 'saved-model',
	});
	expect(captured).toBeNull();
	expectOk(await transcribeAudio('recording-id', domain, domain.store));
	expect(readAudio).toHaveBeenCalledTimes(1);
	expect(fixture.requests).toHaveLength(1);
	await fixture.close();
});

test('delayed Personal inputs hold inference while preserving the captured account prompt', async () => {
	const f = await setup();
	const ready =
		Promise.withResolvers<
			ProductApp['personalReady'] extends Promise<infer T> ? T : never
		>();
	const capturedPersonal = f.app.personal;
	const app = {
		...f.app,
		authAccount: {} as WhisperingApp['authAccount'],
		personal: undefined,
		personalReady: ready.promise,
	};
	const transcribe = captureTranscription(app, app.store)!;
	const pending = transcribe('recording-id');
	await Promise.resolve();
	expect(f.requests).toHaveLength(0);
	ready.resolve(capturedPersonal);
	expectOk(await pending);
	const form = await f.requests[0]!.formData();
	expect(form.get('prompt')).toBe('Spell carefully Epicenter, Yjs');
	await f.close();
});

test('failed Personal acquisition never sends inference with silent prompt defaults', async () => {
	const f = await setup();
	const app = {
		...f.app,
		authAccount: {} as WhisperingApp['authAccount'],
		personal: undefined,
		personalReady: Promise.reject(new Error('Personal unavailable')),
	};
	expectErr(await captureTranscription(app, app.store)!('recording-id'));
	expect(f.requests).toHaveLength(0);
	await f.close();
});

test('full recovery capacity refuses inference before sending audio', async () => {
	const f = await setup();
	for (let i = 0; i < 32; i++) f.app.pendingSaves.reserve('unfinished');
	expectErr(await transcribeAndPersist(f.app, f.app.store, 'recording-id'));
	expect(f.requests).toHaveLength(0);
	await f.close();
});

type WhisperingApp = ProductApp & {
	store: import('../whispering/app.js').RecordingStore;
	local: import('../whispering/local.js').LocalStore;
	localBlobs: import('../whispering/local.js').LocalStore['blobs'];
	personal: import('../whispering/personal.js').PersonalStore;
};
