/**
 * Folder Editor Mounted Tests
 *
 * Mounts the real folder editor, file tree, and file editor in jsdom inside
 * a folder context (`createFolderContext`), as `<FolderApp>` provides it, over
 * a stand-in folder whose saves the test answers.
 *
 * Key behaviors:
 * - Choosing another file sends what was typed; a save that fails keeps it,
 *   the tree marks the file, and the header names it
 * - Choosing the file again shows the typing and why it did not save; Try
 *   again saves it, and the mark goes
 * - The window's drafts are its folder context's work: settling them, as
 *   hiding the window does, sends what is typed and leaves the box editable;
 *   a failed save keeps the context failed and busy, so closing the window is
 *   held; closing the folder waits for a running save and answers what did
 *   not save
 *
 * Run with `--conditions=browser --conditions=svelte`, which mounting needs:
 * `bun test --conditions=browser --conditions=svelte FolderView.mounted`.
 * Under Bun's default conditions this file is skipped.
 */
import { describe, expect, test } from 'bun:test';
import type { Folder, FolderChange, SaveError } from '@epicenter/folder';
import { Err, Ok, type Result } from 'wellcrafted/result';

const browser = Bun.resolveSync('svelte', import.meta.dir).endsWith(
	'index-client.js',
);

describe.skipIf(!browser)('folder editor', async () => {
	if (!browser) return;
	const { blur, type } = await import(
		'../../../../packages/svelte/src/svelte-dom.test-support.js'
	);
	const { flushSync, mount, unmount } = await import('svelte');
	const { createFolderContext } = await import('@epicenter/svelte/folder');
	const { default: FolderViewHost } = await import(
		'./fixtures/FolderViewHost.svelte'
	);

	type Saved = Result<void, SaveError | Error>;

	/** Wait until `check` holds, letting saves, reads, and effects run. */
	async function until(check: () => boolean, what: string) {
		for (let tries = 0; tries < 200; tries++) {
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

	/** A folder of `stored` files whose every save waits for the test. */
	function standIn(stored: Record<string, string>) {
		const listeners = new Set<(change: FolderChange) => void>();
		const listing = { failure: undefined as Error | undefined };
		const held: {
			path: string;
			content: string;
			answer: (result: Saved) => void;
		}[] = [];
		const folder = {
			files: {
				list: async () =>
					listing.failure ? Err(listing.failure) : Ok(Object.keys(stored)),
				read: async (path: string) =>
					Ok(
						stored[path] === undefined
							? undefined
							: { path, content: new Blob([stored[path]]) },
					),
				write: (path: string, _from: unknown, content: string) =>
					new Promise<Saved>((answer) => held.push({ path, content, answer })),
			},
			tables: {},
			status: { saving: false, storageFailure: null },
			onChange: (listener: (change: FolderChange) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			onStatusChange: () => () => {},
			close: async () => {},
		} as unknown as Folder<Record<never, never>>;
		return {
			folder,
			held,
			listing,
			changed(paths: readonly string[] | null) {
				for (const listener of listeners)
					listener({ paths, origin: 'other-handle' });
			},
		};
	}

	/** The editor window's page over `folder`, and its context. */
	function openEditor(folder: Folder<Record<never, never>>) {
		const context = createFolderContext(folder);
		const target = document.createElement('div');
		document.body.append(target);
		const view = mount(FolderViewHost, { target, props: { context } });
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

	test('a save that fails as another file is chosen keeps the typing for the file', async () => {
		const stored: Record<string, string> = {
			'a.md': 'alpha\n',
			'b.md': 'beta\n',
		};
		const { folder, held } = standIn(stored);
		const page = openEditor(folder);
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
			held
				.shift()!
				.answer({ data: null, error: new Error('disk full') } as Saved);
			await until(() => header() === 'Not saved: a.md', 'the header');
			expect(file('a.md')?.textContent).toContain('(not saved yet)');
			expect(file('b.md')?.textContent).not.toContain('(not saved yet)');

			// Choosing it again shows the typing and why it did not save.
			press(file('a.md'));
			await until(() => box()?.value === 'alpha\nmine\n', 'the typing');
			expect(target.textContent).toContain(
				'Your edit was not saved: disk full',
			);

			const retry = [...target.querySelectorAll('button')].find(
				(button) => button.textContent?.trim() === 'Try again',
			);
			press(retry ?? null);
			await until(() => held.length === 1, 'the retry');
			expect(held[0]!.content).toBe('alpha\nmine\n');
			stored['a.md'] = 'alpha\nmine\n';
			held.shift()!.answer(Ok(undefined));
			await until(
				() => !file('a.md')?.textContent?.includes('(not saved yet)'),
				'the mark to go',
			);
			expect(box()?.value).toBe('alpha\nmine\n');
			expect(target.textContent).not.toContain('Your edit was not saved');
			expect(page.context.saveState).toBe('saved');
			await until(
				() => target.querySelector('output')?.textContent === 'saved',
				'reactive save completion',
			);
		} finally {
			await page.close();
			await page.context.close();
		}
	});

	test('the drafts settle when the window hides, stay editable, and hold a failed save', async () => {
		const stored: Record<string, string> = { 'a.md': 'alpha\n' };
		const { folder, held } = standIn(stored);
		const page = openEditor(folder);
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
			stored['a.md'] = 'alpha\nhidden\n';
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
			held
				.shift()!
				.answer({ data: null, error: new Error('disk full') } as Saved);
			await until(() => context.saveState === 'failed', 'the failure');
			expect(context.busy).toBe(true);
			// Settling tries the save again; refused again, it reports so.
			const retried = context.settled();
			await until(() => held.length === 1, 'the retry on settle');
			held
				.shift()!
				.answer({ data: null, error: new Error('disk full') } as Saved);
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
			// Closing settles the drafts once more after the running save; every
			// attempt is refused, and the close goes on only after the last.
			await until(() => {
				held
					.shift()
					?.answer({ data: null, error: new Error('disk full') } as Saved);
				return closed;
			}, 'the close');
			const unsaved = await closing;
			expect(unsaved.map((draft) => [draft.path, draft.unsaved])).toEqual([
				['a.md', 'alpha\nhidden\nshown\nlast\n'],
			]);
		} finally {
			await page.close();
		}
	});

	test('a directory change refreshes its opened descendant file', async () => {
		const stored = { 'notes/a.md': 'before\n' };
		const fixture = standIn(stored);
		const page = openEditor(fixture.folder);
		try {
			await until(() => page.file('notes/a.md') !== null, 'the tree');
			press(page.file('notes/a.md'));
			await until(() => page.box()?.value === 'before\n', 'the file');
			stored['notes/a.md'] = 'after replacing the directory\n';
			fixture.changed(['notes']);
			await until(
				() => page.box()?.value === stored['notes/a.md'],
				'the descendant refresh',
			);
		} finally {
			await page.close();
			await page.context.close();
		}
	});

	test.each(['deleted', 'unreadable'] as const)(
		'a failed draft stays reachable when its disk entry is %s',
		async (failure) => {
			const stored: Record<string, string> = {
				'a.md': 'alpha\n',
				'b.md': 'beta\n',
			};
			const fixture = standIn(stored);
			const page = openEditor(fixture.folder);
			try {
				await until(() => page.file('a.md') !== null, 'the tree');
				press(page.file('a.md'));
				await until(() => page.box()?.value === 'alpha\n', 'a.md');
				type(page.box(), 'my retained text\n');
				press(page.file('b.md'));
				await until(() => fixture.held.length === 1, 'the save');
				fixture.held.shift()!.answer(Err(new Error('disk full')));
				await until(() => page.context.saveState === 'failed', 'the failure');
				if (failure === 'deleted') delete stored['a.md'];
				else fixture.listing.failure = new Error('folder unreadable');
				fixture.changed(failure === 'deleted' ? ['a.md'] : null);
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
				await page.close();
				let closed = false;
				const closing = page.context.close().then(() => {
					closed = true;
				});
				await until(() => {
					fixture.held.shift()?.answer(Err(new Error('disk full')));
					return closed;
				}, 'pending saves');
				await closing;
			}
		},
	);
	test('a declared missing field can be edited in Tables and the same failed draft stays visible in Files', async () => {
		const stored = {
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
		};
		const disk = standIn(stored);
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
			disk.held.shift()!.answer(Err(new Error('disk full')) as Saved);
			await until(
				() => page.target.textContent?.includes('disk full') === true,
				'the held error',
			);
			press(button('Files'));
			await until(() => page.file('todos/a.md') !== null, 'the Files view');
			press(page.file('todos/a.md'));
			await until(
				() => page.box()?.value.includes('title: mine') === true,
				'the shared draft',
			);
			expect(page.box()?.readOnly).toBe(true);
			const sql = page.target.querySelector(
				'textarea[aria-label="SQL statement"]',
			) as HTMLTextAreaElement;
			type(sql, 'SELECT body FROM documents');
			press(button('SQL'));
			press(button('Files'));
			press(button('SQL'));
			expect(sql.value).toBe('SELECT body FROM documents');
			press(button('Files'));
			await until(() => button('Discard edit') !== null, 'the shared failure');
			press(button('Discard edit'));
			await until(() => !page.context.busy, 'discard');
		} finally {
			await page.close();
			await page.context.close();
		}
	});
});
