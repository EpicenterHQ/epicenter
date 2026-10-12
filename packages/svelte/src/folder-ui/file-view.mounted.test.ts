/**
 * File View Mounted Tests
 *
 * Mounts the real `FileView` in jsdom over a stand-in text session, inside
 * the providers an app root gives it.
 *
 * Key behaviors:
 * - A row file whose text does not read shows each issue, read live from
 *   what is typed, and "Open as" waits until the text reads
 * - Typing goes to the session, keeping the file's own line endings
 * - A file that is not text shows its type and size
 * - A file that failed to open offers Try again
 * - The app's own body shows when the item is one this view does not know
 *
 * Run with `bun run test:mounted`.
 */
import '../svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { defineFolder, defineTable, field } from '@epicenter/folder';
import type { Component, ComponentProps } from 'svelte';
import { click, type } from '../svelte-dom.test-support.js';
import type FileViewComponent from './file-view.svelte';
import type { FileViewItem } from './file-view.svelte';

const { flushSync, mount, unmount } = await import('svelte');
const { default: Providers } = await import('./fixtures/Providers.svelte');
const { default: FileView } = await import('./file-view.svelte');
const { createRawSnippet } = await import('svelte');
const { fakeTextSession: fakeSession } = await import(
	'./fixtures/fake-text-session.svelte.ts'
);

const tasks = defineFolder({
	title: 'Tasks',
	kv: {},
	tables: {
		tasks: defineTable({ fields: { title: field.string() } }),
	},
}).tables.tasks;

const VALID = '---\ntitle: Walk\n---\n';

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const step of cleanup.splice(0)) step();
});

function setup(
	item: FileViewItem | undefined,
	extra: Partial<ComponentProps<typeof FileViewComponent>> = {},
) {
	const calls: unknown[][] = [];
	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(Providers, {
		target,
		props: {
			component: FileView as Component<object>,
			props: {
				path: 'tasks/walk.md',
				item,
				onRetry: () => calls.push(['retry']),
				onReloadTheirs: async () => undefined,
				onKeepMine: async () => undefined,
				onRename: async (name: string) => {
					calls.push(['rename', name]);
					return undefined;
				},
				onDelete: () => calls.push(['delete']),
				...extra,
			},
		},
	});
	flushSync();
	cleanup.push(() => {
		void unmount(view);
		target.remove();
	});
	const openAs = () =>
		[...target.querySelectorAll('button')].find(
			(button) => button.textContent?.trim() === 'Open as task',
		);
	return { target, calls, openAs };
}

test('a row file that does not read shows its issues, and Open as waits for the text to read', () => {
	const { session, typed } = fakeSession('---\ntitle: [\n---\n');
	const { target, calls, openAs } = setup(
		{ kind: 'text', session },
		{
			row: {
				table: tasks,
				noun: 'task',
				onOpenAsRow: () => calls.push(['open as row']),
			},
		},
	);
	const repair = () => target.querySelector('[data-testid="needs-repair"]');
	expect(repair()?.textContent).toContain(
		'This text does not read as a task yet.',
	);
	expect(openAs()?.disabled).toBe(true);

	type(target.querySelector('textarea'), VALID);
	flushSync();
	expect(typed).toEqual([VALID]);
	expect(repair()).toBeNull();
	expect(openAs()?.disabled).toBe(false);
	openAs()?.click();
	expect(calls).toEqual([['open as row']]);
});

test('typing keeps the file’s own line endings', () => {
	const { session, typed } = fakeSession('one\r\ntwo\r\n');
	const { target } = setup({ kind: 'text', session });
	const textarea = target.querySelector('textarea');
	expect(textarea?.value).toBe('one\ntwo\n');
	type(textarea, 'one\ntwo\nthree\n');
	expect(typed).toEqual(['one\r\ntwo\r\nthree\r\n']);
});

test('a file that is not text shows its type and size', () => {
	const { target } = setup({ kind: 'binary', size: 2048 });
	expect(target.textContent).toContain('MD file · 2.0 KB');
	expect(target.textContent).toContain('This file is not text');
	expect(target.querySelector('textarea')).toBeNull();
});

test('a file that failed to open offers Try again', () => {
	const { target, calls } = setup({ kind: 'failed', message: 'Gone' });
	expect(target.textContent).toContain('Gone');
	click(target, 'Try again');
	expect(calls).toEqual([['retry']]);
});

test('the app’s own body shows for an item this view does not know', () => {
	const { target, calls } = setup(undefined, {
		children: createRawSnippet(() => ({
			render: () => '<p data-testid="own">Audio</p>',
		})),
	});
	expect(target.querySelector('[data-testid="own"]')?.textContent).toBe(
		'Audio',
	);
	// The name bar still deletes the file.
	click(target, 'Delete');
	expect(calls).toEqual([['delete']]);
});
