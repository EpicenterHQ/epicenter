/**
 * Settings connection context tests.
 * Mounts two connection lists over separate real Markdown folders. Descendant
 * editors must read and autosave to their own provider, and closing one folder
 * must disable its form without disabling the other. No keychain call is needed.
 */
import { describe, expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';

const browser = Bun.resolveSync('svelte', import.meta.dir).endsWith(
	'index-client.js',
);

describe.skipIf(!browser)('Settings folder context', async () => {
	if (!browser) return;
	const { type } = await import(
		'../../../../../packages/svelte/src/svelte-dom.test-support.js'
	);
	const { flushSync, mount, unmount } = await import('svelte');
	const { createFolderContext } = await import('@epicenter/svelte/folder');
	const { createNativeFolder } = await import(
		'../../../../../packages/folder/src/native/engine.js'
	);
	const { nativeStorage } = await import(
		'../../../../../packages/folder/src/native/storage.js'
	);
	const { mkdir, mkdtemp, rm } = await import('node:fs/promises');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const { connectionTables } = await import('./connections.js');
	const { default: ConnectionList } = await import('./ConnectionList.svelte');

	async function until(check: () => boolean) {
		for (let attempt = 0; attempt < 400; attempt++) {
			flushSync();
			if (check()) return;
			await Bun.sleep(5);
		}
		throw new Error('The connection view did not update');
	}

	test('nested editors autosave to their own folder and closing stays reactive', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'connection-context-'));
		async function open(title: string) {
			const root = join(directory, crypto.randomUUID());
			await mkdir(root);
			const folder = createNativeFolder({
				directory: `bun:${root}`,
				tables: connectionTables,
				storage: nativeStorage(root),
				saveAfterMs: 20,
			});
			expectOk(
				await folder.tables.connections.set('account', null, {
					fields: { kind: 'epicenter', title, model: '' },
					body: '',
				}),
			);
			const context = createFolderContext(folder);
			const target = document.createElement('main');
			document.body.append(target);
			const app = mount(ConnectionList, { target, props: { context } });
			return { folder, context, target, app };
		}
		const owners: Awaited<ReturnType<typeof open>>[] = [];
		try {
			for (const title of ['First account', 'Second account']) {
				owners.push(await open(title));
			}
			const [first, second] = owners;
			if (!first || !second) throw new Error('Missing connection lists');
			await until(() =>
				owners.every(({ target }) => target.querySelector('li input') !== null),
			);
			const title = first.target.querySelector<HTMLInputElement>('li input');
			type(title, 'Edited first account');
			await until(
				() =>
					first.folder.tables.connections.edit('account').getPending() ===
					undefined,
			);
			const savedFirst = expectOk(
				await first.folder.tables.connections.get('account'),
			);
			const savedSecond = expectOk(
				await second.folder.tables.connections.get('account'),
			);
			if (
				!savedFirst ||
				savedFirst.issues !== null ||
				!savedSecond ||
				savedSecond.issues !== null
			)
				throw new Error('Connection files did not read');
			expect(savedFirst.fields.title).toBe('Edited first account');
			expect(savedSecond.fields.title).toBe('Second account');
			expect(
				second.target.querySelector<HTMLInputElement>('li input')?.value,
			).toBe('Second account');
			const add = (target: HTMLElement) =>
				[...target.querySelectorAll('button')].find(
					(button) => button.textContent?.trim() === 'Add',
				);
			expect(add(first.target)?.disabled).toBe(false);
			await first.context.close();
			await until(() => add(first.target)?.disabled === true);
			expect(add(second.target)?.disabled).toBe(false);
		} finally {
			for (const { app, context, target } of owners.reverse()) {
				await unmount(app);
				await context.close();
				target.remove();
			}
			await rm(directory, { recursive: true, force: true });
		}
	});
});
