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
	const { createFolder, memoryHost, SaveError, until: waitUntil } = await import(
		'@epicenter/folder/testing'
	);
	const { svelteFolder } = await import('@epicenter/svelte/folder');
	const { default: FolderViewHost } = await import(
		'./fixtures/FolderViewHost.svelte'
	);
	const { default: FieldCell } = await import('./FieldCell.svelte');

	const until = (check: () => boolean) =>
		waitUntil(
			() => {
				flushSync();
				return check();
			},
			{ timeout: 2500 },
		);

	async function setup(
		files: Record<string, string | Uint8Array>,
		failRead?: string,
	) {
		const memory = memoryHost(files);
		let blocked = failRead !== undefined;
		if (failRead !== undefined) {
			const read = memory.storage.read;
			memory.storage.read = async (paths) => {
				const results = new Map(await read(paths));
				if (blocked) {
					const { ReadError } = await import('@epicenter/folder/testing');
					results.set(
						failRead,
						ReadError.StorageFailed({ cause: 'temporarily unreadable' }),
					);
				}
				return results;
			};
		}
		const owner = expectOk(
			await createFolder(memory.storage, { tables: {} }),
		);
		const folder = svelteFolder(owner);
		const target = document.createElement('div');
		document.body.append(target);
		const app = mount(FolderViewHost, { target, props: { folder } });
		return {
			...memory,
			owner,
			folder,
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

	test('a failed file edit stays visible and Save again writes it', async () => {
		const fixture = await setup({ 'a.md': 'Original\n' });
		try {
			await until(() => fixture.file('a.md') !== null);
			fixture.file('a.md')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			await until(() => fixture.box()?.value === 'Original\n');
			fixture.control.failPut.set('a.md', SaveError.StorageFailed({ cause: 'full' }).error!);
			type(fixture.box(), 'Changed\n');
			await until(() => fixture.target.textContent?.includes('Not saved:') ?? false);
			expect(fixture.box()?.value).toBe('Changed\n');
			expect(fixture.text('a.md')).toBe('Original\n');
			fixture.control.failPut.delete('a.md');
			click(fixture.target, 'Save again');
			await until(() => fixture.text('a.md') === 'Changed\n');
			expect(fixture.box()?.value).toBe('Changed\n');
			expect(fixture.target.textContent).not.toContain('Not saved:');
		} finally {
			await fixture.close();
		}
	});

	test('a failed file edit remains recoverable after outside deletion', async () => {
		const fixture = await setup({ 'a.md': 'Original\n' });
		try {
			await until(() => fixture.file('a.md') !== null);
			fixture.file('a.md')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			await until(() => fixture.box()?.value === 'Original\n');
			fixture.control.failPut.set('a.md', SaveError.StorageFailed({ cause: 'full' }).error!);
			type(fixture.box(), 'Changed\n');
			await until(() => fixture.target.textContent?.includes('Not saved:') ?? false);
			fixture.outside('a.md', null);
			await until(() => fixture.folder.file('a.md') === undefined);
			expect(fixture.box()).toBeNull();
			expect(fixture.target.textContent).toContain('Not saved:');
			expect(fixture.target.textContent).toContain('Copy');
		} finally {
			await fixture.close();
		}
	});

	test('typing again during a file save keeps the latest text', async () => {
		const fixture = await setup({ 'a.md': 'First\n' });
		let release: (() => void) | undefined;
		try {
			await until(() => fixture.file('a.md') !== null);
			fixture.file('a.md')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			await until(() => fixture.box()?.value === 'First\n');
			fixture.control.putGate = new Promise<void>((resolve) => { release = resolve; });
			type(fixture.box(), 'Second\n');
			await until(() => fixture.folder.saving);
			type(fixture.box(), 'Third\n');
			expect(fixture.box()?.value).toBe('Third\n');
			release?.();
			fixture.control.putGate = undefined;
			await until(() => fixture.text('a.md') === 'Third\n');
			expect(fixture.box()?.value).toBe('Third\n');
			expect(fixture.text('a.md')).toBe('Third\n');
		} finally {
			release?.();
			fixture.control.putGate = undefined;
			await fixture.close();
		}
	});

	test('a whole-file draft recreates a file deleted while its save waits', async () => {
		const fixture = await setup({ 'a.md': 'First\n' });
		let release: (() => void) | undefined;
		try {
			await until(() => fixture.file('a.md') !== null);
			fixture.file('a.md')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			await until(() => fixture.box()?.value === 'First\n');
			fixture.control.putGate = new Promise<void>((resolve) => { release = resolve; });
			type(fixture.box(), 'Recreated\n');
			fixture.outside('a.md', null);
			release?.();
			fixture.control.putGate = undefined;
			await until(() => fixture.text('a.md') === 'Recreated\n');
			await until(() => fixture.box()?.value === 'Recreated\n');
		} finally {
			release?.();
			fixture.control.putGate = undefined;
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
			const box = fixture.box();
			box?.focus();
			type(fixture.box(), 'print(2)\n');
			await until(() => fixture.text('script.py') === 'print(2)\n');
			expect(fixture.box()?.value).toBe('print(2)\n');
			expect(fixture.box()).toBe(box);
			expect(document.activeElement).toBe(box);
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
		const fixture = await setup({ 'a.md': 'Restored\n' }, 'a.md');
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

	test('a missing declared field edits canonically and appears in Files', async () => {
		const fixture = await setup({
			'epicenter.json': JSON.stringify({
				tables: {
					notes: {
						type: 'object',
						properties: { title: { type: 'string' } },
						required: ['title'],
					},
				},
			}),
			'notes/a.md': '---\nextra: kept\n---\nBody\n',
		});
		try {
			click(fixture.target, 'Tables');
			await until(
				() =>
					fixture.target.querySelector('[aria-label="notes/a.md: title"]') !==
					null,
			);
			type(
				fixture.target.querySelector('[aria-label="notes/a.md: title"]'),
				'Fixed',
			);
			await until(
				() => fixture.text('notes/a.md')?.includes('title: Fixed') ?? false,
			);
			expect(fixture.text('notes/a.md')).toContain('extra: kept');
			fixture.target
				.querySelector('[data-row-path="notes/a.md"] button')
				?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			await until(() => fixture.box()?.value.includes('title: Fixed') ?? false);
		} finally {
			await fixture.close();
		}
	});

	test('browsing writes nothing and the first SQL view save creates only views', async () => {
		const fixture = await setup({ 'a.md': 'Body\n' });
		try {
			click(fixture.target, 'Tables');
			flushSync();
			click(fixture.target, 'SQL');
			await until(
				() =>
					fixture.target.querySelector('[aria-label="View title"]') !== null,
			);
			expect(fixture.log.puts).toHaveLength(0);
			click(fixture.target, 'Save view');
			await until(() => fixture.text('epicenter.json') !== undefined);
			expect(
				Object.keys(JSON.parse(fixture.text('epicenter.json') ?? '{}')),
			).toEqual(['views']);
			expect(fixture.log.puts.map((put) => put.path)).toEqual([
				'epicenter.json',
			]);
		} finally {
			await fixture.close();
		}
	});

	test('concurrent view saves keep both records', async () => {
		const fixture = await setup({ 'notes/a.md': 'Body\n' });
		try {
			click(fixture.target, 'Tables');
			await until(
				() => fixture.target.querySelector('[id="table-directory"]') !== null,
			);
			await choose(
				fixture.target.querySelector('[id="table-directory"]'),
				'notes',
			);
			click(fixture.target, 'Save view');
			flushSync();
			expect(fixture.target.textContent).not.toContain('This view was deleted');
			click(fixture.target, 'Save as new');
			flushSync();
			expect(fixture.target.textContent).not.toContain('This view was deleted');
			await until(
				() =>
					Object.keys(
						JSON.parse(fixture.text('epicenter.json') ?? '{}').views ?? {},
					).length === 2,
			);
			expect(
				Object.keys(JSON.parse(fixture.text('epicenter.json') ?? '{}').views),
			).toHaveLength(2);
		} finally {
			await fixture.close();
		}
	});

	test('board-to-grid save and Present filter replace their previous view settings', async () => {
		const fixture = await setup({ 'notes/a.md': '---\nstatus: todo\n---\n' });
		try {
			click(fixture.target, 'Tables');
			await until(
				() => fixture.target.querySelector('[id="table-directory"]') !== null,
			);
			await choose(
				fixture.target.querySelector('[id="table-directory"]'),
				'notes',
			);
			click(fixture.target, 'Board');
			flushSync();
			click(fixture.target, 'Save view');
			await until(
				() => fixture.text('epicenter.json')?.includes('"board"') ?? false,
			);
			click(fixture.target, 'Grid');
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
			flushSync();
			await choose(
				fixture.target.querySelector('[aria-label="Filter comparison 1"]'),
				'has a value',
			);
			click(fixture.target, 'Save view');
			await until(
				() => fixture.text('epicenter.json')?.includes('"grid"') ?? false,
			);
			const saved = Object.values(
				JSON.parse(fixture.text('epicenter.json') ?? '{}').views ?? {},
			)[0];
			expect(saved).toMatchObject({
				type: 'grid',
				filters: [{ operator: 'exists', value: true }],
			});
		} finally {
			await fixture.close();
		}
	});

	test('a table view explains why All Markdown cannot be saved', async () => {
		const fixture = await setup({ 'notes/a.md': 'Body\n' });
		try {
			click(fixture.target, 'Tables');
			await until(
				() =>
					fixture.target.textContent?.includes(
						'Choose a top-level directory',
					) ?? false,
			);
			const save = [...fixture.target.querySelectorAll('button')].find(
				(button) => button.textContent?.trim() === 'Save view',
			);
			expect(save?.disabled).toBe(true);
			await choose(
				fixture.target.querySelector('[id="table-directory"]'),
				'notes',
			);
			expect(save?.disabled).toBe(false);
			await until(() => document.querySelector('[role="option"]') === null);
		} finally {
			await fixture.close();
		}
	});

	test('malformed Markdown remains editable in Files as source', async () => {
		const fixture = await setup({ 'a.md': 'Body\n' });
		try {
			await until(() => !!fixture.file('a.md'));
			fixture
				.file('a.md')
				?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			await until(() => fixture.box() !== null);
			type(fixture.box(), '---\ntitle: [\n---\nBody\n');
			await until(() => fixture.text('a.md')?.includes('title: [') ?? false);
			click(fixture.target, 'Tables');
			await until(
				() =>
					fixture.target.querySelector('[data-row-path="a.md"] button') !==
					null,
			);
			fixture.target
				.querySelector('[data-row-path="a.md"] button')
				?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			await until(() => fixture.box()?.value.includes('title: [') ?? false);
		} finally {
			await fixture.close();
		}
	});

	test('a cell draft keeps later typing through its own save and another row change', async () => {
		const fixture = await setup(
			{
				'a.md': '---\ntitle: First\n---\n',
				'b.md': '---\ntitle: Second\n---\n',
			},
		);
		try {
			click(fixture.target, 'Tables');
			await until(
				() =>
					fixture.target.querySelector('[aria-label="a.md: title"]') !== null,
			);
			const input = fixture.target.querySelector<HTMLInputElement>(
				'[aria-label="a.md: title"]',
			);
			type(input, 'First change');
			await until(
				() => fixture.text('a.md')?.includes('title: First change') ?? false,
			);
			fixture.outside('b.md', '---\ntitle: Outside\n---\n');
			type(input, 'Final change');
			expect(input?.value).toBe('Final change');
			await until(
				() => fixture.text('a.md')?.includes('title: Final change') ?? false,
			);
			expect(input?.value).toBe('Final change');
		} finally {
			await fixture.close();
		}
	});

	test('a focused row remains visible after its edit leaves the filter', async () => {
		const fixture = await setup({ 'a.md': '---\nstatus: todo\n---\n', 'b.md': '---\nstatus: todo\n---\n' });
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
			expect(document.activeElement).toBe(input);
			expect(fixture.target.querySelector('[aria-label="b.md: status"]')).not.toBeNull();
			input?.blur();
			await until(
				() =>
					fixture.target.querySelector('[aria-label="a.md: status"]') === null,
			);
		} finally {
			await fixture.close();
		}
	});

	test('a failed board move reports the error while the card stays in its lane', async () => {
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
			fixture.control.failPut.set(
				'a.md',
				SaveError.StorageFailed({ cause: 'full' }).error!,
			);
			await choose(
				fixture.target.querySelector('[aria-label="Move a.md"]'),
				'done',
			);
			await until(() => fixture.target.textContent?.includes('Move failed:') ?? false);
			expect(fixture.text('a.md')).toContain('status: todo');
			expect(fixture.target.querySelector('[aria-label="Move a.md"]')?.textContent).toContain('todo');
			expect(
				fixture.target.querySelector('[aria-label="todo"]')?.textContent,
			).toContain('a.md');
			fixture.control.failPut.delete('a.md');
			await choose(fixture.target.querySelector('[aria-label="Move a.md"]'), 'done');
			await until(() => fixture.text('a.md')?.includes('status: done') ?? false);
		} finally {
			await fixture.close();
		}
	});

	test('a number cell keeps incomplete input local and saves a valid number', async () => {
		const fixture = await setup({ 'a.md': '---\ncount: 3\n---\n' });
		try {
			click(fixture.target, 'Tables');
			await until(() => fixture.target.querySelector('[aria-label="a.md: count"]') !== null);
			const input = fixture.target.querySelector<HTMLInputElement>('[aria-label="a.md: count"]');
			type(input, '');
			flushSync();
			expect(fixture.text('a.md')).toContain('count: 3');
			type(input, '-');
			flushSync();
			expect(fixture.text('a.md')).toContain('count: 3');
			type(input, '5');
			await until(() => fixture.text('a.md')?.includes('count: 5') ?? false);
			expect(input?.value).toBe('5');
		} finally {
			await fixture.close();
		}
	});

	test('a failed checkbox edit reports the error and can be retried', async () => {
		const fixture = await setup({ 'a.md': '---\ndone: false\n---\n' });
		try {
			click(fixture.target, 'Tables');
			await until(() => fixture.target.querySelector('[aria-label="a.md: done"]') !== null);
			fixture.control.failPut.set('a.md', SaveError.StorageFailed({ cause: 'full' }).error!);
			const checkbox = fixture.target.querySelector('[aria-label="a.md: done"]');
			checkbox?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			await until(() => fixture.target.textContent?.includes('Change failed:') ?? false);
			expect(checkbox?.getAttribute('aria-checked')).toBe('false');
			expect(fixture.text('a.md')).toContain('done: false');
			fixture.control.failPut.delete('a.md');
			checkbox?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			await until(() => fixture.text('a.md')?.includes('done: true') ?? false);
		} finally {
			await fixture.close();
		}
	});

	test('a field draft keeps its value when update finds no file', async () => {
		const memory = memoryHost({});
		const owner = expectOk(await createFolder(memory.storage, { tables: {} }));
		const folder = svelteFolder(owner);
		const target = document.createElement('div');
		document.body.append(target);
		const app = mount(FieldCell, {
			target,
			props: {
				value: 'First',
				kind: 'string',
				label: 'missing.md: title',
				disabled: false,
				save: (value: unknown) => folder.update('missing.md', { fields: { title: value } }),
			},
		});
		try {
			const input = target.querySelector<HTMLInputElement>('[aria-label="missing.md: title"]');
			type(input, 'Changed');
			await until(() => target.textContent?.includes('Not saved:') ?? false);
			expect(input?.value).toBe('Changed');
			expect(memory.text('missing.md')).toBeUndefined();
		} finally {
			await unmount(app);
			await owner.close();
			target.remove();
		}
	});

});
