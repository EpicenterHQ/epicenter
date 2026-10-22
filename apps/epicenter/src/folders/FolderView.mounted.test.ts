/**
 * Folder Editor Mounted Tests
 *
 * Mounts the real folder editor, file tree, and file editor in jsdom inside
 * a folder context (`createFolderContext`), as `<FolderApp>` provides it, over
 * a real directory opened as a native folder, whose every put of a file's
 * bytes waits for the test to let it land or refuse it as a full disk would.
 *
 * Key behaviors:
 * - Autosave continues after choosing another file; a save that fails keeps input,
 *   the tree marks the file, and the header names it
 * - Choosing the file again shows the typing and why it did not save; Try
 *   again saves it, and the mark goes
 * - What is typed is the folder's own input: settling it, as hiding the
 *   window does, sends it and leaves the box editable; a failed save keeps the
 *   context failed with pending input; closing the folder waits for a running
 *   save and answers what did not save
 * - A failed Board move stays visible in Grid and Files, retries from Files,
 *   publishes retained input over an outside edit, and survives reopening the folder
 * - Mixed line endings and binary bytes stay untouched; textarea saves keep
 *   BOM and CRLF, and a stale read cannot hide a newer repair
 * - Deleted files retain editable text without automatically publishing it
 *
 * Run with `--conditions=browser --conditions=svelte`, which mounting needs:
 * `bun test --conditions=browser --conditions=svelte FolderView.mounted`.
 * Under Bun's default conditions this file is skipped.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { Folder } from '@epicenter/folder';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';

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
	async function standIn(files: Record<string, string | Uint8Array>) {
		const parent = await realpath(
			await mkdtemp(join(tmpdir(), 'folder-editor-')),
		);
		made.push(parent);
		const root = join(parent, 'folder');
		await mkdir(root);
		/** Write `text` at `path` as another program would. */
		async function put(path: string, text: string | Uint8Array) {
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
				read(path) {
					return reading.has(path)
						? Promise.resolve(
								FileError.Io({
									path,
									operation: 'read',
									cause: new Error('Source temporarily unreadable'),
								}),
							)
						: storage.read(path);
				},
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
		return {
			root,
			folder,
			storage,
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
	function openEditor(folder: Folder<Record<never, never>>) {
		const context = createFolderContext(folder);
		const target = document.createElement('div');
		document.body.append(target);
		const view = mount(FolderViewHost, {
			target,
			props: { context },
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

	/** Release the context, then resolve admitted test writes so none stay blocked. */
	async function closeRefusing(
		page: ReturnType<typeof openEditor>,
		disk: Awaited<ReturnType<typeof standIn>>,
	) {
		await page.close();
		page.context.close();
		await until(() => {
			disk.held.shift()?.answer(Err(new Error('disk full')));
			return !disk.folder.getStatus().saving;
		}, 'pending saves');
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
			disk.held.shift()!.answer(Ok(undefined));
			await until(
				() => page.context.getStatus().unsaved.length === 0,
				'the saved text',
			);
			disk.reading.add('a.md');
			await page.context.refresh(['a.md']);
			await until(
				() =>
					page.target.textContent?.includes('Source temporarily unreadable') ===
					true,
				'the failed reread',
			);
			expect(page.box()).toBe(original);
			expect(original.value).toBe('alpha\nmine\n');
			disk.reading.delete('a.md');
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
			page.context.close();
		}
	});

	test.each(['missing', 'not-text'] as const)(
		'retained saved text stays editable after %s storage observation',
		async (replacement) => {
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
				if (replacement === 'missing') await disk.remove('a.md');
				else await disk.put('a.md', new Uint8Array([0xff, 0xfe]));
				await page.context.refresh(['a.md']);
				await until(
					() =>
						disk.folder.files.document('a.md').getSnapshot().loadError?.name ===
						(replacement === 'missing' ? 'Missing' : 'NotText'),
					'the missing source',
				);
				expect(page.box()).not.toBeNull();
				expect(page.box()!.readOnly).toBe(false);
				expect(page.box()!.value).toBe('alpha\nmine\n');
				expect(page.box()!.disabled).toBe(false);
				page.box()!.select();
				expect(
					page
						.box()!
						.value.slice(page.box()!.selectionStart, page.box()!.selectionEnd),
				).toBe('alpha\nmine\n');
				blur(page.box());
				expect(disk.folder.files.document('a.md').getSnapshot().isDirty).toBe(
					false,
				);
				expect(disk.held).toHaveLength(0);
				// An observation retains text without admitting a publication.
				type(page.box(), 'alpha\nmine\nlater\n');
				blur(page.box());
				await until(() => disk.held.length === 1, 'the later publication');
				expect(disk.held[0]?.content).toBe('alpha\nmine\nlater\n');
				disk.held.shift()!.answer(Ok(undefined));
				await until(
					() => !page.context.getStatus().saving,
					'publication completion',
				);
				expect(await disk.text('a.md')).toBe('alpha\nmine\nlater\n');
			} finally {
				await page.close();
				page.context.close();
			}
		},
	);

	test.each(['alpha\r\nbeta\n', 'alpha\rbeta', 'alpha\r\nbeta\r'])(
		'mixed line endings stay exact and copyable without a text box: %j',
		async (source) => {
			const disk = await standIn({ 'a.md': source });
			const page = openEditor(disk.folder);
			try {
				await until(() => page.file('a.md') !== null, 'the file');
				press(page.file('a.md'));
				await until(
					() => page.target.querySelector('pre')?.textContent === source,
					'the exact mixed text',
				);
				expect(page.box()).toBeNull();
				expect(page.target.textContent).toContain('mixes line endings');
				expect(await disk.text('a.md')).toBe(source);
				expect(disk.held).toHaveLength(0);
			} finally {
				await closeRefusing(page, disk);
			}
		},
	);

	test.each([new Uint8Array([0xff, 0xfe]), new TextEncoder().encode('a\0b')])(
		'nontext bytes stay untouched without opening a text box: %j',
		async (source) => {
			const disk = await standIn({ 'a.bin': source });
			const page = openEditor(disk.folder);
			try {
				await until(() => page.file('a.bin') !== null, 'the file');
				press(page.file('a.bin'));
				await until(
					() =>
						disk.folder.files.document('a.bin').getSnapshot().loadError
							?.name === 'NotText',
					'the binary notice',
				);
				expect(page.box()).toBeNull();
				expect(page.target.textContent).not.toContain('bytes)');
				expect(
					new Uint8Array(await readFile(join(disk.root, 'a.bin'))),
				).toEqual(source);
				expect(disk.held).toHaveLength(0);
			} finally {
				await closeRefusing(page, disk);
			}
		},
	);

	test('an older mixed-source read cannot hide a newer repaired document', async () => {
		const source = 'alpha\r\nbeta\n';
		const disk = await standIn({ 'a.md': source });
		const page = openEditor(disk.folder);
		const captured = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const read = disk.storage.read;
		try {
			await until(() => page.file('a.md') !== null, 'the file');
			press(page.file('a.md'));
			await until(
				() => page.target.querySelector('pre')?.textContent === source,
				'the mixed text',
			);
			let hold = true;
			disk.storage.read = async (path) => {
				const result = await read(path);
				if (path === 'a.md' && hold) {
					hold = false;
					captured.resolve();
					await release.promise;
				}
				return result;
			};
			const refreshing = page.context.refresh(['a.md']);
			await captured.promise;
			const saving = disk.folder.files.write('a.md', 'repaired\n');
			await until(() => disk.held.length === 1, 'the repair');
			disk.held.shift()!.answer(Ok(undefined));
			expectOk(await saving);
			await until(
				() => page.box()?.value === 'repaired\n',
				'the repair before the older read answers',
			);
			release.resolve();
			await refreshing;
			await until(
				() => page.box()?.value === 'repaired\n',
				'the repaired text',
			);
			expect(page.box()!.readOnly).toBe(false);
			expect(page.target.textContent).not.toContain('mixes line endings');
		} finally {
			release.resolve();
			disk.storage.read = read;
			await closeRefusing(page, disk);
		}
	});

	test('mixed-line-ending safety follows the displayed field patch without losing it', async () => {
		const disk = await standIn({
			'a.md': '---\r\ntitle: A\r\n---\r\nbody\r\n',
		});
		const page = openEditor(disk.folder);
		try {
			await until(() => page.file('a.md') !== null, 'the file');
			press(page.file('a.md'));
			await until(() => page.box() !== null, 'the source');
			const textEdit = disk.folder.files.document('a.md');
			expectOk(textEdit.patch({ fields: { title: 'Typed' } }));
			await disk.put('a.md', '---\r\ntitle: A\n---\r\nbody\r\n');
			await page.context.refresh(['a.md']);
			await until(
				() => page.box()?.value === '---\ntitle: Typed\n---\nbody\n',
				'the pinned draft text',
			);
			expect(page.box()!.readOnly).toBe(false);

			await disk.put('a.md', '---\r\ntitle: A\r\n---\r\nbody\nnext\r\n');
			await page.context.refresh(['a.md']);
			expect(page.box()?.value).toBe('---\ntitle: Typed\n---\nbody\n');
			expect(page.box()?.readOnly).toBe(false);
			expect(textEdit.getSnapshot().content?.text).toBe(
				'---\r\ntitle: Typed\r\n---\r\nbody\r\n',
			);
		} finally {
			await closeRefusing(page, disk);
		}
	});

	test('saving textarea input preserves the file BOM and CRLF line endings', async () => {
		const disk = await standIn({ 'a.md': '\uFEFFalpha\r\n' });
		const page = openEditor(disk.folder);
		try {
			await until(() => page.file('a.md') !== null, 'the file');
			press(page.file('a.md'));
			await until(
				() => page.box()?.value === '\uFEFFalpha\n',
				'the CRLF source',
			);
			type(page.box(), '\uFEFFalpha\nmine\n');
			blur(page.box());
			await until(() => disk.held.length === 1, 'the save');
			disk.held.shift()!.answer(Ok(undefined));
			await until(
				() => page.context.getStatus().unsaved.length === 0,
				'the saved input',
			);
			expect(await disk.text('a.md')).toBe('\uFEFFalpha\r\nmine\r\n');
		} finally {
			await closeRefusing(page, disk);
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
			expect(
				disk.folder.files.document('a.md').getSnapshot().content?.text,
			).toBe('alpha\r\nmine\r\nlast\r\n');
		} finally {
			await page.close();
			page.context.close();
			await until(() => {
				disk.held.shift()?.answer(Err(new Error('disk full')));
				return !disk.folder.getStatus().saving;
			}, 'pending CRLF cleanup');
		}
	});

	test('a save that fails as another file is chosen keeps the typing for the file', async () => {
		const disk = await standIn({ 'a.md': 'alpha\n', 'b.md': 'beta\n' });
		const { held } = disk;
		const page = openEditor(disk.folder);
		const { file, box, header, target } = page;
		const unsavedOutput = () =>
			target.querySelector('output[aria-label="Unsaved paths"]');
		try {
			await until(() => file('a.md') !== null, 'the tree');
			press(file('a.md'));
			await until(() => box()?.value === 'alpha\n', 'a.md read');
			type(box(), 'alpha\nmine\n');
			await until(
				() => file('a.md')?.textContent?.includes('(not saved yet)') === true,
				'the mark',
			);

			// Autosave continues after choosing another file, then fails.
			press(file('b.md'));
			await until(() => held.length === 1, 'the save');
			expect(held[0]!.path).toBe('a.md');
			await until(() => box()?.value === 'beta\n', 'b.md read');
			held.shift()!.answer(Err(new Error('disk full')));
			await until(() => header() === 'Not saved: a.md', 'the header');
			expect(unsavedOutput()?.textContent).toBe('a.md');
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
			await until(
				() =>
					!page.context.getStatus().saving &&
					page.context.getStatus().unsaved.length === 0,
				'saved',
			);
			await until(
				() => unsavedOutput()?.textContent === '',
				'reactive save completion',
			);
		} finally {
			await closeRefusing(page, disk);
		}
	});

	test('flush submits held input without waiting and retains failed input while open', async () => {
		const disk = await standIn({ 'a.md': 'alpha\n' });
		const { held } = disk;
		const page = openEditor(disk.folder);
		const { context, file, box } = page;
		try {
			await until(() => file('a.md') !== null, 'the tree');
			press(file('a.md'));
			await until(() => box()?.value === 'alpha\n', 'a.md read');
			type(box(), 'alpha\nhidden\n');
			expect(
				context.getStatus().saving || context.getStatus().unsaved.length > 0,
			).toBe(true);

			// Hidden: what is typed is submitted now, without waiting.
			expect(context.folder.flush()).toBeUndefined();
			await until(() => held.length === 1, 'the save on hide');
			expect(context.getStatus().saving).toBe(true);
			held.shift()!.answer(Ok(undefined));
			await until(() => !context.getStatus().saving, 'publication completion');
			expect(context.getStatus().unsaved).toEqual([]);

			// Shown again, typing goes on in the same box and saves.
			expect(box()?.readOnly).toBe(false);
			type(box(), 'alpha\nhidden\nshown\n');
			blur(box());
			await until(() => held.length === 1, 'the save after typing');
			expect(held[0]!.content).toBe('alpha\nhidden\nshown\n');

			// That save fails: the text stays pending until retried or discarded.
			held.shift()!.answer(Err(new Error('disk full')));
			await until(() => context.getStatus().failures.length > 0, 'the failure');
			expect(
				context.getStatus().saving || context.getStatus().unsaved.length > 0,
			).toBe(true);
			// Flush attempts failed input again; status retains the new failure.
			expect(context.folder.flush()).toBeUndefined();
			await until(() => held.length === 1, 'the save on flush');
			held.shift()!.answer(Err(new Error('disk full')));
			await until(() => !context.getStatus().saving, 'failed publication');
			expect(context.getStatus().failures).toHaveLength(1);
			expect(held).toHaveLength(0);
			click(page.target, 'Try again');
			await until(() => held.length === 1, 'the explicit retry');
			held.shift()!.answer(Err(new Error('disk full')));
			await until(() => !context.getStatus().saving, 'failed retry');
			expect(context.getStatus().failures).toHaveLength(1);
			expect(box()?.value).toBe('alpha\nhidden\nshown\n');
			expect(box()?.readOnly).toBe(false);

			// Closing releases without submitting the last held input.
			type(box(), 'alpha\nhidden\nshown\nlast\n');
			await page.close();
			expect(context.close()).toBeUndefined();
			expect(held).toHaveLength(0);
			expect(
				disk.folder.files.document('a.md').getSnapshot().content?.text,
			).toBe('alpha\nhidden\nshown\nlast\n');
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
				await until(
					() => page.context.getStatus().failures.length > 0,
					'the failure',
				);
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
				await until(
					() =>
						!page.context.getStatus().saving &&
						page.context.getStatus().unsaved.length === 0,
					'discard completion',
				);
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
					page.target.querySelector<HTMLInputElement>(
						'input[aria-label="todos/a.md: title"]',
					)?.disabled === false,
				'the declared repair cell',
			);
			const cell = page.target.querySelector(
				'input[aria-label="todos/a.md: title"]',
			) as HTMLInputElement;
			type(cell, 'mine');
			expect(
				disk.folder.files.document('todos/a.md').getSnapshot().content?.fields
					?.title,
			).toBe('mine');
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
			expect(page.box()?.readOnly).toBe(false);
			type(
				page.box(),
				page.box()!.value.replace('body', 'source after failure'),
			);
			await until(
				() => disk.folder.files.document('todos/a.md').getSnapshot().isDirty,
				'source takeover',
			);
			expect(
				disk.folder.files.document('todos/a.md').getSnapshot().content?.text,
			).toContain('title: mine');
			expect(
				disk.folder.files.document('todos/a.md').getSnapshot().content?.text,
			).toContain('source after failure');
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
			await until(() => disk.held.length === 1, 'the save when leaving Files');
			disk.held.shift()!.answer(Err(new Error('disk full')));
			await until(() => button('Discard edit') !== null, 'the shared failure');
			press(button('Discard edit'));
			await until(
				() =>
					!page.context.getStatus().saving &&
					page.context.getStatus().unsaved.length === 0,
				'discard',
			);
			expect(await disk.text('todos/a.md')).toBe('body\n');
		} finally {
			await closeRefusing(page, disk);
		}
	});

	test('browsing writes nothing; the first explicit SQL view save creates only views', async () => {
		const disk = await standIn({});
		const page = openEditor(disk.folder);
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
			expect(disk.held).toHaveLength(0);
			expect(await disk.text('epicenter.json')).toBeUndefined();
			await until(
				() => button('Save view')?.disabled === false,
				'declaration availability',
			);
			press(button('Save view'));
			await until(() => disk.held.length === 1, 'the declaration publication');
			expect(disk.held[0]?.path).toBe('epicenter.json');
			disk.held.shift()!.answer(Ok(undefined));
			await until(
				() => !disk.folder.getStatus().saving,
				'publication completion',
			);
			await until(
				() => page.target.querySelector('[aria-label="Saved views"]') !== null,
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

	test('saving a recipe composes with unfinished epicenter.json source in the same edit', async () => {
		const disk = await standIn({ 'epicenter.json': '{}\n' });
		const page = openEditor(disk.folder);
		const button = (label: string) =>
			[...page.target.querySelectorAll('button')].find(
				(entry) => entry.textContent?.trim() === label,
			) ?? null;
		try {
			await until(
				() => page.file('epicenter.json') !== null,
				'the declaration',
			);
			press(page.file('epicenter.json'));
			await until(() => page.box() !== null, 'the source');
			type(
				page.box(),
				'{"title":"Typed raw title","future":{"keep":true},"views":{"later":{"type":"calendar"}}}',
			);
			press(button('SQL'));
			await until(
				() =>
					page.target.querySelector('[aria-label="SQL statement"]') !== null,
				'the SQL form',
			);
			type(
				page.target.querySelector('[aria-label="SQL statement"]'),
				'SELECT path FROM documents',
			);
			press(button('Save view'));
			await until(() => disk.held.length > 0, 'the composed publication');
			disk.folder.flush();
			await until(() => {
				disk.held.shift()?.answer(Ok(undefined));
				return !disk.folder.getStatus().saving;
			}, 'all declaration publications');
			const declaration = JSON.parse((await disk.text('epicenter.json'))!);
			expect(declaration.title).toBe('Typed raw title');
			expect(declaration.future).toEqual({ keep: true });
			expect(declaration.views.later).toEqual({ type: 'calendar' });
			expect(Object.values(declaration.views)).toContainEqual({
				type: 'sql',
				title: 'SQL',
				sql: 'SELECT path FROM documents',
			});
			expect(
				disk.folder.files.document('epicenter.json').getSnapshot().isDirty,
			).toBe(false);
		} finally {
			await closeRefusing(page, disk);
		}
	});

	test('a failed Board move retries its retained source from Files and survives reopening', async () => {
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
					page.target.querySelector<HTMLButtonElement>(
						'[aria-label="Move tasks/a.md"]',
					)?.disabled === false,
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
			expect(
				disk.folder.files.document('tasks/a.md').getSnapshot().content?.fields
					?.status,
			).toBe('done');
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
			press(button('Grid'));
			await until(
				() =>
					page.target.querySelector<HTMLInputElement>(
						'[aria-label="tasks/a.md: status"]',
					)?.value === 'done',
				'the held move in Grid',
			);
			await disk.put(
				'tasks/a.md',
				'---\nstatus: todo\nextra: kept\n---\nOutside body\n',
			);
			press(button('Files'));
			await until(() => page.file('tasks/a.md') !== null, 'files');
			press(page.file('tasks/a.md'));
			// The held move stays pinned while the outside source is read.
			await until(
				() =>
					page.box()?.value.includes('status: done') === true &&
					page.box()?.value.includes('Body') === true,
				'shared destination',
			);
			expect(page.box()?.readOnly).toBe(false);
			press(button('Try again'));
			await until(() => disk.held.length === 1, 'the retry publication');
			expect(disk.held[0]?.content).toContain('status: done');
			expect(disk.held[0]?.content).toContain('Body');
			expect(disk.held[0]?.content).not.toContain('extra: kept');
			disk.held.shift()!.answer(Ok(undefined));
			await until(
				() => !page.context.getStatus().saving,
				'publication completion',
			);
			expect(await disk.text('tasks/a.md')).toBe(
				'---\nstatus: done\n---\nBody\n',
			);
			expect(page.context.getStatus().unsaved).toEqual([]);

			await page.close();
			page.context.close();
			const { openFolder } = await import('@epicenter/folder/bun');
			const reopened = openEditor(
				expectOk(await openFolder({ directory: disk.root, tables: {} })),
			);
			try {
				press(
					[...reopened.target.querySelectorAll('button')].find(
						(node) => node.textContent?.trim() === 'Tables',
					) ?? null,
				);
				await until(
					() =>
						reopened.target.querySelector<HTMLInputElement>(
							'[aria-label="tasks/a.md: status"]',
						)?.value === 'done',
					'the saved move after reopening',
				);
			} finally {
				await reopened.close();
				reopened.context.close();
			}
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
		const page = openEditor(disk.folder);
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
			await until(() => disk.held.length === 1, 'publication');
			const sent = JSON.parse(disk.held[0]!.content).views.board;
			expect(sent.type).toBe('grid');
			expect(Object.hasOwn(sent, 'groupBy')).toBe(false);
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

	test('equal schemas retain the table edit and focused input across document refreshes', async () => {
		const disk = await standIn({
			'epicenter.json': JSON.stringify({
				tables: {
					notes: { type: 'object', properties: { title: { type: 'string' } } },
				},
			}),
			'notes/a.md': '---\ntitle: A\n---\n',
		});
		const page = openEditor(disk.folder);
		try {
			await until(
				() =>
					[...page.target.querySelectorAll('button')].some(
						(entry) => entry.textContent?.trim() === 'Tables',
					),
				'navigation',
			);
			press(
				[...page.target.querySelectorAll('button')].find(
					(entry) => entry.textContent?.trim() === 'Tables',
				) ?? null,
			);
			const cell = () =>
				page.target.querySelector<HTMLInputElement>(
					'[aria-label="notes/a.md: title"]',
				);
			await until(
				() => cell() !== null && !cell()!.disabled,
				'the editable cell',
			);
			const original = cell()!;
			original.focus();
			original.setSelectionRange(1, 1);
			const key = page.context.queries.documents().queryKey;
			const before =
				page.context.queryClient.getQueryData<
					import('@epicenter/folder/documents').DocumentReading
				>(key)!;
			const firstEdit = disk.folder.files.document(
				'notes/a.md',
				before.tables.notes,
			);
			await page.context.refresh();
			const after =
				page.context.queryClient.getQueryData<
					import('@epicenter/folder/documents').DocumentReading
				>(key)!;
			expect(after.tables.notes).toBe(before.tables.notes);
			expect(disk.folder.files.document('notes/a.md', after.tables.notes)).toBe(
				firstEdit,
			);
			expect(cell()).toBe(original);
			expect(document.activeElement).toBe(original);
			expect(original.selectionStart).toBe(1);
			expect(disk.held).toHaveLength(0);
		} finally {
			await closeRefusing(page, disk);
		}
	});

	test.each(['Grid', 'Board'] as const)(
		'%s read retry refreshes retained content without publishing',
		async (mode) => {
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
			const button = (label: string) =>
				[...page.target.querySelectorAll('button')].find(
					(entry) => entry.textContent?.trim() === label,
				) ?? null;
			try {
				await until(() => button('Tables') !== null, 'navigation');
				press(button('Tables'));
				await until(
					() =>
						page.target.querySelector('[aria-label="tasks/a.md: status"]') !==
						null,
					'the grid',
				);
				if (mode === 'Board') {
					press(button('Board'));
					await until(
						() => page.target.querySelector('article') !== null,
						'the board',
					);
				}
				const edit = disk.folder.files.document('tasks/a.md');
				disk.reading.add('tasks/a.md');
				await edit.refresh();
				await until(() => button('Read again') !== null, 'the read retry');
				expect(button('Try again')).toBeNull();
				expect(disk.held).toHaveLength(0);
				disk.reading.delete('tasks/a.md');
				press(button('Read again'));
				await until(
					() => edit.getSnapshot().loadError === undefined,
					'the recovered source',
				);
				expect(edit.getSnapshot().isDirty).toBe(false);
				expect(disk.held).toHaveLength(0);
				expect(await disk.text('tasks/a.md')).toBe(
					'---\nstatus: todo\n---\nBody\n',
				);
			} finally {
				await closeRefusing(page, disk);
			}
		},
	);

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
			await until(() => cell()?.disabled === false, 'the editable table cell');
			const original = cell()!;
			original.focus();
			expect(document.activeElement).toBe(original);
			type(original, 'Typed here');
			flushSync();
			expect(
				disk.folder.files.document('todos/a.md').getSnapshot().content?.fields
					?.title,
			).toBe('Typed here');
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
	test('body-only input that forms malformed Markdown remains editable as source', async () => {
		const disk = await standIn({ 'a.md': 'body\n' });
		const page = openEditor(disk.folder);
		try {
			await until(() => page.file('a.md') !== null, 'the file');
			press(page.file('a.md'));
			await until(() => page.box() !== null, 'the source');
			const fileEdit = disk.folder.files.document('a.md');
			expectOk(fileEdit.patch({ body: '---\ntitle: [broken\n---\nbody\n' }));
			await until(
				() => page.box()?.value.includes('[broken') === true,
				'the body input',
			);
			expect(page.box()?.readOnly).toBe(false);
			type(page.box(), '---\ntitle: Repaired\n---\nbody\n');
			await until(() => fileEdit.getSnapshot().isDirty, 'the source repair');
			expect(fileEdit.getSnapshot().content?.fields).toEqual({
				title: 'Repaired',
			});
		} finally {
			await closeRefusing(page, disk);
		}
	});
});
