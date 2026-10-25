import { describe, expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';

const browser = Bun.resolveSync('svelte', import.meta.dir).endsWith(
	'index-client.js',
);

describe.skipIf(!browser)('folder editor mirror', async () => {
	if (!browser) return;
	const { click, type } = await import(
		'../../../../packages/svelte/src/svelte-dom.test-support.js'
	);
	const { flushSync, mount, unmount } = await import('svelte');
	const { createFolder, memoryHost } = await import(
		'@epicenter/folder/next/testing'
	);
	const { svelteFolder } = await import('@epicenter/svelte/folder-next');
	const { default: FolderViewHost } = await import(
		'./fixtures/FolderViewHost.svelte'
	);

	async function until(check: () => boolean) {
		for (let turn = 0; turn < 400; turn++) {
			flushSync();
			if (check()) return;
			await Bun.sleep(5);
		}
		throw new Error('The folder view did not update');
	}

	async function setup(
		files: Record<string, string | Uint8Array>,
		throttleMs = 0,
		failRead?: string,
	) {
		const memory = memoryHost(files);
		let blocked = failRead !== undefined;
		if (failRead !== undefined) {
			const read = memory.storage.read;
			memory.storage.read = async (paths) => {
				const results = new Map(await read(paths));
				if (blocked) {
					const { ReadError } = await import(
						'../../../../packages/folder/src/shared/errors.js'
					);
					results.set(
						failRead,
						ReadError.StorageFailed({ cause: 'temporarily unreadable' }),
					);
				}
				return results;
			};
		}
		const owner = expectOk(
			await createFolder(memory.storage, { tables: {}, throttleMs }),
		);
		const failures: string[] = [];
		const folder = svelteFolder(owner, {
			onFailed: (failure) => failures.push(failure.path),
		});
		const target = document.createElement('div');
		document.body.append(target);
		const app = mount(FolderViewHost, { target, props: { folder } });
		return {
			...memory,
			owner,
			folder,
			failures,
			target,
			unblock() {
				blocked = false;
			},
			file(path: string) {
				return target.querySelector(`nav button[title="${path}"]`);
			},
			box() {
				return target.querySelector<HTMLTextAreaElement>('textarea');
			},
			async close() {
				await unmount(app);
				await owner.close();
				target.remove();
			},
		};
	}

	async function choose(trigger: Element | null, label: string) {
		if (!trigger) throw new Error('Missing select trigger');
		trigger.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
		);
		await until(() =>
			[...document.querySelectorAll('[role="option"]')].some(
				(option) => option.textContent?.trim() === label,
			),
		);
		[...document.querySelectorAll('[role="option"]')]
			.find((option) => option.textContent?.trim() === label)
			?.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
		flushSync();
	}

	test('Files edits source and keeps BOM and CRLF', async () => {
		const fixture = await setup({ 'a.md': '\ufefffirst\r\nsecond\r\n' });
		try {
			await until(() => !!fixture.file('a.md'));
			fixture
				.file('a.md')
				?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			await until(() => fixture.box() !== null);
			expect(fixture.box()?.value).toBe('\ufefffirst\nsecond\n');
			type(fixture.box(), '\ufefffirst\nchanged\n');
			await until(() => fixture.text('a.md') === 'first\r\nchanged\r\n');
			expect(fixture.box()?.value).toBe('\ufefffirst\nchanged\n');
		} finally {
			await fixture.close();
		}
	});

	test('unkept UTF-8 source edits without flashing the old text', async () => {
		const fixture = await setup({ 'script.py': 'print(1)\n' });
		try {
			await until(() => !!fixture.file('script.py'));
			fixture
				.file('script.py')
				?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			await until(() => fixture.box()?.value === 'print(1)\n');
			type(fixture.box(), 'print(2)\n');
			await until(() => fixture.text('script.py') === 'print(2)\n');
			expect(fixture.box()?.value).toBe('print(2)\n');
		} finally {
			await fixture.close();
		}
	});

	test('mixed line endings and binary files are shown read-only', async () => {
		const fixture = await setup({
			'mixed.txt': 'a\r\nb\n',
			'raw.bin': new Uint8Array([0xff, 0x00]),
		});
		try {
			await until(() => !!fixture.file('mixed.txt'));
			fixture
				.file('mixed.txt')
				?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			await until(
				() =>
					fixture.target.textContent?.includes('mixes line endings') ?? false,
			);
			expect(fixture.box()).toBeNull();
			fixture
				.file('raw.bin')
				?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			await until(
				() =>
					fixture.target.textContent?.includes('cannot be edited as text') ??
					false,
			);
			expect(fixture.box()).toBeNull();
		} finally {
			await fixture.close();
		}
	});

	test('an outside edit replaces the open file source', async () => {
		const fixture = await setup({ 'a.md': 'Old\n' });
		try {
			await until(() => !!fixture.file('a.md'));
			fixture
				.file('a.md')
				?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			await until(() => fixture.box()?.value === 'Old\n');
			fixture.outside('a.md', 'New\n');
			await until(() => fixture.box()?.value === 'New\n');
		} finally {
			await fixture.close();
		}
	});

	test('a read error offers a retry and then shows the file', async () => {
		const fixture = await setup({ 'a.md': 'Restored\n' }, 0, 'a.md');
		try {
			await until(() => !!fixture.file('a.md'));
			fixture
				.file('a.md')
				?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			await until(
				() =>
					fixture.target.textContent?.includes('temporarily unreadable') ??
					false,
			);
			fixture.unblock();
			click(fixture.target, 'Try again');
			await until(() => fixture.box()?.value === 'Restored\n');
		} finally {
			await fixture.close();
		}
	});

	test('root and nested Markdown cells update their paths', async () => {
		const fixture = await setup({
			'root.md': '---\ntitle: Root\n---\n',
			'notes/deep/a.md': '---\ntitle: Deep\n---\n',
		});
		try {
			click(fixture.target, 'Tables');
			await until(
				() =>
					fixture.target.querySelector('[aria-label="root.md: title"]') !==
					null,
			);
			type(
				fixture.target.querySelector('[aria-label="root.md: title"]'),
				'Changed root',
			);
			await until(
				() => fixture.text('root.md')?.includes('title: Changed root') ?? false,
			);
			await choose(
				fixture.target.querySelector('[id="table-directory"]'),
				'notes/deep',
			);
			await until(
				() =>
					fixture.target.querySelector(
						'[aria-label="notes/deep/a.md: title"]',
					) !== null,
			);
			type(
				fixture.target.querySelector('[aria-label="notes/deep/a.md: title"]'),
				'Changed deep',
			);
			await until(
				() =>
					fixture.text('notes/deep/a.md')?.includes('title: Changed deep') ??
					false,
			);
		} finally {
			await fixture.close();
		}
	});

	test('a cell draft keeps later typing through its own save and another row change', async () => {
		const fixture = await setup({
			'a.md': '---\ntitle: First\n---\n',
			'b.md': '---\ntitle: Second\n---\n',
		}, 20);
		try {
			click(fixture.target, 'Tables');
			await until(() => fixture.target.querySelector('[aria-label="a.md: title"]') !== null);
			const input = fixture.target.querySelector<HTMLInputElement>('[aria-label="a.md: title"]');
			type(input, 'First change');
			await until(() => fixture.text('a.md')?.includes('title: First change') ?? false);
			fixture.outside('b.md', '---\ntitle: Outside\n---\n');
			type(input, 'Final change');
			expect(input?.value).toBe('Final change');
			await until(() => fixture.text('a.md')?.includes('title: Final change') ?? false);
			expect(input?.value).toBe('Final change');
		} finally { await fixture.close(); }
	});

	test('a focused row remains visible after its edit leaves the filter', async () => {
		const fixture = await setup({ 'a.md': '---\nstatus: todo\n---\n' });
		try {
			click(fixture.target, 'Tables');
			flushSync();
			click(fixture.target, 'Add filter');
			flushSync();
			await choose(
				fixture.target.querySelector('[aria-label="Filter comparison 1"]'),
				'equals',
			);
			type(
				fixture.target.querySelector('[aria-label="Filter value 1"]'),
				'todo',
			);
			await until(
				() =>
					fixture.target.querySelector('[aria-label="a.md: status"]') !== null,
			);
			const input = fixture.target.querySelector<HTMLInputElement>(
				'[aria-label="a.md: status"]',
			);
			input?.focus();
			type(input, 'done');
			await until(
				() => fixture.text('a.md')?.includes('status: done') ?? false,
			);
			expect(fixture.target.textContent).toContain(
				"No longer matches this view's filters",
			);
			input?.blur();
			await until(
				() =>
					fixture.target.querySelector('[aria-label="a.md: status"]') === null,
			);
		} finally {
			await fixture.close();
		}
	});

	test('a failed board move keeps the card in its lane and reports once', async () => {
		const fixture = await setup({
			'a.md': '---\nstatus: todo\n---\n',
			'b.md': '---\nstatus: done\n---\n',
		});
		try {
			click(fixture.target, 'Tables');
			flushSync();
			click(fixture.target, 'Board');
			await until(
				() => fixture.target.querySelector('[aria-label="Move a.md"]') !== null,
			);
			const { SaveError } = await import(
				'../../../../packages/folder/src/shared/errors.js'
			);
			fixture.control.failPut.set(
				'a.md',
				SaveError.StorageFailed({ cause: 'full' }).error!,
			);
			await choose(
				fixture.target.querySelector('[aria-label="Move a.md"]'),
				'done',
			);
			await until(() => fixture.failures.length === 1);
			expect(fixture.text('a.md')).toContain('status: todo');
			expect(
				fixture.target.querySelector('[aria-label="todo"]')?.textContent,
			).toContain('a.md');
			expect(fixture.failures).toEqual(['a.md']);
		} finally {
			await fixture.close();
		}
	});
});
