/**
 * The small pure pieces the workflow rests on: audio file facts.
 */

import { expect, test } from 'bun:test';
import { audioMimeTypeOf } from './audio-format.js';

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
