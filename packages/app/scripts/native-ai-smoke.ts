/**
 * Real SDK multipart -> native adapter -> actual Tauri commands -> cached model.
 * The Tauri window/runtime is mocked; native decoding and inference are real.
 * Run with EPICENTER_NATIVE_AUDIO=/absolute/speech.wav bun packages/app/scripts/native-ai-smoke.ts.
 * Whisper Tiny must already be cached. This never downloads or changes real settings.
 */
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { createInference } from '../src/inference.js';
import { createNativeAiFixture } from './native-ai-fixture.js';

const audioPath = process.env.EPICENTER_NATIVE_AUDIO;
if (!audioPath)
	throw new Error('Set EPICENTER_NATIVE_AUDIO to an existing speech WAV.');
const file = new File([await Bun.file(audioPath).arrayBuffer()], 'speech.wav', {
	type: 'audio/wav',
});
const model = 'handy-computer/whisper-tiny-gguf@main/whisper-tiny-Q8_0.gguf';
const fixture = await createNativeAiFixture({ audioPath });
const { transport, admitted, completed } = fixture;
const lifetime = new AbortController();
const owner = createInference(transport);
const client = owner.client;

try {
	const models = await client.models.list();
	assert(
		models.data.some((entry) => entry.id === model),
		'Whisper Tiny must already be cached',
	);
	const transcription = await client.audio.transcriptions.create({
		file,
		model,
		language: 'en',
		prompt: 'The application closes its inference clients.',
	});
	assert(
		transcription.text.trim().length > 0,
		'Native engine produced speech text',
	);
	assert.deepEqual(transcription, {
		text: transcription.text,
		model,
		applied: { language: 'en', initialPrompt: true },
	});
	assert.deepEqual(admitted[1], {
		event: 'admitted',
		id: 2,
		command: 'transcribe_audio_bytes',
		modelId: model,
		hints: {
			initialPrompt: 'The application closes its inference clients.',
			language: 'en',
		},
		byteLength: file.size,
		matchesFixture: true,
	});
	assert.deepEqual(
		await client.audio.transcriptions.create({
			file: new File([], 'empty.wav'),
			model,
		}),
		{ text: '' },
	);
	await assert.rejects(
		client.audio.transcriptions.create({ file, model: 'unknown' }),
		(error: unknown) =>
			error instanceof Error &&
			String(error.cause).includes('Unknown native transcription model'),
	);
	await assert.rejects(
		client.audio.transcriptions.create({
			file: new File(['invalid audio'], 'invalid.wav'),
			model,
		}),
		(error: unknown) =>
			error instanceof Error && String(error.cause).includes('AudioReadError'),
	);
	const beforeUnsupported = admitted.length;
	await assert.rejects(
		client.audio.transcriptions.create({ file, model, temperature: 0 }),
	);
	assert.equal(
		admitted.length,
		beforeUnsupported,
		'Unsupported parameters never enter native work',
	);

	// Rust's admission event precedes the real command, whose compute cannot be interrupted.
	const cancelledAdmission = fixture.nextAdmission();
	const requestAbort = new AbortController();
	let requestSettled = false;
	const request = client.audio.transcriptions.create(
		{ file, model },
		{ signal: requestAbort.signal },
	);
	const cancellation = assert
		.rejects(
			request,
			(error: unknown) => error instanceof OpenAI.APIUserAbortError,
		)
		.finally(() => {
			requestSettled = true;
		});
	const cancelledId = await cancelledAdmission;
	requestAbort.abort();
	await Promise.resolve();
	assert.equal(
		requestSettled,
		false,
		'Caller abort waits for native completion',
	);
	await cancellation;
	assert(
		completed.some(
			(entry) =>
				entry.id === cancelledId &&
				typeof entry.value === 'object' &&
				entry.value !== null &&
				'outcome' in entry.value &&
				entry.value.outcome === 'transcribed',
		),
		'Rust finished real computation and its text was suppressed',
	);

	const retiredAdmission = fixture.nextAdmission();
	const retiredRequest = client.audio.transcriptions.create({ file, model });
	const retirement = assert.rejects(retiredRequest);
	const retiredId = await retiredAdmission;
	lifetime.abort();
	let closed = false;
	const closing = owner.close().then(() => {
		closed = true;
	});
	await Promise.resolve();
	assert.equal(
		closed,
		false,
		'App AI closure waits for admitted native computation',
	);
	await retirement;
	await closing;
	assert(
		completed.some(
			(entry) =>
				entry.id === retiredId &&
				typeof entry.value === 'object' &&
				entry.value !== null &&
				'outcome' in entry.value &&
				entry.value.outcome === 'transcribed',
		),
		'App AI closure drained native work before releasing ownership',
	);
	const beforeRetained = admitted.length;
	await assert.rejects(client.models.list());
	assert.equal(
		admitted.length,
		beforeRetained,
		'Retained client cannot invoke after App retirement',
	);

	const { settingsUnchanged } = await fixture.close();
	console.log(
		JSON.stringify({
			runtime: 'Tauri MockRuntime',
			inference: 'real cached transcribe.cpp model',
			model,
			byteLength: file.size,
			text: transcription.text,
			multipartBytesExact: true,
			unknownModelRejected: true,
			invalidAudioRejected: true,
			emptyAudioSucceeded: true,
			appliedHintsPreserved: true,
			callerAbortDrained: true,
			retiredAppDrained: true,
			settingsUnchanged,
		}),
	);
} finally {
	lifetime.abort();
	await owner.close();
	await fixture.close();
}
