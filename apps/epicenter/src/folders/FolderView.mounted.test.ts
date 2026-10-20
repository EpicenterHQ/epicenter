/**
 * Folder Editor Mounted Tests
 *
 * Mounts the real folder editor, file tree, and file editor in jsdom inside
 * a folder context (`createFolderContext`), as `<FolderApp>` provides it, over
 * a real directory opened as a native folder, whose every put of a file's
 * bytes waits for the test to let it land or refuse it as a full disk would.
 *
 * Key behaviors:
 * - Choosing another file sends what was typed; a save that fails keeps it,
 *   the tree marks the file, and the header names it
 * - Choosing the file again shows the typing and why it did not save; Try
 *   again saves it, and the mark goes
 * - What is typed is the folder's own input: settling it, as hiding the
 *   window does, sends it and leaves the box editable; a failed save keeps the
 *   context failed and busy, so closing the window is held; closing the
 *   folder waits for a running save and answers what did not save
 *
 * Run with `--conditions=browser --conditions=svelte`, which mounting needs:
 * `bun test --conditions=browser --conditions=svelte FolderView.mounted`.
 * Under Bun's default conditions this file is skipped.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { type Folder, ReadError } from '@epicenter/folder';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { ViewUpdater } from './views.svelte';

const browser = Bun.resolveSync('svelte', import.meta.dir).endsWith(
	'index-client.js',
);

describe.skipIf(!browser)('folder editor', async () => {
	if (!browser) return;
	const { blur, click, type } = await import(
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
	const { dirname, join } = await import('node:path');
	const { createNativeFolder } = await import(
		'../../../../packages/folder/src/native/engine'
	);
	const { nativeStorage } = await import(
		'../../../../packages/folder/src/native/storage'
	);
	const { FileError } = await import('../../../../packages/folder/src/errors');

	type Saved = Result<void, Error>;

	const made: string[] = [];
	afterEach(async () => {
		for (const directory of made.splice(0))
			await rm(directory, { recursive: true, force: true });
	});

	/** Wait until `check` holds, letting saves, reads, and effects run. */
	async function until(check: () => boolean, what: string) {
		for (let tries = 0; tries < 400; tries++) {
			flushSync();
			if (check()) return;
			await Bun.sleep(5);
		}
		throw new Error(`Timed out waiting for ${what}`);
	}

	const press = (element: Element | null) => {
		if (element === null) throw new Error('Nothing to press');
		element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	};

	async function choose(trigger: Element | null, label: string) {
		if (!trigger) throw new Error('Missing select trigger');
		trigger.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
		);
		await until(
			() =>
				[...document.querySelectorAll('[role="option"]')].some(
					(option) => option.textContent?.trim() === label,
				),
			`option ${label}`,
		);
		[...document.querySelectorAll('[role="option"]')]
			.find((option) => option.textContent?.trim() === label)!
			.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
		flushSync();
	}

	/**
	 * A directory holding `files`, opened as a native folder whose every put
	 * waits for the test to answer it, and whose listing can be made to fail.
	 */
	async function standIn(files: Record<string, string>) {
		const parent = await realpath(
			await mkdtemp(join(tmpdir(), 'folder-editor-')),
		);
		made.push(parent);
		const root = join(parent, 'folder');
		await mkdir(root);
		/** Write `text` at `path` as another program would. */
		async function put(path: string, text: string) {
			await mkdir(dirname(join(root, path)), { recursive: true });
			await writeFile(join(root, path), text);
		}
		for (const [path, text] of Object.entries(files)) await put(path, text);
		const held: {
			path: string;
			content: string;
			answer: (result: Saved) => void;
		}[] = [];
		const listing = { failure: undefined as Error | undefined };
		const reading = new Set<string>();
		const storage = nativeStorage(root);
		const folder = createNativeFolder({
			storage: {
				...storage,
				async list() {
					if (listing.failure !== undefined)
						return FileError.Io({
							path: '',
							operation: 'list',
							cause: listing.failure,
						});
					return storage.list();
				},
				async put(path, bytes, ifMatch) {
					const answer = await new Promise<Saved>((resolve) =>
						held.push({
							path,
							content: bytes === null ? '' : new TextDecoder().decode(bytes),
							answer: resolve,
						}),
					);
					if (answer.error !== null)
						return FileError.Io({
							path,
							operation: 'write',
							cause: answer.error,
						});
					return storage.put(path, bytes, ifMatch);
				},
			},
			tables: {},
			directory: `bun:${root}`,
		}) as Folder<Record<never, never>>;
		// Fail only display reads. Persistence still reads the real directory.
		const read = folder.files.read;
		folder.files.read = async (path) =>
			reading.has(path)
				? ReadError.StorageFailed({
						cause: new Error('Source temporarily unreadable'),
					})
				: read(path);
		return {
			folder,
			held,
			listing,
			reading,
			put,
			remove: (path: string) => rm(join(root, path)),
			text: (path: string) =>
				readFile(join(root, path), 'utf8').catch(() => undefined),
		};
	}

	/** The editor window's page over `folder`, and its context. */
	function openEditor(
		folder: Folder<Record<never, never>>,
		updateView?: ViewUpdater,
	) {
		const context = createFolderContext(folder);
		const target = document.createElement('div');
		document.body.append(target);
		const view = mount(FolderViewHost, {
			target,
			props: { context, updateView },
		});
		let mounted = true;
		return {
			context,
			target,
			file: (path: string) =>
				target.querySelector(`nav button[title="${path}"]`),
			box: () => target.querySelector('textarea'),
			header: () =>
				target.querySelector('header [role="status"]')?.textContent?.trim(),
			/** Unmount the page, as the window going does; again does nothing. */
			async close() {
				if (!mounted) return;
				mounted = false;
				await unmount(view);
				target.remove();
			},
		};
	}

	/** Close the context, refusing every save still held until it is done. */
	async function closeRefusing(
		page: ReturnType<typeof openEditor>,
		disk: Awaited<ReturnType<typeof standIn>>,
	) {
		await page.close();
		let closed = false;
		const closing = page.context.close().then(() => {
			closed = true;
		});
		await until(() => {
			disk.held.shift()?.answer(Err(new Error('disk full')));
			return closed;
		}, 'pending saves');
		await closing;
	}

	test('saved Files text stays mounted and editable after its reread fails', async () => {
		const stored = { 'a.md': 'alpha\n' };
		const disk = await standIn(stored);
		const page = openEditor(disk.folder);
		try {
			await until(() => page.file('a.md') !== null, 'the file');
			press(page.file('a.md'));
			await until(() => page.box()?.value === 'alpha\n', 'the source');
			const original = page.box()!;
			original.focus();
			type(original, 'alpha\nmine\n');
			blur(original);
			await until(() => disk.held.length === 1, 'the save');
			disk.reading.add('a.md');
			disk.held.shift()!.answer(Ok(undefined));
			await until(
				() =>
					page.target.textContent?.includes('Source temporarily unreadable') ===
					true,
				'the failed reread',
			);
			expect(page.box()).toBe(original);
			expect(original.value).toBe('alpha\nmine\n');
			type(original, 'alpha\nmine\nlater\n');
			blur(original);
			await until(() => disk.held.length === 1, 'continued typing');
			expect(disk.held[0]?.content).toBe('alpha\nmine\nlater\n');
			disk.held.shift()!.answer(Ok(undefined));
			await until(
				() => page.context.getStatus().unsaved.length === 0,
				'the later save',
			);
			expect(await disk.text('a.md')).toBe('alpha\nmine\nlater\n');
		} finally {
			await page.close();
			await page.context.close();
		}
	});

	test('retained saved text is read-only after the file disappears', async () => {
		const stored: Record<string, string> = { 'a.md': 'alpha\n' };
		const disk = await standIn(stored);
		const page = openEditor(disk.folder);
		try {
			await until(() => page.file('a.md') !== null, 'the file');
			press(page.file('a.md'));
			await until(() => page.box()?.value === 'alpha\n', 'the source');
			type(page.box(), 'alpha\nmine\n');
			blur(page.box());
			await until(() => disk.held.length === 1, 'the save');
			disk.held.shift()!.answer(Ok(undefined));
			await until(
				() => page.context.getStatus().unsaved.length === 0,
				'saved input',
			);
			await disk.remove('a.md');
			await page.context.refresh(['a.md']);
			await until(
				() =>
					page.target.textContent?.includes('deleted elsewhere') === true ||
					page.target.textContent?.includes('no longer exists') === true,
				'the missing source',
			);
			expect(page.box()).not.toBeNull();
			expect(page.box()!.readOnly).toBe(true);
			expect(page.box()!.value).toBe('alpha\nmine\n');
			expect(page.target.textContent).not.toContain(
				'Saving puts your text back',
			);
		} finally {
			await page.close();
			await page.context.close();
		}
	});

	test('a pending CRLF edit keeps its line endings after an LF source refresh', async () => {
		const stored = { 'a.md': 'alpha\r\n' };
		const disk = await standIn(stored);
		const page = openEditor(disk.folder);
		try {
			await until(() => page.file('a.md') !== null, 'the file');
			press(page.file('a.md'));
			await until(() => page.box()?.value === 'alpha\n', 'the CRLF source');
			type(page.box(), 'alpha\nmine\n');
			await disk.put('a.md', 'alpha\nexternal\n');
			await page.context.refresh(['a.md']);
			type(page.box(), 'alpha\nmine\nlast\n');
			expect(disk.folder.files.edit('a.md').pending).toMatchObject({
				kind: 'text',
				text: 'alpha\r\nmine\r\nlast\r\n',
			});
		} finally {
			await page.close();
			let closed = false;
			const closing = page.context.close().then(() => {
				closed = true;
			});
			await until(() => {
				disk.held.shift()?.answer(Err(new Error('disk full')));
				return closed;
			}, 'pending CRLF cleanup');
			await closing;
		}
	});

	test('a save that fails as another file is chosen keeps the typing for the file', async () => {
		const disk = await standIn({ 'a.md': 'alpha\n', 'b.md': 'beta\n' });
		const { held } = disk;
		const page = openEditor(disk.folder);
		const { file, box, header, target } = page;
		try {
			await until(() => file('a.md') !== null, 'the tree');
			press(file('a.md'));
			await until(() => box()?.value === 'alpha\n', 'a.md read');
			type(box(), 'alpha\nmine\n');
			await until(
				() => file('a.md')?.textContent?.includes('(not saved yet)') === true,
				'the mark',
			);

			// Choosing another file sends what was typed, which fails.
			press(file('b.md'));
			await until(() => held.length === 1, 'the save');
			expect(held[0]!.path).toBe('a.md');
			await until(() => box()?.value === 'beta\n', 'b.md read');
			held.shift()!.answer(Err(new Error('disk full')));
			await until(() => header() === 'Not saved: a.md', 'the header');
			expect(file('a.md')?.textContent).toContain('(not saved yet)');
			expect(file('b.md')?.textContent).not.toContain('(not saved yet)');

			// Choosing it again shows the typing and why it did not save.
			press(file('a.md'));
			await until(() => box()?.value === 'alpha\nmine\n', 'the typing');
			expect(target.textContent).toContain('Your edit was not saved');

			const retry = [...target.querySelectorAll('button')].find(
				(button) => button.textContent?.trim() === 'Try again',
			);
			press(retry ?? null);
			await until(() => held.length === 1, 'the retry');
			expect(held[0]!.content).toBe('alpha\nmine\n');
			held.shift()!.answer(Ok(undefined));
			await until(
				() => !file('a.md')?.textContent?.includes('(not saved yet)'),
				'the mark to go',
			);
			expect(box()?.value).toBe('alpha\nmine\n');
			expect(target.textContent).not.toContain('Your edit was not saved');
			expect(await disk.text('a.md')).toBe('alpha\nmine\n');
			await until(() => page.context.getSaveState() === 'saved', 'saved');
			await until(
				() => target.querySelector('output')?.textContent === 'saved',
				'reactive save completion',
			);
		} finally {
			await closeRefusing(page, disk);
		}
	});

	test('held input settles when the window hides, stays editable, and holds a failed save', async () => {
		const disk = await standIn({ 'a.md': 'alpha\n' });
		const { held } = disk;
		const page = openEditor(disk.folder);
		const { context, file, box } = page;
		try {
			await until(() => file('a.md') !== null, 'the tree');
			press(file('a.md'));
			await until(() => box()?.value === 'alpha\n', 'a.md read');
			type(box(), 'alpha\nhidden\n');
			expect(context.busy).toBe(true);

			// Hidden: what is typed is sent at once, and settling waits for it.
			let settled: boolean | undefined;
			const settling = context.settled().then((done) => {
				settled = done;
			});
			await until(() => held.length === 1, 'the save on hide');
			expect(settled).toBeUndefined();
			held.shift()!.answer(Ok(undefined));
			await settling;
			expect(settled).toBe(true);
			expect(context.busy).toBe(false);

			// Shown again, typing goes on in the same box and saves.
			expect(box()?.readOnly).toBe(false);
			type(box(), 'alpha\nhidden\nshown\n');
			blur(box());
			await until(() => held.length === 1, 'the save after typing');
			expect(held[0]!.content).toBe('alpha\nhidden\nshown\n');

			// That save fails: the text stays, and the window's close is held.
			held.shift()!.answer(Err(new Error('disk full')));
			await until(() => context.getSaveState() === 'failed', 'the failure');
			expect(context.busy).toBe(true);
			// Settling retains failure; Try again explicitly sends it once.
			expect(await context.settled()).toBe(false);
			expect(held).toHaveLength(0);
			click(page.target, 'Try again');
			const retried = context.settled();
			await until(() => held.length === 1, 'the explicit retry');
			held.shift()!.answer(Err(new Error('disk full')));
			expect(await retried).toBe(false);
			expect(box()?.value).toBe('alpha\nhidden\nshown\n');
			expect(box()?.readOnly).toBe(false);

			// Closing the folder waits for a running save and answers it unsaved.
			type(box(), 'alpha\nhidden\nshown\nlast\n');
			let closed = false;
			await page.close();
			const closing = context.close().then((unsaved) => {
				closed = true;
				return unsaved;
			});
			await until(() => held.length === 1, 'the save on close');
			expect(closed).toBe(false);
			// Every attempt is refused, and the close goes on only after the last.
			await until(() => {
				held.shift()?.answer(Err(new Error('disk full')));
				return closed;
			}, 'the close');
			const unsaved = await closing;
			expect(unsaved.map((draft) => [draft.path, draft.unsaved])).toEqual([
				['a.md', 'alpha\nhidden\nshown\nlast\n'],
			]);
			expect(await disk.text('a.md')).toBe('alpha\nhidden\n');
		} finally {
			await page.close();
		}
	});

	test('a directory change refreshes its opened descendant file', async () => {
		const disk = await standIn({ 'notes/a.md': 'before\n' });
		const page = openEditor(disk.folder);
		try {
			await until(() => page.file('notes/a.md') !== null, 'the tree');
			press(page.file('notes/a.md'));
			await until(() => page.box()?.value === 'before\n', 'the file');
			await disk.put('notes/a.md', 'after replacing the directory\n');
			await page.context.refresh(['notes']);
			await until(
				() => page.box()?.value === 'after replacing the directory\n',
				'the descendant refresh',
			);
		} finally {
			await closeRefusing(page, disk);
		}
	});

	test.each(['deleted', 'unreadable'] as const)(
		'failed input stays reachable when its disk entry is %s',
		async (failure) => {
			const disk = await standIn({ 'a.md': 'alpha\n', 'b.md': 'beta\n' });
			const page = openEditor(disk.folder);
			try {
				await until(() => page.file('a.md') !== null, 'the tree');
				press(page.file('a.md'));
				await until(() => page.box()?.value === 'alpha\n', 'a.md');
				type(page.box(), 'my retained text\n');
				press(page.file('b.md'));
				await until(() => disk.held.length === 1, 'the save');
				disk.held.shift()!.answer(Err(new Error('disk full')));
				await until(() => page.context.getSaveState() === 'failed', 'the failure');
				if (failure === 'deleted') {
					await disk.remove('a.md');
					await page.context.refresh(['a.md']);
				} else {
					disk.listing.failure = new Error('folder unreadable');
					await page.context.refresh();
				}
				await until(
					() =>
						page.target.querySelector('[aria-label="Unsaved files"]') !== null,
					'reachable unsaved files',
				);
				press(page.file('a.md'));
				await until(
					() => page.box()?.value === 'my retained text\n',
					'the retained text',
				);
				const discard = [...page.target.querySelectorAll('button')].find(
					(button) => button.textContent?.trim() === 'Discard edit',
				);
				press(discard ?? null);
				await until(() => !page.context.busy, 'discard completion');
			} finally {
				await closeRefusing(page, disk);
			}
		},
	);

	test('a declared missing field can be edited in Tables and the same failed input stays visible in Files', async () => {
		const disk = await standIn({
			'todos/a.md': 'body\n',
			'epicenter.json': JSON.stringify({
				tables: {
					todos: {
						type: 'object',
						properties: { title: { type: 'string' } },
						required: ['title'],
					},
				},
			}),
		});
		const page = openEditor(disk.folder);
		const button = (name: string) =>
			[...page.target.querySelectorAll('button')].find(
				(node) => node.textContent?.trim() === name,
			) ?? null;
		try {
			press(button('Tables'));
			await until(
				() =>
					page.target.querySelector('input[aria-label="todos/a.md: title"]') !==
					null,
				'the declared repair cell',
			);
			const cell = page.target.querySelector(
				'input[aria-label="todos/a.md: title"]',
			) as HTMLInputElement;
			type(cell, 'mine');
			blur(cell);
			await until(() => disk.held.length === 1, 'the field save');
			disk.held.shift()!.answer(Err(new Error('disk full')));
			await until(
				() => page.target.textContent?.includes('disk full') === true,
				'the held error',
			);
			press(button('Files'));
			await until(() => page.file('todos/a.md') !== null, 'the Files view');
			press(page.file('todos/a.md'));
			await until(
				() => page.box()?.value.includes('title: mine') === true,
				'the shared input',
			);
			expect(page.box()?.readOnly).toBe(true);
			press(button('SQL'));
			await until(
				() =>
					page.target.querySelector('textarea[aria-label="SQL statement"]') !==
					null,
				'SQL input',
			);
			const sql = page.target.querySelector(
				'textarea[aria-label="SQL statement"]',
			) as HTMLTextAreaElement;
			type(sql, 'SELECT body FROM documents');
			press(button('SQL'));
			press(button('Files'));
			press(button('SQL'));
			expect(
				(
					page.target.querySelector(
						'textarea[aria-label="SQL statement"]',
					) as HTMLTextAreaElement
				).value,
			).toBe('SELECT body FROM documents');
			press(button('Files'));
			await until(() => button('Discard edit') !== null, 'the shared failure');
			press(button('Discard edit'));
			await until(() => !page.context.busy, 'discard');
			expect(await disk.text('todos/a.md')).toBe('body\n');
		} finally {
			await closeRefusing(page, disk);
		}
	});

	test('browsing writes nothing; the first explicit SQL view save creates only views', async () => {
		const disk = await standIn({});
		const { changeSavedView } = await import(
			'../../../../packages/folder/src/declaration-write'
		);
		const { hashBytes } = await import('../../../../packages/folder/src/hash');
		let writes = 0;
		const updateView: ViewUpdater = (change) =>
			changeSavedView(
				{
					read: async (path) => {
						const text = await disk.text(path);
						if (text === undefined) return FileError.NotFound({ path });
						const bytes = new TextEncoder().encode(text);
						return Ok({ bytes, sha256: await hashBytes(bytes) });
					},
					put: async (path, bytes, base) => {
						const text = await disk.text(path);
						const hash =
							text === undefined
								? null
								: await hashBytes(new TextEncoder().encode(text));
						if (hash !== base) return Ok('stale');
						writes++;
						await disk.put(path, new TextDecoder().decode(bytes!));
						return Ok('landed');
					},
				},
				change,
			);
		const page = openEditor(disk.folder, updateView);
		const button = (text: string) =>
			[...page.target.querySelectorAll('button')].find(
				(entry) => entry.textContent?.trim() === text,
			) ?? null;
		try {
			await until(() => button('SQL') !== null, 'navigation');
			press(button('SQL'));
			await until(
				() =>
					page.target.querySelector('textarea[aria-label="SQL statement"]') !==
					null,
				'SQL',
			);
			type(
				page.target.querySelector('textarea[aria-label="SQL statement"]'),
				'SELECT path FROM documents',
			);
			expect(writes).toBe(0);
			expect(await disk.text('epicenter.json')).toBeUndefined();
			press(button('Save view'));
			await until(
				() =>
					writes === 1 &&
					page.target.querySelector('[aria-label="Saved views"]') !== null,
				'saved recipe',
			);
			const declaration = JSON.parse((await disk.text('epicenter.json'))!);
			expect(Object.keys(declaration)).toEqual(['views']);
			expect(Object.values(declaration.views)).toEqual([
				{ type: 'sql', title: 'SQL', sql: 'SELECT path FROM documents' },
			]);
		} finally {
			await closeRefusing(page, disk);
		}
	});

	test('a board move keeps the failed destination patch and exposes the same source recovery', async () => {
		const disk = await standIn({
			'epicenter.json': JSON.stringify({
				tables: {
					tasks: {
						type: 'object',
						properties: { status: { enum: ['todo', 'done'] } },
					},
				},
			}),
			'tasks/a.md': '---\nstatus: todo\n---\nBody\n',
		});
		const page = openEditor(disk.folder);
		const button = (text: string) =>
			[...page.target.querySelectorAll('button')].find(
				(entry) => entry.textContent?.trim() === text,
			) ?? null;
		try {
			await until(() => button('Tables') !== null, 'navigation');
			press(button('Tables'));
			await until(
				() =>
					page.target.querySelector(
						'input[aria-label="tasks/a.md: status"]',
					) !== null,
				'grid',
			);
			await choose(page.target.querySelector('#table-directory'), 'tasks');
			press(button('Board'));
			await until(
				() =>
					page.target.querySelector('[aria-label="Move tasks/a.md"]') !== null,
				'board card',
			);
			page.target
				.querySelector('[aria-label="Move tasks/a.md"]')!
				.dispatchEvent(
					new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
				);
			await until(
				() =>
					[...document.querySelectorAll('[role="option"]')].some(
						(option) => option.textContent?.trim() === 'done',
					),
				'move destinations',
			);
			[...document.querySelectorAll('[role="option"]')]
				.find((option) => option.textContent?.trim() === 'done')!
				.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
			await until(() => disk.held.length === 1, 'move save');
			expect(disk.held[0]?.content).toContain('status: done');
			disk.held.shift()!.answer(Err(new Error('disk full')));
			await until(
				() => page.target.textContent?.includes('disk full') === true,
				'failed move',
			);
			expect(page.target.querySelector('article')?.textContent).toContain(
				'done',
			);
			press(button('Files'));
			await until(() => page.file('tasks/a.md') !== null, 'files');
			press(page.file('tasks/a.md'));
			await until(
				() => page.box()?.value.includes('status: done') === true,
				'shared destination',
			);
			expect(page.box()?.readOnly).toBe(true);
			press(button('Discard edit'));
		} finally {
			await closeRefusing(page, disk);
		}
	});

	test('Board to Grid saves its own variant and changing a filter to Present clears the old operand', async () => {
		const disk = await standIn({
			'epicenter.json': JSON.stringify({
				views: {
					board: {
						type: 'board',
						title: 'Saved board',
						table: 'tasks',
						groupBy: 'status',
					},
				},
			}),
			'tasks/a.md': '---\nstatus: todo\n---\nBody\n',
		});
		let sent: import('@epicenter/folder/declaration').SavedView | undefined;
		const page = openEditor(disk.folder, async (change) => {
			sent = change.value;
			await disk.put(
				'epicenter.json',
				JSON.stringify({ views: { board: change.value } }),
			);
			return Ok({ written: true });
		});
		const button = (text: string) =>
			[...page.target.querySelectorAll('button')].find(
				(entry) => entry.textContent?.trim() === text,
			) ?? null;
		try {
			await until(
				() => page.target.querySelector('[aria-label="Saved views"]') !== null,
				'saved chooser',
			);
			await choose(
				page.target.querySelector('[aria-label="Saved views"]'),
				'Saved board (board)',
			);
			await until(() => button('Grid') !== null, 'board');
			press(button('Grid'));
			await until(
				() =>
					page.target.querySelector(
						'input[aria-label="tasks/a.md: status"]',
					) !== null,
				'grid',
			);
			press(page.target.querySelector('summary'));
			press(button('Add filter'));
			await until(
				() =>
					page.target.querySelector('[aria-label="Filter comparison 1"]') !==
					null,
				'filter',
			);
			await choose(
				page.target.querySelector('[aria-label="Filter comparison 1"]'),
				'equals',
			);
			await choose(
				page.target.querySelector('[aria-label="Filter value type 1"]'),
				'string',
			);
			type(page.target.querySelector('[aria-label="Filter value 1"]'), 'todo');
			await choose(
				page.target.querySelector('[aria-label="Filter comparison 1"]'),
				'has a value',
			);
			expect(page.target.textContent).not.toContain('exists expects');
			press(button('Save view'));
			await until(() => sent !== undefined, 'publication');
			expect(sent?.type).toBe('grid');
			expect(Object.hasOwn(sent!, 'groupBy')).toBe(false);
			expect(sent).toMatchObject({
				filters: [{ field: 'status', operator: 'exists', value: true }],
			});
		} finally {
			await closeRefusing(page, disk);
		}
	});

	test('table-view Save waits for a top-level directory and explains the choice', async () => {
		const disk = await standIn({
			'root.md': '---\ntitle: Root\n---\nBody\n',
			'notes/a.md': '---\ntitle: A\n---\nBody\n',
			'notes/deep/b.md': '---\ntitle: B\n---\nBody\n',
		});
		const page = openEditor(disk.folder);
		const button = (label: string) =>
			[...page.target.querySelectorAll('button')].find(
				(entry) => entry.textContent?.trim() === label,
			) ?? null;
		try {
			await until(() => button('Tables') !== null, 'navigation');
			press(button('Tables'));
			await until(
				() =>
					page.target.querySelector('input[aria-label="notes/a.md: title"]') !==
					null,
				'documents',
			);
			expect(button('Save view')?.disabled).toBe(true);
			expect(button('Save as new')?.disabled).toBe(true);
			expect(page.target.textContent).toContain('Choose a top-level directory');
			await choose(page.target.querySelector('#table-directory'), 'notes');
			expect(button('Save view')?.disabled).toBe(false);
			expect(button('Save as new')?.disabled).toBe(false);
			await choose(page.target.querySelector('#table-directory'), 'notes/deep');
			expect(button('Save view')?.disabled).toBe(true);
			await choose(
				page.target.querySelector('#table-directory'),
				'Folder root',
			);
			expect(button('Save view')?.disabled).toBe(true);
		} finally {
			await closeRefusing(page, disk);
		}
	});

	test('a failed background table read keeps the focused cell and its input mounted', async () => {
		const disk = await standIn({ 'todos/a.md': '---\ntitle: A\n---\n' });
		const page = openEditor(disk.folder);
		try {
			await until(
				() =>
					[...page.target.querySelectorAll('button')].some(
						(button) => button.textContent?.trim() === 'Tables',
					),
				'navigation',
			);
			press(
				[...page.target.querySelectorAll('button')].find(
					(button) => button.textContent?.trim() === 'Tables',
				)!,
			);
			const cell = () =>
				page.target.querySelector<HTMLInputElement>(
					'input[aria-label="todos/a.md: title"]',
				);
			await until(() => cell() !== null, 'the table cell');
			const original = cell()!;
			original.focus();
			type(original, 'Typed here');
			flushSync();
			disk.listing.failure = new Error('Folder temporarily unreadable');
			await page.context.refresh();
			flushSync();
			expect(cell()).toBe(original);
			expect(document.activeElement).toBe(original);
			expect(original.value).toBe('Typed here');
			expect(page.target.textContent).toContain(
				'Folder temporarily unreadable',
			);
		} finally {
			await closeRefusing(page, disk);
		}
	});
});
