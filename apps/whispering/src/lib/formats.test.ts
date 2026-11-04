/**
 * The small pure pieces the workflow rests on: audio file facts.
 */

import { expect, test } from 'bun:test';
import { audioDurationMs } from '@epicenter/recorder';
import { audioMimeTypeOf } from './audio-format.js';
import { toneWav } from './services.test-support.js';

test('a file’s extension names its playback type, ignoring case', () => {
	expect(audioMimeTypeOf('recordings/a.M4A')).toBe('audio/mp4');
	expect(audioMimeTypeOf('recordings/a.md')).toBeUndefined();
});

test('every extension a recorder names its file with plays and uploads as audio', () => {
	for (const [extension, type] of [
		['m4a', 'audio/mp4'],
		['webm', 'audio/webm'],
		['ogg', 'audio/ogg'],
		['wav', 'audio/wav'],
	]) {
		expect(audioMimeTypeOf(`recordings/a.${extension}`)).toBe(type);
	}
});

test('inherited object keys are not audio file extensions', () => {
	expect(audioMimeTypeOf('recordings/a.constructor')).toBeUndefined();
	expect(audioMimeTypeOf('recordings/a.__proto__')).toBeUndefined();
});

test('a WAV reports its own length', () => {
	expect(audioDurationMs(toneWav({ seconds: 3 }), 'wav')).toBe(3000);
	expect(audioDurationMs(new Uint8Array(64), 'wav')).toBeUndefined();
});
