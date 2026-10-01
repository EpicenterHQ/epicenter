import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStaticAssets } from './static-assets.ts';

test('loads only the explicitly compiled application directories', async () => {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-assets-'));
	await mkdir(join(root, 'home'));
	await mkdir(join(root, 'mail'));
	await writeFile(join(root, 'home', 'index.html'), '<title>Home</title>');
	await writeFile(join(root, 'mail', 'index.html'), '<title>Mail</title>');

	const assets = await loadStaticAssets(root, [{ id: 'mail', title: 'Mail' }]);
	expect(assets.applications).toHaveLength(1);
	expect(await assets.applications[0]?.resolve('/apps/mail/')).toMatchObject({
		isDocument: true,
	});
});

test('composes an installed bundle with compiled applications through the same resolver', async () => {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-assets-'));
	const installed = await mkdtemp(join(tmpdir(), 'epicenter-installed-'));
	try {
		await mkdir(join(root, 'home'));
		await mkdir(join(root, 'mail'));
		await mkdir(join(installed, 'bundle'));
		await writeFile(join(root, 'home', 'index.html'), '<title>Home</title>');
		await writeFile(join(root, 'mail', 'index.html'), '<title>Mail</title>');
		await writeFile(
			join(installed, 'bundle', 'index.html'),
			'<title>Notes</title>',
		);

		const assets = await loadStaticAssets(
			root,
			[{ id: 'mail', title: 'Mail' }],
			[
				{
					id: 'com.example.notes',
					title: 'Notes',
					version: '1.0.0',
					bundleRoot: join(installed, 'bundle'),
				},
			],
		);
		expect(assets.applications.map(({ id }) => id)).toEqual([
			'mail',
			'com.example.notes',
		]);
		expect(
			await assets.applications[1]?.resolve('/apps/com.example.notes/'),
		).toMatchObject({ isDocument: true });
	} finally {
		await Promise.all([
			rm(root, { recursive: true, force: true }),
			rm(installed, { recursive: true, force: true }),
		]);
	}
});
