import { expect, test } from 'bun:test';
import { chooseRecordingType, extensionOf } from './recording-format.ts';

test('AAC in MP4 is asked for first, then Opus in WebM, then the default', () => {
	expect(chooseRecordingType(() => true)).toBe('audio/mp4;codecs=mp4a.40.2');
	expect(chooseRecordingType((type) => type.startsWith('audio/webm'))).toBe(
		'audio/webm;codecs=opus',
	);
	expect(chooseRecordingType(() => false)).toBeUndefined();
});

test('the extension comes from the produced type, whatever its spacing', () => {
	expect(extensionOf('audio/mp4; codecs=mp4a.40.2')).toBe('m4a');
	expect(extensionOf('audio/mp4;codecs=opus')).toBe('m4a');
	expect(extensionOf('audio/webm;codecs=opus')).toBe('webm');
	expect(extensionOf('Audio/Ogg')).toBe('ogg');
	expect(extensionOf('video/mp4')).toBeNull();
	expect(extensionOf('')).toBeNull();
});
