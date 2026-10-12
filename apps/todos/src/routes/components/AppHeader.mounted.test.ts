/**
 * App Header Mounted Tests
 *
 * Mounts the real `AppHeader` in jsdom over the real Todos owner on the
 * in-memory OPFS stand-in.
 *
 * Key behaviors:
 * - A folder that syncs offers Save version and Sync, and nothing else that
 *   touches history: no Fetch, Pull, Merge, or Commit and push (ADR-0529)
 * - A folder that does not sync yet, as on the desktop, offers Save version
 * - Save version records the saved files as a version and says so
 *
 * Run with `bun run test:mounted`; the server-runtime tests exclude this file.
 */
import '../../lib/svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { openFolder } from '@epicenter/folder/browser';
import { expectOk } from 'wellcrafted/testing';
import { testBrowserStorage } from '../../../../../packages/folder/src/browser-storage.test-support.js';
import { todosDefinition } from '../../lib/definition.js';
import type { TodosFolder } from '../../lib/platform/types.js';
import { clearQueryClient, quiet } from '../../lib/query.test-support.js';
import { click } from '../../lib/svelte-dom.test-support.js';
import type { Todos } from '../../lib/todos.svelte.js';

const { flushSync, mount, unmount } = await import('svelte');
const { startTodos } = await import('../../lib/todos.svelte.ts');
const { default: AppHeaderHost } = await import(
	'./fixtures/AppHeaderHost.svelte'
);

let count = 0;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
	clearQueryClient();
});

async function setup(adapt: (folder: TodosFolder) => TodosFolder = (f) => f) {
	const folder = expectOk(
		await openFolder({
			id: `app-header-${count++}`,
			definition: todosDefinition,
			browser: { ...testBrowserStorage() },
		}),
	);
	const todos: Todos = startTodos(adapt(folder));
	cleanup.push(() => todos.close());
	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(AppHeaderHost, { target });
	flushSync();
	cleanup.push(() => {
		void unmount(view);
		target.remove();
	});
	return { target, todos };
}

const testids = (target: HTMLElement) =>
	[
		'sync',
		'save-version',
		'pull',
		'fetch',
		'merge-incoming',
		'commit-and-push',
	].filter((id) => target.querySelector(`[data-testid="${id}"]`) !== null);

test('a folder that syncs offers Save version and Sync, and no other history action', async () => {
	const { target } = await setup();
	expect(testids(target)).toEqual(['sync', 'save-version']);
	expect(target.textContent).not.toContain('Fetch');
	expect(target.textContent).not.toContain('Commit and push');
});

test('a folder that does not sync yet offers Save version', async () => {
	const { target } = await setup((folder) => ({
		...folder,
		sync: { ...folder.sync, supported: false },
	}));
	expect(testids(target)).toEqual(['save-version']);
});

test('Save version records the saved files as a version', async () => {
	const { target, todos } = await setup();
	expectOk(await todos.create('Milk'));
	await quiet();
	expect(todos.git.lastCommit).toBeUndefined();
	click(target, 'Save version');
	for (
		let tries = 0;
		tries < 200 && todos.git.lastCommit === undefined;
		tries++
	)
		await Bun.sleep(5);
	await quiet();
	flushSync();
	expect(todos.git.lastCommit?.status).toBe('committed');
	const [head] = expectOk(await todos.folder.git.log(1));
	expect(todos.git.lastCommit).toMatchObject({ oid: head?.oid });
});
