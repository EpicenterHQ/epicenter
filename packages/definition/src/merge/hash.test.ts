/**
 * Content Hash Tests
 *
 * A file's hash must equal its Git blob id, or a device's base would name
 * nothing in Git once the overlay clears. These compare the plain SHA-1 with
 * `git hash-object` across sizes around the SHA-1 block boundary and Unicode.
 *
 * Key behaviors:
 * - `gitBlobHash` equals `git hash-object` for text and bytes
 * - `lfsOid` is lowercase hex SHA-256 of the bytes
 *
 * Ported from `claude/repository-v2` `core/hash.test.ts` at `c32dd466`.
 */
import { expect, test } from 'bun:test';
import { gitBlobHash, lfsOid } from './hash.js';

const gitHash = (content: string) =>
	Bun.spawnSync(['git', 'hash-object', '--stdin'], {
		stdin: new TextEncoder().encode(content),
	})
		.stdout.toString()
		.trim();

test('gitBlobHash equals git hash-object', () => {
	for (const content of [
		'',
		'a',
		'hello\nworld',
		'x'.repeat(55),
		'x'.repeat(56),
		'x'.repeat(64),
		'å 中文 😀\n',
		'y'.repeat(100_000),
	])
		expect(gitBlobHash(content)).toBe(gitHash(content));
});

test('lfsOid is lowercase hex SHA-256 of the bytes', async () => {
	expect(await lfsOid(new TextEncoder().encode('abc'))).toBe(
		'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
	);
});
