/**
 * Takeout Sidecar Matching Tests
 *
 * Verifies that trustworthy filename evidence wins and ambiguous truncated
 * names remain unmatched instead of attaching metadata to the wrong asset.
 *
 * Key behaviors:
 * - Supplemental and old JSON names match their media file
 * - Google duplicate suffixes normalize before matching
 * - Ambiguous truncated prefixes are refused
 */
import { expect, test } from 'bun:test';
import { matchSidecars } from './sidecar-match.js';

test('claimed title matches a supplemental sidecar to its media', () => {
	const result = matchSidecars({
		media: [{ archivePath: 'Photos/IMG_0001.jpg', fileName: 'IMG_0001.jpg' }],
		sidecars: [
			{
				archivePath: 'Photos/IMG_0001.jpg.supplemental-metadata.json',
				fileName: 'IMG_0001.jpg.supplemental-metadata.json',
				claimedTitle: 'IMG_0001.jpg',
			},
		],
	});

	expect(result.matches).toEqual([
		{
			mediaPath: 'Photos/IMG_0001.jpg',
			sidecarPath: 'Photos/IMG_0001.jpg.supplemental-metadata.json',
		},
	]);
	expect(result.unmatched).toEqual([]);
});

test('old duplicate suffix moves behind the filename stem', () => {
	const result = matchSidecars({
		media: [{ archivePath: 'Photos/IMG(1).jpg', fileName: 'IMG(1).jpg' }],
		sidecars: [
			{
				archivePath: 'Photos/IMG.jpg(1).json',
				fileName: 'IMG.jpg(1).json',
				claimedTitle: null,
			},
		],
	});

	expect(result.matches[0]?.mediaPath).toBe('Photos/IMG(1).jpg');
});

test('truncated prefix tie remains unmatched', () => {
	const result = matchSidecars({
		media: [
			{
				archivePath: 'Photos/very-long-name-a.jpg',
				fileName: 'very-long-name-a.jpg',
			},
			{
				archivePath: 'Photos/very-long-name-b.jpg',
				fileName: 'very-long-name-b.jpg',
			},
		],
		sidecars: [
			{
				archivePath: 'Photos/very-long-name.supplementa.json',
				fileName: 'very-long-name.supplementa.json',
				claimedTitle: null,
			},
		],
	});

	expect(result.matches).toEqual([]);
	expect(result.unmatched).toEqual([
		{
			sidecarPath: 'Photos/very-long-name.supplementa.json',
			reason: 'ambiguous',
		},
	]);
});
