/**
 * Shared format policy: producer evidence wins, generic Files retain their
 * format, aliases agree, and unknown bytes never acquire an audio label.
 */
import { expect, test } from 'bun:test';
import {
	assertBlobFormat,
	blobKeyFormat,
	selectBlobFormat,
} from './blob-format.js';

test.each([
	['audio/wav', 'wav', 'audio/wav'],
	['audio/x-wav', 'wav', 'audio/wav'],
	[' Audio/WAVE ; codecs=pcm', 'wav', 'audio/wav'],
	['audio/webm;codecs=opus', 'webm', 'video/webm'],
	['video/webm', 'webm', 'video/webm'],
	['audio/ogg;codecs=opus', 'ogg', 'audio/ogg'],
	['video/ogg', 'ogg', 'audio/ogg'],
	['audio/mp4;codecs=mp4a.40.2', 'm4a', 'audio/mp4'],
	['video/mp4', 'mp4', 'video/mp4'],
	['audio/mpeg', 'mp3', 'audio/mpeg'],
	['application/json;charset=utf-8', 'json', 'application/json;charset=utf-8'],
	['application/zip', 'zip', 'application/zip'],
])('producer %s chooses %s and conventional %s', (type, extension, contentType) => {
	expect(selectBlobFormat({ type, name: 'misleading.mp3' })).toEqual({
		extension,
		contentType,
	});
});

test.each([
	'wav',
	'm4a',
	'webm',
	'opus',
	'mp4',
	'ogg',
	'aac',
	'flac',
	'wma',
	'avi',
	'mov',
	'wmv',
	'flv',
	'mkv',
	'm4v',
])('empty and generic File types preserve %s filename evidence across a Blob parameter', (extension) => {
	for (const type of ['', 'application/octet-stream', 'binary/octet-stream']) {
		const file: Blob = new File(['sample'], `Take.${extension.toUpperCase()}`, {
			type,
		});
		expect(selectBlobFormat(file).extension).toBe(extension);
	}
});

test('structural filename evidence works without a File constructor', () => {
	expect(selectBlobFormat({ type: '', name: 'take.WAV' }).extension).toBe(
		'wav',
	);
	expect(selectBlobFormat({ type: '', name: 'wav' }).extension).toBe('bin');
});

test('unknown explicit media types do not borrow a misleading filename', () => {
	expect(
		selectBlobFormat({ type: 'application/x-unknown', name: 'take.wav' }),
	).toEqual({ extension: 'bin', contentType: 'application/octet-stream' });
	expect(selectBlobFormat(new Blob(['unknown']))).toEqual({
		extension: 'bin',
		contentType: 'application/octet-stream',
	});
});

test('key format is conventional and aliases compare container families', () => {
	const prefix = 'blob_abcdefghijklmnopqrstu';
	for (const [extension, type] of [
		['wav', 'audio/x-wav'],
		['webm', 'audio/webm;codecs=opus'],
		['mp4', 'audio/mp4'],
		['m4a', 'video/mp4'],
		['opus', 'audio/ogg'],
	]) {
		expect(() =>
			assertBlobFormat(`${prefix}.${extension}`, { type: type! }),
		).not.toThrow();
	}
	expect(blobKeyFormat(`${prefix}.webm`)).toEqual({
		extension: 'webm',
		contentType: 'video/webm',
	});
	expect(blobKeyFormat(`${prefix}.unknown`).contentType).toBe(
		'application/octet-stream',
	);
	expect(() =>
		assertBlobFormat(`${prefix}.wav`, { type: 'audio/mpeg' }),
	).toThrow('conflicts');
	expect(() =>
		assertBlobFormat(`${prefix}.bin`, { type: 'audio/wav' }),
	).toThrow('conflicts');
});
