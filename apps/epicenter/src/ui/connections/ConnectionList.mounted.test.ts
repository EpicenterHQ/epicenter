import { describe, expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';

const browser = Bun.resolveSync('svelte', import.meta.dir).endsWith(
	'index-client.js',
);

describe.skipIf(!browser)('Settings connections mirror', async () => {
	if (!browser) return;
	const { type } = await import(
		'../../../../../packages/svelte/src/svelte-dom.test-support.js'
	);
	const { flushSync, mount, unmount } = await import('svelte');
	const { createFolder, memoryHost } = await import(
		'@epicenter/folder/next/testing'
	);
	const { svelteFolder } = await import('@epicenter/svelte/folder-next');
	const { connectionTables } = await import('./connections.js');
	const { default: Host } = await import('./ConnectionListHost.svelte');

	async function until(check: () => boolean) {
		for (let turn = 0; turn < 400; turn++) {
			flushSync();
			if (check()) return;
			await Bun.sleep(5);
		}
		throw new Error('Connections did not update');
	}

	async function setup(files: Record<string, string> = {}) {
		const memory = memoryHost(files);
		const owner = expectOk(
			await createFolder(memory.storage, {
				tables: connectionTables,
				throttleMs: 0,
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
});
