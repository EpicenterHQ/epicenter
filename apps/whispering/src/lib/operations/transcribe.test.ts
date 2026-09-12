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
import type { BlobId } from '@epicenter/blobs';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { WhisperingApp, WhisperingAppHandle } from '../whispering/app.js';

let activeApp: WhisperingAppHandle;
let currentSelections: InferenceSelections;
let bespoke: () => Promise<ReturnType<typeof Ok<string>>> = async () =>
	Ok('bespoke words');
mock.module('../application.js', () => ({
	getApp: () => activeApp,
	getSelections: () => currentSelections,
}));
mock.module('../state/secrets.svelte.js', () => ({
	secrets: { get: () => ({ status: 'available', value: 'bespoke-key' }) },
}));
mock.module('../services/transcription/cloud/deepgram.js', () => ({
	DeepgramTranscriptionServiceLive: { transcribe: () => bespoke() },
}));
const { transcribeAudio, transcribeAndPersist } = await import(
	'./transcribe.js'
);

async function setup({
	response = () => Response.json({ text: '  spoken words  ' }),
	principal = 'alice',
}: {
	response?: () => Response;
	principal?: string;
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
		['transcriptionService', 'connection'],
		['transcriptionModel', 'saved-model'],
		['transcriptionLanguage', 'en'],
		['transcriptionPrompt', '  Spell carefully  '],
		['dictionary', ['Epicenter', 'Yjs']],
		['transcriptionDeepgramModel', 'nova-3'],
	]);
	const audio = new Blob([new Uint8Array([1, 2, 3])], {
		type: 'audio/ogg;codecs=opus',
	});
	let load = async () => Ok(audio);
	const app = {
		signal: controller.signal,
		account: { authorityId: 'server', principalId: principal },
		ai: owner.value.ai,
		kv: { get: (key: string) => values.get(key) },
		blobs: { get: () => load() },
	} as unknown as WhisperingAppHandle;
	activeApp = app;
	const id = await owner.value.ai.connections!.add({
		name: 'Chosen',
		baseUrl: 'https://chosen.example/custom/v1',
		apiKey: 'chosen-key',
		models: [],
	});
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
		run: () => transcribeAudio('audio-id' as BlobId),
		close: async () => {
			selections[Symbol.dispose]();
			controller.abort();
			await owner.close();
		},
	};
}

test('exact configured client sends multipart bytes, model, credential, and dictionary hints', async () => {
	const fixture = await setup();
	await fixture.app.ai.connections!.add({
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
	const other = await fixture.app.ai.connections!.add({
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
	await fixture.app.ai.connections!.remove(fixture.id);
	await fixture.app.ai.connections!.add({
		baseUrl: 'https://chosen.example/custom/v1',
		models: ['saved-model'],
	});
	loading.resolve();
	expectErr(await pending);
	expect(fixture.requests).toHaveLength(0);
	await fixture.close();
});

test('missing, mismatched, old provider, and another actor selections send no audio', async () => {
	for (const change of [
		(f: Awaited<ReturnType<typeof setup>>) =>
			f.app.ai.connections!.remove(f.id),
		(f: Awaited<ReturnType<typeof setup>>) =>
			f.values.set('transcriptionModel', 'mismatch'),
		(f: Awaited<ReturnType<typeof setup>>) =>
			f.values.set('transcriptionService', 'OpenAI'),
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
				connectionId: 'account:["server","alice"]',
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

test('bespoke completion after retirement cannot publish transcript or history', async () => {
	const fixture = await setup();
	fixture.values.set('transcriptionService', 'Deepgram');
	const started = Promise.withResolvers<void>();
	const finished = Promise.withResolvers<ReturnType<typeof Ok<string>>>();
	bespoke = () => {
		started.resolve();
		return finished.promise;
	};
	const patch = mock();
	const domain = { recordings: { patch } } as unknown as WhisperingApp;
	const pending = transcribeAndPersist(
		domain,
		'recording-id',
		'audio-id' as BlobId,
	);
	await started.promise;
	await fixture.close();
	finished.resolve(Ok('late words'));
	expect(expectErr(await pending).name).toBe('Closed');
	expect(patch).not.toHaveBeenCalled();
});
