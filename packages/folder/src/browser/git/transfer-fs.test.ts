/**
 * Scratch Filesystem Tests
 *
 * isomorphic-git decides what to do from the `code` on a failed operation, so
 * these pin the codes it reads, and that a transfer's bytes cannot leak
 * between files or survive `clear()`.
 *
 * Key behaviors:
 * - a missing path is ENOENT, an existing directory EEXIST, a file where a
 *   directory belongs ENOTDIR, and writing into a missing directory ENOENT
 * - `readFile()` with no argument rejects, which isomorphic-git's probe needs
 *   to recognize this as a promise-based filesystem
 * - written bytes are copied, so a reused buffer does not rewrite the file
 * - clear() empties the whole tree
 */

import { describe, expect, test } from 'bun:test';
import { createScratchFs } from './transfer-fs.js';

async function code(run: Promise<unknown>) {
	try {
		await run;
	} catch (error) {
		return (error as { code?: string }).code;
	}
	return undefined;
}

describe('createScratchFs', () => {
	test('refuses with the codes isomorphic-git reads', async () => {
		const { promises } = createScratchFs();
		expect(await code(promises.readFile('/missing'))).toBe('ENOENT');
		expect(await code(promises.writeFile('/no/dir/file', 'x'))).toBe('ENOENT');
		await promises.mkdir('/dir');
		expect(await code(promises.mkdir('/dir'))).toBe('EEXIST');
		await promises.writeFile('/dir/file', 'x');
		expect(await code(promises.readdir('/dir/file'))).toBe('ENOTDIR');
		expect(await code(promises.mkdir('/dir/file/inner'))).toBe('ENOTDIR');
		expect(await code(promises.readFile('/dir'))).toBe('EISDIR');
		expect(await code(promises.rmdir('/dir'))).toBe('ENOTEMPTY');
		expect(await code(promises.unlink('/gone'))).toBe('ENOENT');
	});

	test('probes as a promise filesystem', async () => {
		const { promises } = createScratchFs();
		const probe = (promises.readFile as () => Promise<unknown>)();
		expect(probe).toBeInstanceOf(Promise);
		await expect(probe).rejects.toBeDefined();
	});

	test('stores what was written, as text or bytes, and lists it', async () => {
		const { promises } = createScratchFs();
		await promises.mkdir('/git');
		await promises.writeFile('/git/HEAD', 'ref: refs/heads/main\n');
		await promises.writeFile('/git/blob', Uint8Array.of(0, 255, 10));
		expect(await promises.readFile('/git/HEAD', 'utf8')).toBe(
			'ref: refs/heads/main\n',
		);
		expect(await promises.readFile('/git/blob')).toEqual(
			Uint8Array.of(0, 255, 10),
		);
		expect((await promises.readdir('/git')).sort()).toEqual(['HEAD', 'blob']);
		const stats = await promises.stat('/git/blob');
		expect([stats.isFile(), stats.isDirectory(), stats.size]).toEqual([
			true,
			false,
			3,
		]);
		await promises.unlink('/git/blob');
		expect(await promises.readdir('/git')).toEqual(['HEAD']);
	});

	test('copies written bytes', async () => {
		const { promises } = createScratchFs();
		const buffer = Uint8Array.of(1, 2, 3);
		await promises.writeFile('/file', buffer);
		buffer.fill(9);
		expect(await promises.readFile('/file')).toEqual(Uint8Array.of(1, 2, 3));
	});

	test('clear forgets everything', async () => {
		const fs = createScratchFs();
		await fs.promises.mkdir('/git');
		await fs.promises.writeFile('/git/file', 'x');
		fs.clear();
		expect(await code(fs.promises.stat('/git'))).toBe('ENOENT');
		await fs.promises.mkdir('/git');
	});
});
