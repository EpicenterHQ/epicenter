/**
 * App Header Mounted Tests
 *
 * Mounts the real `AppHeader` in jsdom over the real Todos store on the
 * in-memory OPFS stand-in.
 *
 * Key behaviors:
 * - A folder that syncs offers Save version and Sync, and nothing else that
 *   touches history: no Fetch, Pull, Merge, or Commit and push (ADR-0529)
 * - A folder with no remote offers Connect in Sync's place and says it is
 *   not connected; a connected one names its repository, which opens Connect
 * - Save version records the saved files as a version and says so
 *
 * Run with `bun run test:mounted`; the server-runtime tests exclude this file.
 */
import '../../lib/svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { openFolder } from '@epicenter/folder/browser';
import { expectOk } from 'wellcrafted/testing';
import {
	browserStorage,
	configureRemote,
	createTestStorage,
} from '../../../../../packages/folder/src/browser-storage.test-support.js';
import { todosDefinition } from '../../lib/definition.js';
import { quiet } from '../../lib/query.test-support.js';
import { click } from '../../lib/svelte-dom.test-support.js';
import type { Todos } from '../../lib/todos.svelte.js';

const { flushSync, mount, unmount } = await import('svelte');
const { createTodos } = await import('../../lib/todos.svelte.ts');
const { default: AppHeaderHost } = await import(
	'./fixtures/AppHeaderHost.svelte'
);

let count = 0;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

async function setup({
	remote,
	...props
}: {
	remote?: string;
	onconnect?: () => void;
} = {}) {
	const storage = createTestStorage();
	const id = `app-header-${count++}`;
	if (remote !== undefined) await configureRemote(storage, id, remote);
	const folder = expectOk(
		await openFolder({
			id,
			definition: todosDefinition,
			browser: { ...browserStorage(storage) },
		}),
	);
	const todos: Todos = createTodos(folder);
	cleanup.push(() => todos.close());
	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(AppHeaderHost, { target, props: { todos, ...props } });
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
		'connect-open',
		'save-version',
		'pull',
		'fetch',
		'merge-incoming',
		'commit-and-push',
	].filter((id) => target.querySelector(`[data-testid="${id}"]`) !== null);

test('a folder with no remote offers Save version and Connect, and says it is not connected', async () => {
	let opened = 0;
	const { target } = await setup({ onconnect: () => opened++ });
	expect(testids(target)).toEqual(['connect-open', 'save-version']);
	const remote = target.querySelector('[data-testid="remote"]');
	expect(remote?.textContent).toContain('Not connected');
	click(target, 'Connect');
	expect(opened).toBe(1);
});

test('a connected folder offers Save version and Sync, names its repository, and no other history action', async () => {
	let opened = 0;
	const { target } = await setup({
		remote: 'https://github.com/alice/todos.git',
		onconnect: () => opened++,
	});
	expect(testids(target)).toEqual(['sync', 'save-version']);
	expect(target.textContent).not.toContain('Fetch');
	expect(target.textContent).not.toContain('Commit and push');
	const remote = target.querySelector('[data-testid="remote"]');
	expect(remote?.getAttribute('aria-label')).toBe(
		'Syncs with alice/todos. Change remote',
	);
	remote?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	expect(opened).toBe(1);
});

test('Save version records the saved files as a version', async () => {
	const { target, todos } = await setup();
	expectOk(await todos.rows.create('Milk'));
	await quiet(todos);
	expect(todos.git.snapshot.lastCommit).toBeUndefined();
	click(target, 'Save version');
	for (
		let tries = 0;
		tries < 200 && todos.git.snapshot.lastCommit === undefined;
		tries++
	)
		await Bun.sleep(5);
	await quiet(todos);
	flushSync();
	expect(todos.git.snapshot.lastCommit?.status).toBe('committed');
	const [head] = expectOk(await todos.folder.git.log(1));
	expect(todos.git.snapshot.lastCommit).toMatchObject({ oid: head?.oid });
});
