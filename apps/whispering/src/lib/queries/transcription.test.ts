/**
 * Transcription retry admission.
 * Retired UI starts neither manual nor bulk retries; admitted calls retain their results.
 */
import { expect, mock, test } from 'bun:test';
import { QueryClient } from '@tanstack/svelte-query';
import { createQueryFactories } from 'wellcrafted/query';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { WhisperingApp } from '$lib/whispering/app';
import type { Recording } from '../data.js';

Reflect.set(globalThis, '$state', <T>(value: T) => value);
mock.module('$lib/state/vad-recorder.svelte', () => ({
	vadRecorder: { state: 'IDLE' },
}));
mock.module('../state/vad-recorder.svelte', () => ({
	vadRecorder: { state: 'IDLE' },
}));
const admitted: Array<
	ReturnType<typeof Promise.withResolvers<ReturnType<typeof Ok<void>>>>
> = [];
const allAdmitted = Promise.withResolvers<void>();
mock.module('$lib/operations/transcribe', () => ({
	transcribeAndPersist: () => {
		const work = Promise.withResolvers<ReturnType<typeof Ok<void>>>();
		admitted.push(work);
		if (admitted.length === 3) allAdmitted.resolve();
		return work.promise;
	},
}));
const { createTranscriptionQueries } = await import('./transcription');

test('retirement refuses manual and bulk retries without changing admitted results', async () => {
	let recordingEnabled = true;
	const app = {
		get recordingEnabled() {
			return recordingEnabled;
		},
		recording: { state: 'IDLE', isStarting: false },
	} as unknown as WhisperingApp;
	const queryClient = new QueryClient();
	const queries = createTranscriptionQueries(
		app,
		{} as import('../whispering/app.js').RecordingStore,
		{
			...createQueryFactories(queryClient),
		},
	);
	const row = { id: 'recording', audioBlobId: 'audio' } as Recording;
	const manual = queries.transcribeRecording(row);
	const bulk = queries.transcribeRecordings([row, row]);
	await allAdmitted.promise;
	expect(admitted).toHaveLength(3);
	recordingEnabled = false;
	expect(expectErr(await queries.transcribeRecording(row)).message).toContain(
		'closing',
	);
	expect(expectErr(await queries.transcribeRecordings([row]))).toMatchObject({
		message: expect.stringContaining('closing'),
	});
	expect(admitted).toHaveLength(3);
	admitted[0]!.resolve(Ok(undefined));
	expectOk(await manual);
	admitted[1]!.resolve(Ok(undefined));
	admitted[2]!.resolve(Ok(undefined));
	expectOk(await bulk);
	queryClient.clear();
});
