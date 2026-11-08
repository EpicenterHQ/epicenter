/**
 * Dictation lifetime tests over the real transcription client and a fake endpoint.
 * Disposal releases the microphone after pending startup, drops queued and late
 * transcripts, and reports recorder release failures. Ordinary stop keeps its final phrase.
 */
import { expect, mock, test } from 'bun:test';
import { custom, openAi } from '@epicenter/ai';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';

Reflect.set(globalThis, '$state', <T>(value: T) => value);
mock.module('$app/paths', () => ({ base: '' }));

let start = async (_options: { onSpeechEnd(blob: Blob): void }) =>
	Ok(undefined);
let stop = async (): Promise<unknown> => Ok(undefined);
let respond = async () => Response.json({ text: 'phrase' });
mock.module('@epicenter/recorder/browser', () => ({
	createVadRecorder: () => ({
		startActiveListening: (options: { onSpeechEnd(blob: Blob): void }) =>
			start(options),
		stopActiveListening: () => stop(),
	}),
}));
const { createDictation } = await import('./dictation.svelte.js');
const ai = openAi([
	custom({
		id: 'hosted',
		baseUrl: 'https://dictation.test/v1',
		fetch: () => respond(),
	}),
]);
const transcribe = (file: File, signal: AbortSignal) =>
	ai.transcribe({ endpoint: 'hosted', model: 'whisper-1', file }, { signal });

test('close right after start releases the microphone, and a later start opens nothing', async () => {
	const events: string[] = [];
	start = async () => {
		events.push('start');
		return Ok(undefined);
	};
	stop = async () => {
		events.push('stop');
		return Ok(undefined);
	};
	respond = async () => {
		events.push('transcribe');
		return Response.json({ text: 'last phrase' });
	};
	const dictation = createDictation({ transcribe });
	const options = { onTranscript: () => events.push('delivered') };
	const starting = dictation.start(options);
	const closing = dictation.close().then(() => events.push('closed'));
	expectOk(await starting);
	await closing;
	expect(events).toEqual(['start', 'stop', 'closed']);
	await dictation.start(options);
	expect(events).toEqual(['start', 'stop', 'closed']);
});

test('close joins a microphone startup already in progress', async () => {
	const started = Promise.withResolvers<void>();
	const events: string[] = [];
	start = async () => {
		events.push('start');
		await started.promise;
		return Ok(undefined);
	};
	stop = async () => {
		events.push('stop');
		return Ok(undefined);
	};
	const dictation = createDictation({ transcribe });
	const starting = dictation.start({ onTranscript() {} });
	await Promise.resolve();
	expect(events).toEqual(['start']);
	const closing = dictation.close();
	started.resolve();
	expectOk(await starting);
	await closing;
	expect(events).toEqual(['start', 'stop']);
});

test('a failed recorder release reports its error', async () => {
	const failure = { name: 'StopFailed', message: 'microphone teardown failed' };
	start = async () => Ok(undefined);
	stop = async () => ({ data: null, error: failure });
	const dictation = createDictation({ transcribe });
	expectOk(await dictation.start({ onTranscript() {} }));
	await expect(dictation.close()).rejects.toEqual(failure);
	expect(dictation.status).toBe('listening');
});

test('ordinary stop delivers its final phrase and rejects later model callbacks', async () => {
	const delivered: string[] = [];
	let speechEnd: ((blob: Blob) => void) | undefined;
	start = async (options) => {
		speechEnd = options.onSpeechEnd;
		return Ok(undefined);
	};
	stop = async () => {
		speechEnd?.(new Blob(['flush']));
		return Ok(undefined);
	};
	respond = async () => Response.json({ text: 'captured' });
	const dictation = createDictation({ transcribe });
	expectOk(
		await dictation.start({
			onTranscript: (result) => delivered.push(expectOk(result)),
		}),
	);
	expectOk(await dictation.stop());
	await Bun.sleep(0);
	expect(delivered).toEqual(['captured']);
	speechEnd?.(new Blob(['late frame']));
	await Bun.sleep(0);
	expect(delivered).toEqual(['captured']);
	expect(dictation.isTranscribing).toBe(false);
});

test('close does not wait for in-flight transcription and suppresses its result', async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let speechEnd: ((blob: Blob) => void) | undefined;
	start = async (options) => {
		speechEnd = options.onSpeechEnd;
		return Ok(undefined);
	};
	stop = async () => Ok(undefined);
	respond = async () => {
		entered.resolve();
		await release.promise;
		return Response.json({ text: 'late' });
	};
	const delivered: string[] = [];
	const dictation = createDictation({ transcribe });
	expectOk(
		await dictation.start({
			onTranscript: (result) => delivered.push(expectOk(result)),
		}),
	);
	speechEnd?.(new Blob(['captured']));
	await entered.promise;
	await dictation.close();
	expect(dictation.status).toBe('idle');
	release.resolve();
	await Bun.sleep(0);
	expect(delivered).toEqual([]);
});
