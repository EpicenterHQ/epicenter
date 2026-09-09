/**
 * Import lifetime tests.
 * File imports drain every admitted pipeline, including siblings of a failed
 * import. Departure refuses new files before they acquire storage or inference.
 */
import { expect, mock, test } from 'bun:test';
import type { WhisperingApp } from '$lib/whispering/app';

Reflect.set(globalThis, '$state', <T>(value: T) => value);
mock.module('$lib/state/vad-recorder.svelte', () => ({
	vadRecorder: { state: 'IDLE' },
}));
mock.module('$lib/operations/analytics', () => ({
	logAnalyticsEvent: async () => {},
}));
mock.module('$lib/report', () => ({ report: { info: () => {} } }));
const pipelines: Array<ReturnType<typeof Promise.withResolvers<void>>> = [];
mock.module('$lib/operations/pipeline', () => ({
	processRecordingPipeline: () => {
		const pipeline = Promise.withResolvers<void>();
		pipelines.push(pipeline);
		return pipeline.promise;
	},
}));
const { importFiles } = await import('./import');
const { drainRecordingWork } = await import('../state/recording-active.svelte');

test('failed import does not abandon its sibling before departure drains', async () => {
	let recordingEnabled = true;
	const app = {
		get recordingEnabled() {
			return recordingEnabled;
		},
	} as WhisperingApp;
	const file = new File(['audio'], 'speech.wav', { type: 'audio/wav' });
	const importing = importFiles(app, { files: [file, file] });
	const failed = importing.catch((error: Error) => error);
	expect(pipelines).toHaveLength(2);
	recordingEnabled = false;
	let drained = false;
	const closing = drainRecordingWork().then(() => {
		drained = true;
	});
	const closingFailed = closing.catch((error: Error) => error);
	await expect(importFiles(app, { files: [file] })).rejects.toThrow('closing');
	expect(pipelines).toHaveLength(2);
	pipelines[0]!.reject(new Error('inference failed'));
	expect(await failed).toMatchObject({ message: 'inference failed' });
	expect(drained).toBe(false);
	pipelines[1]!.resolve();
	expect(await closingFailed).toMatchObject({ message: 'inference failed' });
});
