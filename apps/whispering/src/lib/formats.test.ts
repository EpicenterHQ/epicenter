/**
 * The small pure pieces the workflow rests on: audio file facts, recording
 * ids, and the transcription request.
 */
import { expectOk } from 'wellcrafted/testing';
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import { audioMimeTypeOf, wavDurationMs } from './audio-format.js';
import { toneWav } from './capture.js';
import { requestTranscription } from './transcription.js';

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

test('a transcription request posts the audio and reads the text, refusing redirects and ambient credentials', async () => {
	let seen: Request | undefined;
	let given: RequestInit | undefined;
	const transcribed = expectOk(
		await requestTranscription({
			baseUrl: 'http://127.0.0.1:18080/v1',
			model: 'verification-model',
			apiKey: '',
			audio: { bytes: toneWav(), filename: 'a.wav', mimeType: 'audio/wav' },
			fetch: async (input, init) => {
				given = init;
				seen = new Request(input, init);
				return Response.json({ text: 'hello' });
			},
		}),
	);
	expect(transcribed).toEqual({ text: 'hello' });
	expect(seen?.url).toBe('http://127.0.0.1:18080/v1/audio/transcriptions');
	expect(seen?.headers.get('authorization')).toBeNull();
	expect(given).toMatchObject({ redirect: 'error', credentials: 'omit' });
});

test('transcription failures say what happened', async () => {
	const audio = { bytes: toneWav(), filename: 'a.wav', mimeType: 'audio/wav' };
	const base = {
		baseUrl: 'http://127.0.0.1:1/v1',
		model: 'm',
		apiKey: 'k',
		audio,
	};
	const { error: unconfigured } = await requestTranscription({
		...base,
		model: ' ',
	});
	expect(unconfigured?.name).toBe('NotConfigured');
	const { error: unreachable } = await requestTranscription({
		...base,
		fetch: async () => {
			throw new Error('connection refused');
		},
	});
	expect(unreachable?.name).toBe('Unreachable');
	const { error: rejected } = await requestTranscription({
		...base,
		fetch: async () => new Response('bad key', { status: 401 }),
	});
	expect(rejected?.name).toBe('Rejected');
	expect(rejected?.message).toContain('401');
	const { error: malformed } = await requestTranscription({
		...base,
		fetch: async () => new Response('<html>', { status: 200 }),
	});
	expect(malformed?.name).toBe('Malformed');
});
