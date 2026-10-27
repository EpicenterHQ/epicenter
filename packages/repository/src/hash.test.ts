/**
 * Content Hash Tests
 *
 * A file's hash must equal its Git blob id, or a device's base would name
 * nothing in Git once the overlay clears. These compare the plain SHA-1 with
 * `git hash-object` across sizes around the SHA-1 block boundary and Unicode.
 *
 * Key behaviors:
 * - `gitBlobHash` equals `git hash-object` for text and bytes
 * - `sha256` is lowercase hex of the bytes
 */
import { expect, test } from 'bun:test';
import { gitBlobHash, sha256 } from './hash.js';

const gitHash = (content: string) =>
	Bun.spawnSync(['git', 'hash-object', '--stdin'], { stdin: new TextEncoder().encode(content) })
		.stdout.toString()
		.trim();

test('gitBlobHash equals git hash-object', () => {
	for (const content of ['', 'a', 'hello\nworld', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'å 中文 😀\n', 'y'.repeat(100_000)])
		expect(gitBlobHash(content)).toBe(gitHash(content));
});

test('sha256 is lowercase hex of the bytes', async () => {
	expect(await sha256(new TextEncoder().encode('abc'))).toBe(
		'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
	);
});
