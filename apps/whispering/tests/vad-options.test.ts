import { expect, test } from 'bun:test';
import { readVadOptions } from '../src/lib/state/vad-options';

const getFrom =
	(values: Record<string, string>) =>
	(key: string): string =>
		values[key] ?? '';

test('readVadOptions converts configured strings to numbers', () => {
	const vadOptions = readVadOptions(
		getFrom({
			'recording.vad.redemptionMs': '2500',
			'recording.vad.minSpeechMs': '600',
			'recording.vad.positiveSpeechThreshold': '0.5',
		}),
	);
	expect(vadOptions?.redemptionMs).toBe(2500);
	expect(vadOptions?.minSpeechMs).toBe(600);
	expect(vadOptions?.positiveSpeechThreshold).toBe(0.5);
});

test('unset entries are omitted, not undefined, so vad-web defaults survive the shallow spread', () => {
	const vadOptions = readVadOptions(getFrom({}));
	expect(vadOptions).toEqual({});
	expect(vadOptions).not.toHaveProperty('redemptionMs');
	expect(vadOptions).not.toHaveProperty('preSpeechPadMs');
});

test('a cleared field is omitted rather than coerced to 0', () => {
	const vadOptions = readVadOptions(
		getFrom({ 'recording.vad.redemptionMs': '' }),
	);
	expect(vadOptions).toEqual({});
});
