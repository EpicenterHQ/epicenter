/**
 * Recording audio tests
 *
 * Where a recording's audio is, read from its row and the folder listing.
 *
 * Key behaviors:
 * - A unique supported same-stem sibling resolves without stored metadata
 * - Missing and ambiguous siblings never select an arbitrary audio file
 * - Before a listing is read, or while this window still captures or writes
 *   the recording, the audio is never reported absent
 */
import { expect, test } from 'bun:test';
import { listingOf } from './files.js';
import { recordingAudio } from './recording-audio.js';

const listing = (...paths: string[]) => listingOf(paths);

test('an unread listing or a recording still settling is never reported absent', () => {
	expect(
		recordingAudio('take', { listing: undefined, settling: false }),
	).toEqual({ kind: 'none' });
	expect(
		recordingAudio('take', {
			listing: listing('recordings/take.md'),
			settling: true,
		}),
	).toEqual({ kind: 'none' });
});

test('a recording resolves its unique supported sibling by exact stem', () => {
	expect(
		recordingAudio('take', {
			listing: listing(
				'recordings/take.md',
				'recordings/take.webm',
				'recordings/take-copy.wav',
				'recordings/take.pdf',
			),
			settling: false,
		}),
	).toEqual({ kind: 'here', path: 'recordings/take.webm' });
	expect(
		recordingAudio('take', {
			listing: listing(
				'recordings/take.copy.wav',
				'recordings/take.wav/other.mp3',
			),
			settling: false,
		}),
	).toEqual({ kind: 'absent', path: 'recordings/take.*' });
});

test('multiple matching audio files are ambiguous rather than chosen by extension or listing order', () => {
	expect(
		recordingAudio('take', {
			listing: listing('recordings/take.webm', 'recordings/take.wav'),
			settling: false,
		}),
	).toEqual({
		kind: 'ambiguous',
		paths: ['recordings/take.wav', 'recordings/take.webm'],
	});
});

test('live capture supplies its path until the listing catches up without saving metadata', () => {
	expect(
		recordingAudio('take', {
			listing: listing('recordings/take.md'),
			settling: true,
			capturePath: 'recordings/take.webm',
		}),
	).toEqual({ kind: 'here', path: 'recordings/take.webm' });
	expect(
		recordingAudio('take', { listing: undefined, settling: false }),
	).toEqual({ kind: 'none' });
});
