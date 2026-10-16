/**
 * The small pure pieces the workflow rests on: audio file facts, recording
 * ids, and the transcription request.
 */
import { sendToEndpoint } from '@epicenter/ai/send';
import { expectOk } from 'wellcrafted/testing';
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import { audioMimeTypeOf, wavDurationMs } from './audio-format.js';
import { toneWav } from './capture.js';
import { readTranscription, transcriptionRequest } from './requests.js';

const { recordingId } = await import('./library.svelte.ts');

test('a file’s extension names its playback type, ignoring case', () => {
	expect(audioMimeTypeOf('recordings/a.M4A')).toBe('audio/mp4');
	expect(audioMimeTypeOf('recordings/a.md')).toBeUndefined();
});

test('a WAV reports its own length', () => {
	expect(wavDurationMs(toneWav({ seconds: 3 }))).toBe(3000);
	expect(wavDurationMs(new Uint8Array(64))).toBeUndefined();
});

test('recording ids encode capture time', () => {
	const id = recordingId(new Date('2026-01-02T03:04:05.678Z'));
	expect(id).toMatch(/^20260102-030405-[0-9a-z]{4}$/);
});

const KEY = 'sk-transcription-key';
const ENDPOINT = 'http://127.0.0.1:18080/v1';
const audio = { bytes: toneWav(), filename: 'a.wav', mimeType: 'audio/wav' };

/** One transcription request, sent as a connection sends it, answered by `send`. */
async function transcribe(
	send: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
	key = KEY,
) {
	const { data: response, error } = await sendToEndpoint(
		{ endpoint: ENDPOINT, key },
		await transcriptionRequest(audio, 'verification-model'),
		{ fetch: send },
	);
	if (error !== null) return { data: null, error };
	return readTranscription(response);
}

test('a transcription request posts the audio and model, and reads the text', async () => {
	let seen: Request | undefined;
	const transcribed = expectOk(
		await transcribe(async (input, init) => {
			seen = new Request(input, init);
			return Response.json({ text: 'hello' });
		}),
	);
	expect(transcribed).toEqual({ text: 'hello' });
	expect(seen?.url).toBe(`${ENDPOINT}/audio/transcriptions`);
	expect(seen?.headers.get('authorization')).toBe(`Bearer ${KEY}`);
	const form = await (seen as Request).formData();
	expect(form.get('model')).toBe('verification-model');
	expect((form.get('file') as File).name).toBe('a.wav');
});

test('transcription failures say what happened, and an unreachable one without the key', async () => {
	const { error: unreachable } = await transcribe(async () => {
		throw new Error(`connection refused (authorization ${KEY})`);
	});
	expect(unreachable?.name).toBe('Unreachable');
	expect(JSON.stringify(unreachable)).not.toContain(KEY);
	const { error: rejected } = await transcribe(
		async () => new Response('bad key', { status: 401 }),
	);
	expect(rejected?.name).toBe('Rejected');
	expect(rejected?.message).toBe('The endpoint answered 401: bad key');
	const { error: malformed } = await transcribe(
		async () => new Response('<html>', { status: 200 }),
	);
	expect(malformed?.message).toBe(
		'The endpoint did not answer with transcript text',
	);
});
