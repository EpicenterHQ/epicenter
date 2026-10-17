/**
 * Recording audio tests
 *
 * Where a recording's audio is, read from its row and the folder listing.
 *
 * Key behaviors:
 * - A row naming audio the listing holds has it here; one naming audio the
 *   listing lacks is absent; one naming none has none
 * - Before a listing is read, or while this window still captures or writes
 *   the recording, the audio is never reported absent
 */
import { expect, test } from 'bun:test';
import { recordingAudio } from './recording-audio.js';

const fields = { audioPath: 'audio/take.wav' };
const listing = (...paths: string[]) => ({
	files: paths.map((path) => ({ path, size: 1 })),
	directories: ['recordings'],
});

test('the listing decides whether the audio a row names is here or absent', () => {
	expect(
		recordingAudio(fields, {
			listing: listing('recordings/take.md', 'audio/take.wav'),
			settling: false,
		}),
	).toEqual({ kind: 'here', path: 'audio/take.wav' });
	expect(
		recordingAudio(fields, {
			listing: listing('recordings/take.md'),
			settling: false,
		}),
	).toEqual({ kind: 'absent', path: 'audio/take.wav' });
	expect(
		recordingAudio(
			{},
			{ listing: listing('recordings/take.md'), settling: false },
		),
	).toEqual({ kind: 'none' });
});

test('an unread listing or a recording still settling is never reported absent', () => {
	expect(
		recordingAudio(fields, { listing: undefined, settling: false }),
	).toEqual({ kind: 'here', path: 'audio/take.wav' });
	expect(
		recordingAudio(fields, {
			listing: listing('recordings/take.md'),
			settling: true,
		}),
	).toEqual({ kind: 'here', path: 'audio/take.wav' });
});
