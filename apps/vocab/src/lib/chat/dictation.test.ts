/**
 * Dictation lifetime tests over the actual SDK transcription client.
 * Disposal releases the microphone after pending startup, drops queued and late
 * transcripts, and reports recorder release failures. Ordinary stop keeps its final phrase.
 */
import { expect, mock, test } from 'bun:test';
import OpenAI from 'openai';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';

Reflect.set(globalThis, '$state', <T>(value: T) => value);
mock.module('$app/paths', () => ({ base: '' }));

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

test('close before microphone startup prevents acquisition and transcription', async () => {
	const clientReady = Promise.withResolvers<OpenAI>();
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
	const dictation = createDictation(() => clientReady.promise);
	const options = { onTranscript: () => events.push('delivered') };
	const starting = dictation.start(options);
	const closing = dictation.close().then(() => events.push('closed'));
	clientReady.resolve(client);
	expectOk(await starting);
	await closing;
	expect(events).toEqual(['closed']);
	await dictation.start(options);
	expect(events).toEqual(['closed']);
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
	const dictation = createDictation(() => client);
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
	const dictation = createDictation(() => client);
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
	const dictation = createDictation(() => client);
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
	const dictation = createDictation(() => client);
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
