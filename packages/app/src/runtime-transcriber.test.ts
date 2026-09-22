/** Direct native transcription verifies exact models and metadata, empty success,
 * malformed IPC, absence, cancellation admission, and draining host-owned work. */
import { expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createRuntimeTranscriber } from './runtime-transcriber.js';
import { openRuntimeTranscriber } from './ai.js';

test('browser runtime absence is null', async () => {
	expect(await openRuntimeTranscriber()).toBeNull();
});
test('model discovery distinguishes empty success, malformed data, and provider failure', async () => {
	expect(
		expectOk(await createRuntimeTranscriber(async () => []).listModels()),
	).toEqual([]);
	expect(
		expectErr(await createRuntimeTranscriber(async () => [{}]).listModels())
			.name,
	).toBe('InvalidResponse');
	expect(
		expectErr(
			await createRuntimeTranscriber(async () => {
				throw new Error('broken binding');
			}).listModels(),
		).name,
	).toBe('RequestFailed');
});
test('transcription sends exact bytes and model and retains applied metadata', async () => {
	const calls: unknown[] = [];
	const runtime = createRuntimeTranscriber(async (command, args) => {
		calls.push({ command, args });
		return {
			outcome: 'transcribed',
			text: 'words',
			modelId: 'model',
			applied: { language: 'en', initialPrompt: true },
		};
	});
	expect(
		expectOk(
			await runtime.transcribe({
				audio: new Blob([new Uint8Array([1, 2])]),
				model: 'model',
				language: 'en',
				prompt: 'hint',
			}),
		),
	).toEqual({
		text: 'words',
		model: 'model',
		applied: { language: 'en', initialPrompt: true },
	});
	expect(calls).toEqual([
		{
			command: 'transcribe_audio_bytes',
			args: {
				modelId: 'model',
				bytes: [1, 2],
				hints: { language: 'en', initialPrompt: 'hint' },
			},
		},
	]);
});
test('empty audio succeeds without inventing model metadata', async () => {
	const runtime = createRuntimeTranscriber(async () => ({
		outcome: 'empty-audio',
	}));
	expect(
		expectOk(await runtime.transcribe({ audio: new Blob(), model: 'model' })),
	).toEqual({ text: '' });
});
test('mismatched host model cannot publish a successful transcript', async () => {
	const runtime = createRuntimeTranscriber(async () => ({
		outcome: 'transcribed',
		text: 'wrong',
		modelId: 'other',
		applied: { language: null, initialPrompt: false },
	}));
	expect(
		expectErr(await runtime.transcribe({ audio: new Blob(), model: 'model' }))
			.name,
	).toBe('InvalidResponse');
});
test('cancellation before admission never calls IPC', async () => {
	let calls = 0;
	const runtime = createRuntimeTranscriber(async () => {
		calls++;
	});
	expect(
		expectErr(await runtime.listModels({ signal: AbortSignal.abort() })).name,
	).toBe('Cancelled');
	expect(calls).toBe(0);
});
test('close suppresses delivery and settles only after admitted native compute', async () => {
	const entered = Promise.withResolvers<void>();
	const host = Promise.withResolvers<unknown>();
	const runtime = createRuntimeTranscriber(async () => {
		entered.resolve();
		return host.promise;
	});
	const pending = runtime.transcribe({ audio: new Blob(), model: 'model' });
	await entered.promise;
	const closing = runtime.close();
	expect(runtime.close()).toBe(closing);
	let settled = false;
	void closing.then(() => {
		settled = true;
	});
	await Promise.resolve();
	expect(settled).toBe(false);
	host.resolve({ outcome: 'empty-audio' });
	expect(expectErr(await pending).name).toBe('Cancelled');
	await closing;
	expect(settled).toBe(true);
	expect(expectErr(await runtime.listModels()).name).toBe('Cancelled');
});

test('installed model listing preserves host identity and active metadata', async () => {
	const runtime = createRuntimeTranscriber(async () => [
		{ id: 'host/catalog-model', installed: true, active: false },
	]);
	expect(expectOk(await runtime.listModels())).toEqual([
		{ id: 'host/catalog-model', installed: true, active: false },
	]);
});

test('unsupported hints remain unapplied in the returned transcript', async () => {
	const runtime = createRuntimeTranscriber(async () => ({
		outcome: 'transcribed',
		text: 'words',
		modelId: 'model',
		applied: { language: null, initialPrompt: false },
	}));
	expect(
		expectOk(
			await runtime.transcribe({
				audio: new Blob(),
				model: 'model',
				language: 'en',
				prompt: 'hint',
			}),
		).applied,
	).toEqual({ language: null, initialPrompt: false });
});

test('request cancellation drains admitted native work without retiring the transcriber', async () => {
	const entered = Promise.withResolvers<void>();
	const host = Promise.withResolvers<unknown>();
	const runtime = createRuntimeTranscriber(async (command) => {
		if (command === 'list_inference_models') return [];
		entered.resolve();
		return host.promise;
	});
	const controller = new AbortController();
	let settled = false;
	const request = runtime
		.transcribe(
			{ audio: new Blob(), model: 'model' },
			{ signal: controller.signal },
		)
		.finally(() => {
			settled = true;
		});
	await entered.promise;
	controller.abort();
	await Promise.resolve();
	expect(settled).toBe(false);
	host.resolve({ outcome: 'empty-audio' });
	expect(expectErr(await request).name).toBe('Cancelled');
	expect(expectOk(await runtime.listModels())).toEqual([]);
	await runtime.close();
});

test('cancellation during audio preparation prevents native dispatch', async () => {
	const started = Promise.withResolvers<void>();
	const bytes = Promise.withResolvers<ArrayBuffer>();
	const audio = new Blob();
	audio.arrayBuffer = () => {
		started.resolve();
		return bytes.promise;
	};
	let calls = 0;
	const runtime = createRuntimeTranscriber(async () => {
		calls++;
		return { outcome: 'empty-audio' };
	});
	const pending = runtime.transcribe({ audio, model: 'model' });
	await started.promise;
	const closing = runtime.close();
	bytes.resolve(new ArrayBuffer(0));
	expect(expectErr(await pending).name).toBe('Cancelled');
	await closing;
	expect(calls).toBe(0);
});
