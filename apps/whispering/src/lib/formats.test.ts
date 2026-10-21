/**
 * The small pure pieces the workflow rests on: audio file facts, recording
 * ids, and the transcription request.
 */
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import { audioMimeTypeOf, wavDurationMs } from './audio-format.js';
import { toneWav } from './capture.js';
import type { StoredConnection } from './connections.js';
import { transcribeOverConnection } from './transcription.js';

const { recordingId } = await import('./library.svelte.ts');

test('a file’s extension names its playback type, ignoring case', () => {
	expect(audioMimeTypeOf('recordings/a.M4A')).toBe('audio/mp4');
	expect(audioMimeTypeOf('recordings/a.md')).toBeUndefined();
});

test('inherited object keys are not audio file extensions', () => {
	expect(audioMimeTypeOf('recordings/a.constructor')).toBeUndefined();
	expect(audioMimeTypeOf('recordings/a.__proto__')).toBeUndefined();
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
const audio = { bytes: toneWav(), filename: 'a.wav', mimeType: 'audio/wav' };

/** One transcription over a stored connection, answered by `send`. */
const transcribe = (
	send: (input: string, init?: RequestInit) => Promise<Response>,
	{
		stored = { baseUrl: 'http://127.0.0.1:18080/v1', model: 'm', apiKey: KEY },
		model = 'verification-model',
	}: { stored?: StoredConnection; model?: string } = {},
) =>
	transcribeOverConnection(
		async () => stored,
		{ audioPath: 'recordings/a.wav', expectedBaseUrl: stored.baseUrl, model },
		async () => Ok(audio),
		send,
	);

test('a transcription request posts the audio and reads the text, refusing redirects and ambient credentials', async () => {
	let seen: Request | undefined;
	let given: RequestInit | undefined;
	const transcribed = expectOk(
		await transcribe(
			async (input, init) => {
				given = init;
				seen = new Request(input, init);
				return Response.json({ text: 'hello' });
			},
			{ stored: { baseUrl: 'http://127.0.0.1:18080/v1', model: 'm' } },
		),
	);
	expect(transcribed).toEqual({ text: 'hello' });
	expect(seen?.url).toBe('http://127.0.0.1:18080/v1/audio/transcriptions');
	expect(seen?.headers.get('authorization')).toBeNull();
	expect(given).toMatchObject({ redirect: 'error', credentials: 'omit' });
});

test('transcription failures say what happened, without the key', async () => {
	const never = async () => {
		throw new Error('nothing is sent');
	};
	const { error: unconfigured } = await transcribe(never, { model: ' ' });
	expect(unconfigured?.name).toBe('NotConfigured');
	const { error: unreachable } = await transcribe(async () => {
		throw new Error(`connection refused (authorization ${KEY})`);
	});
	expect(unreachable?.name).toBe('Unreachable');
	expect(JSON.stringify(unreachable)).not.toContain(KEY);
	const { error: rejected } = await transcribe(
		async () => new Response(`bad key ${KEY}`, { status: 401 }),
	);
	expect(rejected?.name).toBe('Rejected');
	expect(rejected?.message).toContain('401');
	expect(JSON.stringify(rejected)).not.toContain(KEY);
	const { error: malformed } = await transcribe(
		async () => new Response('<html>', { status: 200 }),
	);
	expect(malformed?.name).toBe('Malformed');
});
