/**
 * Folder View Mounted Tests
 *
 * Mounts the real folder view and file editor in jsdom over a stand-in
 * folder whose saves the test answers, with the window's drafts
 * (`createFileDrafts`) and a query client as the window builds them.
 *
 * Key behaviors:
 * - Choosing another file sends what was typed; a save that fails keeps it,
 *   the tree marks the file, and the header names it
 * - Choosing the file again shows the typing and why it did not save; Try
 *   again saves it, and the mark goes
 *
 * Run with `--conditions=browser --conditions=svelte`, which mounting needs:
 * `bun test --conditions=browser --conditions=svelte FolderView.mounted`.
 * Under Bun's default conditions this file is skipped.
 */
import { describe, expect, test } from 'bun:test';
import type { Folder, SaveError } from '@epicenter/folder';
import { Ok, type Result } from 'wellcrafted/result';

const browser = Bun.resolveSync('svelte', import.meta.dir).endsWith(
	'index-client.js',
);

describe.skipIf(!browser)('folder view', async () => {
	if (!browser) return;
	const { type } = await import(
		'../../../../packages/svelte/src/svelte-dom.test-support.js'
	);
	const { flushSync, mount, unmount } = await import('svelte');
	const { QueryClient } = await import('@tanstack/svelte-query');
	const { createFileDrafts } = await import('./drafts.svelte.ts');
	const { fileKey } = await import('./files');
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

	test('a save that fails as another file is chosen keeps the typing for the file', async () => {
		const stored: Record<string, string> = {
			'a.md': 'alpha\n',
			'b.md': 'beta\n',
		};
		const held: {
			path: string;
			content: string;
			answer: (result: Saved) => void;
		}[] = [];
		const folder = {
			files: {
				list: async () => Ok(Object.keys(stored)),
				read: async (path: string) =>
					Ok({ path, content: new Blob([stored[path] ?? '']) }),
				write: (path: string, _from: unknown, content: string) =>
					new Promise<Saved>((answer) => held.push({ path, content, answer })),
			},
			status: { saving: false, storageFailure: null },
			onStatusChange: () => () => {},
		} as unknown as Folder<Record<never, never>>;
		const client = new QueryClient({
			defaultOptions: {
				queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
			},
		});
		const drafts = createFileDrafts({
			files: folder.files,
			saved: (path) =>
				client.invalidateQueries({ queryKey: fileKey('x', path) }),
		});
		const target = document.createElement('div');
		document.body.append(target);
		const view = mount(FolderViewHost, {
			target,
			props: { client, folder, drafts, scope: 'x', title: 'X' },
		});

		const file = (path: string) =>
			target.querySelector(`nav button[title="${path}"]`);
		const box = () => target.querySelector('textarea');
		const header = () =>
			target.querySelector('header [role="status"]')?.textContent?.trim();
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
			await until(() => !drafts.file('a.md').held, 'the saved draft');
			await until(
				() => !file('a.md')?.textContent?.includes('(not saved yet)'),
				'the mark to go',
			);
			expect(box()?.value).toBe('alpha\nmine\n');
			expect(target.textContent).not.toContain('Your edit was not saved');
		} finally {
			await unmount(view);
			target.remove();
		}
	});
});
