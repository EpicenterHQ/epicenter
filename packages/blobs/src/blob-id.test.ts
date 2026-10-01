/** Complete blob keys reject filesystem/URL syntax and retain mint/parse agreement. */
import { expect, test } from 'bun:test';
import { generateBlobId, parseBlobId } from './blob-id.js';

test('mint requires a bounded extension and preserves the random body', () => {
	for (const extension of ['wav', 'webm', 'mp4', 'bin', '0123456789']) {
		const id = generateBlobId(extension);
		expect(id).toMatch(/^blob_[a-z0-9]{21}\.[a-z0-9]{1,10}$/);
		expect(parseBlobId(id)).toBe(id);
	}
	for (const extension of [
		'',
		'WAV',
		'.wav',
		'a.b',
		'01234567890',
		'./wav',
		'wav\n',
	]) {
		expect(() => generateBlobId(extension)).toThrow();
	}
});

test('parser rejects traversal, URL modifiers, old keys, and arbitrary filenames', () => {
	const key = 'blob_abcdefghijklmnopqrstu.wav';
	for (const value of [
		null,
		{},
		'take.wav',
		key.toUpperCase(),
		key + '.',
		key + '\n',
		key + '?x=1',
		key + '#x',
		key + '/x',
		'./' + key,
		key.replace('.', '%2e'),
		key.replace('.', '..'),
		key.replace('.', '/'),
		key.replace('.', '\\'),
		key.replace('.wav', ''),
	]) {
		expect(parseBlobId(value)).toBeUndefined();
	}
});
