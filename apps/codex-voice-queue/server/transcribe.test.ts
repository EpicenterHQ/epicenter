import { expect, test } from 'bun:test';
import { createTranscriber, normalizeTranscription } from './transcribe.js';

test('strips Whisper markers and collapses whitespace', () => {
	expect(
		normalizeTranscription(' [BLANK_AUDIO] hello\n  world (silence) [Music] '),
	).toBe('hello world');
	expect(normalizeTranscription('[BLANK_AUDIO] (silence)')).toBe('');
});
test('reports missing binaries without running transcription', () => {
	const transcriber = createTranscriber({
		config: { whisperCli: null, ffmpeg: null, model: null, language: 'en' },
	});
	expect(transcriber.probe().available).toBe(false);
	expect(transcriber.probe().reason).toContain('whisper-cli');
});
test.skipIf(!Bun.which('whisper-cli'))(
	'recognizes installed whisper-cli availability',
	() => {
		const transcriber = createTranscriber({
			config: {
				whisperCli: Bun.which('whisper-cli'),
				ffmpeg: Bun.which('ffmpeg'),
				model: '/missing-model',
				language: 'en',
			},
		});
		expect(transcriber.probe().available).toBe(false);
	},
);
