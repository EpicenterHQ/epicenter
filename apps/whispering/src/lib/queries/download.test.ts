/**
 * Recording download filenames.
 * Verifies that the recording query supplies complete format-aware names to
 * its platform adapter, including filename-only imports and unknown bytes.
 */
import { expect, spyOn, test } from 'bun:test';
import { QueryClient } from '@tanstack/svelte-query';
import { createQueryFactories } from 'wellcrafted/query';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { DownloadServiceLive } from '#platform/download';
import type { Recording } from '../data.js';
import type { WhisperingApp } from '../whispering/app.js';
import { createDownloadQueries } from './download.js';

for (const { blob, extension } of [
	{
		blob: new Blob(['saved'], { type: 'audio/webm;codecs=opus' }),
		extension: 'webm',
	},
	{ blob: new File(['saved'], 'import.WAV'), extension: 'wav' },
	{ blob: new Blob(['saved']), extension: 'bin' },
]) {
	test(`recording download supplies a complete .${extension} filename`, async () => {
		const downloaded: Array<{ name: string; blob: Blob }> = [];
		const stub = spyOn(DownloadServiceLive, 'downloadBlob').mockImplementation(
			async (args) => {
				downloaded.push(args);
				return Ok(undefined);
			},
		);
		const client = new QueryClient();
		try {
			const app = {
				store: {
					tables: { recordings: { get: () => ({ audioBlobId: 'audio.wav' }) } },
				},
				localBlobs: { get: async () => Ok(blob) },
			} as unknown as WhisperingApp;
			const query = createDownloadQueries(
				{
					...Reflect.get(app, 'store'),
					blobs: Reflect.get(app, 'localBlobs'),
				},
				createQueryFactories(client),
			);
			expectOk(
				await query.downloadRecording({ id: 'saved-recording' } as Recording),
			);
			expect(downloaded).toEqual([
				{ name: `whispering_recording_saved-recording.${extension}`, blob },
			]);
		} finally {
			stub.mockRestore();
			client.clear();
		}
	});
}
