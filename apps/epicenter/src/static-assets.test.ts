/**
 * Static application asset composition over real temporary bundle directories.
 *
 * Key behaviors:
 * - Only explicitly declared compiled applications enter the served list
 */
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStaticAssets } from './static-assets.ts';

test('loads only the explicitly compiled application directories', async () => {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-assets-'));
	try {
		await mkdir(join(root, 'home'));
		await mkdir(join(root, 'mail'));
		await mkdir(join(root, 'undeclared'));
		await writeFile(
			join(root, 'undeclared', 'index.html'),
			'<title>Undeclared</title>',
		);
		await writeFile(join(root, 'home', 'index.html'), '<title>Home</title>');
		await writeFile(join(root, 'mail', 'index.html'), '<title>Mail</title>');

		const assets = await loadStaticAssets(root, [
			{ id: 'mail', title: 'Mail' },
		]);
		expect(assets.applications.map(({ id }) => id)).toEqual(['mail']);
		expect(await assets.applications[0]?.resolve('/apps/mail/')).toMatchObject({
			isDocument: true,
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
