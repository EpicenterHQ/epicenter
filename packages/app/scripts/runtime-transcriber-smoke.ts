/**
 * Direct transcriber -> actual Tauri commands -> cached model.
 * Tauri MockRuntime supplies the window; decoding and inference are real.
 * Run with EPICENTER_NATIVE_AUDIO=/absolute/speech.wav bun packages/app/scripts/runtime-transcriber-smoke.ts.
 * Whisper Tiny must already be cached. No downloads or real settings changes.
 */
import assert from 'node:assert/strict';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createRuntimeTranscriberFixture } from './runtime-transcriber-fixture.js';

const audioPath = process.env.EPICENTER_NATIVE_AUDIO;
if (!audioPath)
	throw new Error('Set EPICENTER_NATIVE_AUDIO to an existing speech WAV.');
const audio = new Blob([await Bun.file(audioPath).arrayBuffer()], {
	type: 'audio/wav',
});
const model = 'handy-computer/whisper-tiny-gguf@main/whisper-tiny-Q8_0.gguf';
const fixture = await createRuntimeTranscriberFixture({ audioPath });
const { transcriber, admitted, completed } = fixture;

try {
	assert(
		expectOk(await transcriber.listModels()).some(
			(entry) => entry.id === model,
		),
		'Whisper Tiny must already be cached',
	);
	const transcript = expectOk(
		await transcriber.transcribe({
			audio,
			model,
			language: 'en',
			prompt: 'The application closes its transcription access.',
		}),
	);
	assert(
		transcript.text.trim().length > 0,
		'Native engine produced speech text',
	);
	assert.deepEqual(transcript, {
		text: transcript.text,
		model,
		applied: { language: 'en', initialPrompt: true },
	});
	assert.deepEqual(admitted[1], {
		event: 'admitted',
		id: 2,
		command: 'transcribe_audio_bytes',
		modelId: model,
		hints: {
			initialPrompt: 'The application closes its transcription access.',
			language: 'en',
		},
		byteLength: audio.size,
		matchesFixture: true,
	});
	assert.deepEqual(
		expectOk(await transcriber.transcribe({ audio: new Blob(), model })),
		{ text: '' },
	);
	const unknown = expectErr(
		await transcriber.transcribe({ audio, model: 'unknown' }),
	);
	assert.equal(unknown.name, 'RequestFailed');
	assert(
		'cause' in unknown &&
			String(unknown.cause).includes('Unknown native transcription model'),
	);
	const invalid = expectErr(
		await transcriber.transcribe({ audio: new Blob(['invalid audio']), model }),
	);
	assert.equal(invalid.name, 'RequestFailed');
	assert(
		'cause' in invalid && String(invalid.cause).includes('AudioReadError'),
	);

	// Cancellation suppresses delivery but must wait for admitted native compute.
	const next = fixture.nextAdmission();
	const controller = new AbortController();
	let settled = false;
	const request = transcriber
		.transcribe({ audio, model }, { signal: controller.signal })
		.finally(() => {
			settled = true;
		});
	const cancelledId = await next;
	controller.abort();
	await Promise.resolve();
	assert.equal(settled, false);
	assert.equal(expectErr(await request).name, 'Cancelled');
	assert(
		completed.some(
			(entry) =>
				entry.id === cancelledId &&
				typeof entry.value === 'object' &&
				entry.value !== null &&
				'outcome' in entry.value &&
				entry.value.outcome === 'transcribed',
		),
	);

	const retiring = fixture.nextAdmission();
	const pending = transcriber.transcribe({ audio, model });
	const retiredId = await retiring;
	let closed = false;
	const closing = transcriber.close().then(() => {
		closed = true;
	});
	await Promise.resolve();
	assert.equal(closed, false);
	assert.equal(expectErr(await pending).name, 'Cancelled');
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
	);
	const before = admitted.length;
	assert.equal(expectErr(await transcriber.listModels()).name, 'Cancelled');
	assert.equal(admitted.length, before);
	const { settingsUnchanged } = await fixture.close();
	console.log(
		JSON.stringify({
			runtime: 'Tauri MockRuntime',
			inference: 'real cached transcribe.cpp model',
			model,
			byteLength: audio.size,
			text: transcript.text,
			bytesExact: true,
			unknownModelRejected: true,
			invalidAudioRejected: true,
			emptyAudioSucceeded: true,
			appliedHintsPreserved: true,
			callerAbortDrained: true,
			retiredAccessDrained: true,
			settingsUnchanged,
		}),
	);
} finally {
	await transcriber.close();
	await fixture.close();
}
