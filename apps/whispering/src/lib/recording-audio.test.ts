/**
 * Recording audio tests
 *
 * Where a recording's audio is, read from its row and the folder listing.
 *
 * Key behaviors:
 * - A unique supported same-stem sibling resolves without stored metadata
 * - Missing and ambiguous siblings never select an arbitrary audio file
 * - Existing explicit audio paths retain their meaning
 * - Before a listing is read, or while this window still captures or writes
 *   the recording, the audio is never reported absent
 */
import { expect, test } from 'bun:test';
import { listingOf } from './files.js';
import { recordingAudio } from './recording-audio.js';

const fields = { audioPath: 'audio/take.wav' };
const listing = (...paths: string[]) => listingOf(paths);

test('the listing decides whether the audio a row names is here or absent', () => {
	expect(
		recordingAudio('take', fields, {
			listing: listing('recordings/take.md', 'audio/take.wav'),
			settling: false,
		}),
	).toEqual({ kind: 'here', path: 'audio/take.wav' });
	expect(
		recordingAudio('take', fields, {
			listing: listing('recordings/take.md'),
			settling: false,
		}),
	).toEqual({ kind: 'absent', path: 'audio/take.wav' });
	expect(
		recordingAudio(
			'take',
			{},
			{ listing: listing('recordings/take.md'), settling: false },
		),
	).toEqual({ kind: 'absent', path: 'recordings/take.*' });
});

test('an unread listing or a recording still settling is never reported absent', () => {
	expect(
		recordingAudio('take', fields, { listing: undefined, settling: false }),
	).toEqual({ kind: 'here', path: 'audio/take.wav' });
	expect(
		recordingAudio('take', fields, {
			listing: listing('recordings/take.md'),
			settling: true,
		}),
	).toEqual({ kind: 'here', path: 'audio/take.wav' });
});

test('a recording without audioPath resolves its unique supported sibling by exact stem', () => {
	expect(
		recordingAudio(
			'take',
			{},
			{
				listing: listing(
					'recordings/take.md',
					'recordings/take.webm',
					'recordings/take-copy.wav',
					'recordings/take.pdf',
				),
				settling: false,
			},
		),
	).toEqual({ kind: 'here', path: 'recordings/take.webm' });
	expect(
		recordingAudio(
			'take',
			{},
			{
				listing: listing(
					'recordings/take.copy.wav',
					'recordings/take.wav/other.mp3',
				),
				settling: false,
			},
		),
	).toEqual({ kind: 'absent', path: 'recordings/take.*' });
});

test('multiple matching audio files are ambiguous rather than chosen by extension or listing order', () => {
	expect(
		recordingAudio(
			'take',
			{},
			{
				listing: listing('recordings/take.webm', 'recordings/take.wav'),
				settling: false,
			},
		),
	).toEqual({
		kind: 'ambiguous',
		paths: ['recordings/take.wav', 'recordings/take.webm'],
	});
});

test('live capture supplies its path until the listing catches up without saving metadata', () => {
	expect(
		recordingAudio(
			'take',
			{},
			{
				listing: listing('recordings/take.md'),
				settling: true,
				capturePath: 'recordings/take.webm',
			},
		),
	).toEqual({ kind: 'here', path: 'recordings/take.webm' });
	expect(
		recordingAudio('take', {}, { listing: undefined, settling: false }),
	).toEqual({ kind: 'none' });
});
