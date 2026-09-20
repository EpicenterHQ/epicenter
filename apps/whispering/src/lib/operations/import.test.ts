/**
 * Import lifetime tests.
 * File imports retain saved bytes and capture inference before asynchronous saves.
 * Retired UI refuses new imports; retirement prevents publishing new rows.
 */
import { expect, mock, test } from 'bun:test';
import { generateBlobId } from '@epicenter/blobs';
import { Ok } from 'wellcrafted/result';
import type { WhisperingApp } from '../whispering/app.js';

Reflect.set(globalThis, '$state', <T>(value: T) => value);
mock.module('../state/vad-recorder.svelte.js', () => ({
	vadRecorder: { state: 'IDLE' },
}));
mock.module('./analytics.js', () => ({
	logAnalyticsEvent: async () => {},
}));
mock.module('../report/index.js', () => ({ report: { info: () => {} } }));
let inference = async () => Ok('captured');
mock.module('./transcribe.js', () => ({
	captureTranscription: () => inference,
}));
const processed: Array<{ recordingId: string; transcribe: unknown }> = [];
const pipelines: Array<ReturnType<typeof Promise.withResolvers<void>>> = [];
mock.module('./pipeline.js', () => ({
	processRecordingPipeline: (
		_app: WhisperingApp,
		input: { recordingId: string; transcribe: unknown },
	) => {
		processed.push(input);
		const pipeline = Promise.withResolvers<void>();
		pipelines.push(pipeline);
		return pipeline.promise;
	},
}));
const { importFiles } = await import('./import.js');

test('failed import preserves saved sibling bytes and refuses new work after retirement', async () => {
	let recordingEnabled = true;
	const original = inference;
	const publication = Promise.withResolvers<void>();
	const savedKeys: string[] = [];
	const rows: Array<Record<string, unknown> & { id: string }> = [];
	const app = {
		signal: new AbortController().signal,
		blobs: {
			local: {
				add: async () => {
					const id = generateBlobId('wav');
					savedKeys.push(id);
					await publication.promise;
					return Ok(id);
				},
			},
		},
		library: {
			tables: {
				recordings: {
					create: (value: Record<string, unknown>) => {
						const row = { ...value, id: crypto.randomUUID() };
						rows.push(row);
						return row;
					},
				},
			},
		},
		get recordingEnabled() {
			return recordingEnabled;
		},
	} as unknown as WhisperingApp;
	const file = new File(['audio'], 'speech.wav', { type: 'audio/wav' });
	const importing = importFiles(app, { files: [file, file] });
	const failed = importing.catch((error: Error) => error);
	expect(rows).toHaveLength(0);
	inference = async () => Ok('changed while saving');
	publication.resolve();
	await Bun.sleep(0);
	expect(rows.map((row) => row.audioBlobId)).toEqual(savedKeys);
	expect(savedKeys).toHaveLength(2);
	expect(processed.map((input) => input.recordingId)).toEqual(
		rows.map((row) => row.id),
	);
	expect(processed.every((input) => !('audio' in input))).toBe(true);
	expect(processed.every((input) => input.transcribe === original)).toBe(true);
	inference = original;
	expect(pipelines).toHaveLength(2);
	recordingEnabled = false;
	await expect(importFiles(app, { files: [file] })).rejects.toThrow('closing');
	expect(pipelines).toHaveLength(2);
	pipelines[0]!.reject(new Error('inference failed'));
	expect(await failed).toMatchObject({ message: 'inference failed' });
	pipelines[1]!.resolve();
	await pipelines[1]!.promise;
});

test('retirement during import publication preserves committed bytes without a row', async () => {
	const controller = new AbortController();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const blobId = generateBlobId('wav');
	const bytes = new Map<string, Blob>();
	const create = mock(async () => {
		throw new Error('Retired App must not create rows');
	});
	const app = {
		signal: controller.signal,
		recordingEnabled: true,
		blobs: {
			local: {
				add: async (audio: Blob) => {
					entered.resolve();
					await release.promise;
					bytes.set(blobId, audio);
					return Ok(blobId);
				},
			},
		},
		library: { tables: { recordings: { create } } },
	} as unknown as WhisperingApp;

	const before = processed.length;
	const importing = importFiles(app, {
		files: [new File(['retained'], 'speech.wav')],
	});
	await entered.promise;
	controller.abort(new Error('retired'));
	release.resolve();
	await importing;
	expect(create).not.toHaveBeenCalled();
	expect(processed).toHaveLength(before);
	expect(bytes.size).toBe(1);
	expect(await bytes.get(blobId)?.text()).toBe('retained');
});
