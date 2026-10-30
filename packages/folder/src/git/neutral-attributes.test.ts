/**
 * Neutral Attributes Tests
 *
 * `neutralizeAttributes` makes the line that unsets every byte-changing
 * attribute the last line of a repository's `info/attributes`, the line that
 * wins over every other attribute source.
 *
 * Key behaviors:
 * - A missing file, or a missing `info/`, becomes the line alone
 * - A person's lines stay, above the line; an earlier copy of the line moves
 *   to the end
 * - Nothing is written when the line is already last
 * - A link at the path is replaced, and the file it points to is untouched
 *
 * See also:
 * - `../directory-history.test.ts` and `packages/cli/src/history.test.ts`
 *   for the checkouts it governs
 */
import { expect, test } from 'bun:test';
import { lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nodeDirectoryPrimitives } from '../directory-node.js';
import { scratch } from '../git-http.test-support.js';
import {
	NEUTRAL_ATTRIBUTES,
	neutralizeAttributes,
} from './neutral-attributes.js';

async function gitdir() {
	const root = await scratch('neutral-attributes-');
	return {
		root,
		gitdir: join(root, '.git'),
		path: join(root, '.git/info/attributes'),
	};
}

test('a missing info directory gets the line alone', async () => {
	const { gitdir: dir, path } = await gitdir();
	await neutralizeAttributes(nodeDirectoryPrimitives, dir);
	expect(await readFile(path, 'utf8')).toBe(`${NEUTRAL_ATTRIBUTES}\n`);
});

test("a person's lines stay above the line, and an earlier copy of it moves last", async () => {
	const { gitdir: dir, path } = await gitdir();
	await mkdir(join(dir, 'info'), { recursive: true });
	await writeFile(
		path,
		`*.lockb diff=lockb\n${NEUTRAL_ATTRIBUTES}\n*.md merge=ours`,
	);
	await neutralizeAttributes(nodeDirectoryPrimitives, dir);
	expect(await readFile(path, 'utf8')).toBe(
		`*.lockb diff=lockb\n*.md merge=ours\n${NEUTRAL_ATTRIBUTES}\n`,
	);
});

test('nothing is written when the line is already last', async () => {
	const { gitdir: dir, path } = await gitdir();
	await neutralizeAttributes(nodeDirectoryPrimitives, dir);
	const before = await lstat(path);
	await neutralizeAttributes(nodeDirectoryPrimitives, dir);
	const after = await lstat(path);
	expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
});

test.skipIf(process.platform === 'win32')(
	'a link at the path is replaced by a file, and its target is untouched',
	async () => {
		const { root, gitdir: dir, path } = await gitdir();
		const elsewhere = join(root, 'elsewhere');
		await writeFile(elsewhere, '*.md diff=markdown\n');
		await mkdir(join(dir, 'info'), { recursive: true });
		await symlink(elsewhere, path);
		await neutralizeAttributes(nodeDirectoryPrimitives, dir);
		expect((await lstat(path)).isFile()).toBe(true);
		expect(await readFile(path, 'utf8')).toBe(`${NEUTRAL_ATTRIBUTES}\n`);
		expect(await readFile(elsewhere, 'utf8')).toBe('*.md diff=markdown\n');
	},
);
