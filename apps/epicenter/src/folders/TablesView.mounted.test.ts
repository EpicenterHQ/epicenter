/** Pending grid fields must be interpreted before an edit's reread finishes. */
import { describe, expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';

const browser = Bun.resolveSync('svelte', import.meta.dir).endsWith(
	'index-client.js',
);

describe.skipIf(!browser)('pending table documents', async () => {
	if (!browser) return;
	const { click, type } = await import(
		'../../../../packages/svelte/src/svelte-dom.test-support.js'
	);
	const { flushSync, mount, unmount } = await import('svelte');
	const { createFolderContext } = await import('@epicenter/svelte/folder');
	const { default: FolderViewHost } = await import(
		'./fixtures/FolderViewHost.svelte'
	);
	const { mkdtemp, mkdir, readFile, realpath, rm, writeFile } = await import(
		'node:fs/promises'
	);
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const { createNativeFolder } = await import(
		'../../../../packages/folder/src/native/engine.js'
	);
	const { nativeStorage } = await import(
		'../../../../packages/folder/src/native/storage.js'
	);

	async function until(check: () => boolean) {
		for (let turn = 0; turn < 400; turn++) {
			flushSync();
			if (check()) return;
			await Bun.sleep(5);
		}
		throw new Error('The pending table document did not update');
	}

	test('repairing a required field clears its issue before the edit rereads or saves', async () => {
		const directory = await realpath(
			await mkdtemp(join(tmpdir(), 'table-projection-')),
		);
		const path = 'notes/a.md';
		const source = '---\nextra: kept\n---\nBody\n';
		await mkdir(join(directory, 'notes'));
		await writeFile(join(directory, path), source);
		await writeFile(
			join(directory, 'epicenter.json'),
			JSON.stringify({
				tables: {
					notes: {
						type: 'object',
						properties: { title: { type: 'string' } },
						required: ['title'],
					},
				},
			}),
		);
		const storage = nativeStorage(directory);
		const release = Promise.withResolvers<void>();
		let holdRead = false;
		let waitingReads = 0;
		const folder = createNativeFolder({
			storage: {
				...storage,
				async read(target) {
					if (holdRead && target === path) {
						waitingReads++;
						await release.promise;
					}
					return storage.read(target);
				},
			},
			tables: {},
			directory,
			saveAfterMs: 60_000,
		});
		const context = createFolderContext(folder);
		const target = document.createElement('div');
		document.body.append(target);
		const view = mount(FolderViewHost, { target, props: { context } });
		try {
			click(target, 'Tables');
			const input = () =>
				target.querySelector<HTMLInputElement>(
					'[aria-label="notes/a.md: title"]',
				);
			const row = () => input()?.closest('tr');
			await until(() => input() !== null);
			expect(row()?.textContent).toContain('required');
			expect(folder.files.edit(path).getText()).toBe(source);
			holdRead = true;
			const refreshing = folder.files.edit(path).read();
			await until(() => waitingReads > 0);
			type(input(), 'Repaired');
			expect(input()?.value).toBe('Repaired');
			await until(() => !row()?.textContent?.includes('required'));
			expect(folder.files.edit(path).getPending()?.text).toContain('title: Repaired');
			expect(folder.files.edit(path).getText()).toContain('title: Repaired');
			expect(await readFile(join(directory, path), 'utf8')).toBe(source);

			holdRead = false;
			release.resolve();
			expectOk(await refreshing);
			await folder.files.edit(path).save();
			expect(await readFile(join(directory, path), 'utf8')).toContain(
				'title: Repaired',
			);
			expect(await readFile(join(directory, path), 'utf8')).toContain(
				'extra: kept',
			);
		} finally {
			holdRead = false;
			release.resolve();
			await unmount(view);
			await context.close();
			target.remove();
			await rm(directory, { recursive: true, force: true });
		}
	});
});
