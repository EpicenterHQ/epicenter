import { afterAll, expect, mock, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';

// The recorder's public seam for tuning is `vadOptions`, forwarded verbatim
// into `MicVAD.new`. These tests lock the pass-through: configured values
// arrive untouched and the option is optional.

const micVadNewArgs: Record<string, unknown>[] = [];
const micVadNew = mock(async (options: Record<string, unknown>) => {
	micVadNewArgs.push(options);
	return {
		start: async () => {},
		pause: async () => {},
		destroy: async () => {},
	};
});
const encodeWAV = mock(() => new ArrayBuffer(0));

mock.module('@ricky0123/vad-web', () => ({
	MicVAD: { new: micVadNew },
	utils: { encodeWAV },
}));

// The stream seam is exercised elsewhere; here we just need a stream-shaped
// object back from device acquisition so MicVAD construction is reached.
mock.module('./device-stream', () => ({
	getRecordingStream: mock(async () =>
		Ok({
			stream: { getTracks: () => [], getAudioTracks: () => [] },
			deviceOutcome: { outcome: 'success', deviceId: 'mic-1' },
		}),
	),
	cleanupRecordingStream: mock(() => {}),
}));

const { createVadRecorder } = await import('./vad-recorder');

const callbacks = {
	onSpeechStart: () => {},
	onSpeechEnd: () => {},
	onVADMisfire: () => {},
	onLevel: () => {},
};

test('startActiveListening forwards vadOptions into MicVAD.new', async () => {
	const recorder = createVadRecorder();
	const vadOptions = {
		redemptionMs: 2500,
		minSpeechMs: 600,
		positiveSpeechThreshold: 0.5,
		negativeSpeechThreshold: 0.2,
		preSpeechPadMs: 1200,
	};

	const result = await recorder.startActiveListening({
		...callbacks,
		vadOptions,
	});
	expect(result.error).toBeNull();

	const options = micVadNewArgs.at(-1);
	expect(options?.redemptionMs).toBe(2500);
	expect(options?.minSpeechMs).toBe(600);
	expect(options?.positiveSpeechThreshold).toBe(0.5);
	expect(options?.negativeSpeechThreshold).toBe(0.2);
	expect(options?.preSpeechPadMs).toBe(1200);

	await recorder.stopActiveListening();
});

test('startActiveListening works without vadOptions', async () => {
	const recorder = createVadRecorder();
	const result = await recorder.startActiveListening(callbacks);
	expect(result.error).toBeNull();

	const options = micVadNewArgs.at(-1);
	expect(options?.model).toBe('v5');
	expect(options?.vadOptions).toBeUndefined();

	await recorder.stopActiveListening();
});

afterAll(() => {
	mock.restore();
});
