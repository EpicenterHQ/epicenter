/**
 * Dictation lifetime tests over the actual SDK transcription client.
 * Close joins microphone startup, accepts its final flush, drains the response,
 * and rejects late callbacks or an unsuccessful recorder teardown.
 */
import { expect, mock, test } from 'bun:test';
import OpenAI from 'openai';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';

Reflect.set(globalThis, '$state', <T>(value: T) => value);
mock.module('$app/paths', () => ({ base: '' }));
mock.module('$lib/data', () => ({ VOCAB_STT_MODEL: 'whisper-1' }));

let start = async (_options: { onSpeechEnd(blob: Blob): void }) =>
	Ok(undefined);
let stop = async (): Promise<unknown> => Ok(undefined);
let respond = async () => Response.json({ text: 'phrase' });
mock.module('@epicenter/recorder', () => ({
	createVadRecorder: () => ({
		startActiveListening: (options: { onSpeechEnd(blob: Blob): void }) =>
			start(options),
		stopActiveListening: () => stop(),
	}),
}));
const { createDictation } = await import('./dictation.svelte.js');
const client = new OpenAI({
	apiKey: 'test',
	baseURL: 'https://dictation.test/v1',
	maxRetries: 0,
	fetch: (input) =>
		String(input) === 'data:,' ? Promise.resolve(new Response()) : respond(),
});

test('close joins microphone startup, stops it, then drains captured phrases', async () => {
	const started = Promise.withResolvers<void>();
	const transcribed = Promise.withResolvers<void>();
	const events: string[] = [];
	let speechEnd: ((blob: Blob) => void) | undefined;
	start = async (options) => {
		events.push('start');
		speechEnd = options.onSpeechEnd;
		await started.promise;
		return Ok(undefined);
	};
	stop = async () => {
		events.push('stop');
		speechEnd?.(new Blob(['last phrase']));
		return Ok(undefined);
	};
	respond = async () => {
		events.push('transcribe');
		await transcribed.promise;
		return Response.json({ text: 'last phrase' });
	};
	const dictation = createDictation(client);
	const options = { onTranscript: () => events.push('delivered') };
	const starting = dictation.start(options);
	const duplicate = dictation.start(options);
	const closing = dictation.close().then(() => events.push('closed'));
	await dictation.start(options);
	await Promise.resolve();
	expect(events).toEqual(['start']);
	started.resolve();
	expectOk(await starting);
	expectOk(await duplicate);
	await Bun.sleep(0);
	expect(events).toEqual(['start', 'stop', 'transcribe']);
	transcribed.resolve();
	await closing;
	expect(events).toEqual([
		'start',
		'stop',
		'transcribe',
		'delivered',
		'closed',
	]);
	await dictation.start(options);
	expect(events.filter((event) => event === 'start')).toHaveLength(1);
});

test('a failed recorder stop refuses close instead of declaring it drained', async () => {
	const failure = { name: 'StopFailed', message: 'microphone teardown failed' };
	start = async () => Ok(undefined);
	stop = async () => ({ data: null, error: failure });
	const dictation = createDictation(client);
	expectOk(await dictation.start({ onTranscript() {} }));
	await expect(dictation.close()).rejects.toEqual(failure);
	expect(dictation.status).toBe('listening');
});

test('close accepts the stop flush but rejects a late model callback after stop', async () => {
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
	const dictation = createDictation(client);
	expectOk(
		await dictation.start({
			onTranscript: (result) => delivered.push(expectOk(result)),
		}),
	);
	await dictation.close();
	expect(delivered).toEqual(['captured']);
	speechEnd?.(new Blob(['late frame']));
	await Bun.sleep(0);
	expect(delivered).toEqual(['captured']);
	expect(dictation.isTranscribing).toBe(false);
});
