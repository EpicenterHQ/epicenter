import { describe, expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';

const browser = Bun.resolveSync('svelte', import.meta.dir).endsWith(
	'index-client.js',
);

describe.skipIf(!browser)('Settings connections mirror', async () => {
	if (!browser) return;
	const { type, click } = await import(
		'../../../../../packages/svelte/src/svelte-dom.test-support.js'
	);
	const { flushSync, mount, unmount } = await import('svelte');
	const {
		createFolder,
		memoryHost,
		SaveError,
		until: waitUntil,
	} = await import('@epicenter/folder/testing');
	const { svelteFolder } = await import('@epicenter/svelte/folder');
	const { connectionTables } = await import('./connections.js');
	const { default: Host } = await import('./ConnectionListHost.svelte');

	const until = (check: () => boolean) =>
		waitUntil(
			() => {
				flushSync();
				return check();
			},
			{ timeout: 2500 },
		);

	async function setup(files: Record<string, string> = {}) {
		const memory = memoryHost(files);
		const owner = expectOk(
			await createFolder(memory.storage, {
				tables: connectionTables,
			}),
		);
		const folder = svelteFolder(owner);
		const target = document.createElement('main');
		document.body.append(target);
		const app = mount(Host, { target, props: { folder } });
		return {
			...memory,
			owner,
			folder,
			target,
			async close() {
				await unmount(app);
				await owner.close();
				target.remove();
			},
		};
	}

	test('title input follows its landed row and add creates a row before returning', async () => {
		const fixture = await setup({
			'connections/account.md':
				'---\nkind: epicenter\ntitle: First\nmodel: ""\n---\n',
		});
		try {
			await until(() => fixture.target.querySelector('li input') !== null);
			type(fixture.target.querySelector('li input'), 'Changed');
			await until(
				() =>
					fixture.text('connections/account.md')?.includes('title: Changed') ??
					false,
			);
			expect(
				fixture.folder.tables.connections.row('account')?.fields?.title,
			).toBe('Changed');
			const addTitle = fixture.target.querySelector<HTMLInputElement>(
				'[aria-label="Title"]',
			);
			type(addTitle, 'Another');
			const kind = fixture.target.querySelector<HTMLSelectElement>(
				'[aria-label="Kind"]',
			);
			if (!kind) throw new Error('Missing kind');
			kind.value = 'epicenter';
			kind.dispatchEvent(new Event('change', { bubbles: true }));
			flushSync();
			fixture.target
				.querySelector('form')
				?.dispatchEvent(
					new Event('submit', { bubbles: true, cancelable: true }),
				);
			await until(
				() => fixture.folder.tables.connections.row('another') !== undefined,
			);
			expect(fixture.text('connections/another.md')).toContain(
				'title: Another',
			);
		} finally {
			await fixture.close();
		}
	});

	test('a failed connection title remains editable until Save again succeeds', async () => {
		const fixture = await setup({
			'connections/account.md':
				'---\nkind: epicenter\ntitle: First\nmodel: ""\n---\n',
		});
		try {
			await until(() => fixture.target.querySelector('li input') !== null);
			fixture.control.failPut.set(
				'connections/account.md',
				SaveError.StorageFailed({ cause: 'full' }).error!,
			);
			const title = fixture.target.querySelector<HTMLInputElement>('li input');
			type(title, 'Changed');
			await until(
				() => fixture.target.textContent?.includes('Not saved:') ?? false,
			);
			expect(title?.value).toBe('Changed');
			expect(fixture.text('connections/account.md')).toContain('title: First');
			fixture.control.failPut.delete('connections/account.md');
			click(fixture.target, 'Save again');
			await until(
				() =>
					fixture.text('connections/account.md')?.includes('title: Changed') ??
					false,
			);
			expect(fixture.target.textContent).not.toContain('Not saved:');
		} finally {
			await fixture.close();
		}
	});

	test('a failed add reports the write error beside the form', async () => {
		const fixture = await setup();
		try {
			fixture.control.failPut.set(
				'connections/account.md',
				SaveError.StorageFailed({ cause: 'full' }).error!,
			);
			type(fixture.target.querySelector('[aria-label="Title"]'), 'Account');
			const kind = fixture.target.querySelector<HTMLSelectElement>(
				'[aria-label="Kind"]',
			);
			if (!kind) throw new Error('Missing kind');
			kind.value = 'epicenter';
			kind.dispatchEvent(new Event('change', { bubbles: true }));
			fixture.target
				.querySelector('form')
				?.dispatchEvent(
					new Event('submit', { bubbles: true, cancelable: true }),
				);
			await until(
				() =>
					fixture.target.textContent?.includes(
						'The connection was not added:',
					) ?? false,
			);
			expect(fixture.folder.tables.connections.row('account')).toBeUndefined();
		} finally {
			await fixture.close();
		}
	});

	test('invalid connection displays its exact text and issues', async () => {
		const fixture = await setup({
			'connections/broken.md': '---\nkind: no-such-kind\n---\nSource\n',
		});
		try {
			await until(
				() =>
					fixture.target.textContent?.includes(
						'does not read as a connection',
					) ?? false,
			);
			expect(fixture.target.querySelector('pre')?.textContent).toContain(
				'kind: no-such-kind',
			);
		} finally {
			await fixture.close();
		}
	});

	test('delete removes the key before the connection row', async () => {
		const fixture = await setup({
			'connections/account.md':
				'---\nkind: epicenter\ntitle: Account\nmodel: ""\n---\n',
		});
		const { commands } = await import('../bindings.gen.js');
		const previous = Reflect.get(commands, 'aiKeyRemove');
		const order: string[] = [];
		Reflect.set(commands, 'aiKeyRemove', async () => {
			order.push('ai_key_remove');
			return { data: true, error: null };
		});
		fixture.control.beforePut = (path) => order.push(path);
		try {
			await until(() => fixture.target.querySelector('li input') !== null);
			click(fixture.target, 'Delete connection');
			await until(
				() => fixture.folder.tables.connections.row('account') === undefined,
			);
			expect(order).toEqual(['ai_key_remove', 'connections/account.md']);
			expect(fixture.text('connections/account.md')).toBeUndefined();
		} finally {
			if (previous === undefined)
				Reflect.deleteProperty(commands, 'aiKeyRemove');
			else Reflect.set(commands, 'aiKeyRemove', previous);
			await fixture.close();
		}
	});

	test('a failed deletion keeps the row and reports the write error', async () => {
		const fixture = await setup({
			'connections/account.md':
				'---\nkind: epicenter\ntitle: Account\nmodel: ""\n---\n',
		});
		const { commands } = await import('../bindings.gen.js');
		const previous = Reflect.get(commands, 'aiKeyRemove');
		Reflect.set(commands, 'aiKeyRemove', async () => ({
			data: true,
			error: null,
		}));
		try {
			fixture.control.failPut.set(
				'connections/account.md',
				SaveError.StorageFailed({ cause: 'full' }).error!,
			);
			await until(() => fixture.target.querySelector('li input') !== null);
			click(fixture.target, 'Delete connection');
			await until(
				() =>
					fixture.target.textContent?.includes(
						'The connection was not deleted:',
					) ?? false,
			);
			expect(fixture.folder.tables.connections.row('account')).toBeDefined();
		} finally {
			if (previous === undefined)
				Reflect.deleteProperty(commands, 'aiKeyRemove');
			else Reflect.set(commands, 'aiKeyRemove', previous);
			await fixture.close();
		}
	});
});
