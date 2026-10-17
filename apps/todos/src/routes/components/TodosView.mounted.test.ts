/**
 * Todos View Mounted Tests
 *
 * Mounts the whole `TodosView` in jsdom, inside the folder's scope as the
 * page provides it, over the real Todos store and a production browser folder whose
 * remote is the demo's real Git target: a bare repository served by
 * `git http-backend`, and a native checkout that commits and pushes with
 * system Git. jsdom matches no media query, so the view lays out as on a
 * narrow screen. Buttons are clicked through the DOM.
 *
 * Key behaviors:
 * - Sync with competing edits asks nothing: the workspace stays, this
 *   device's title wins on the remote, and a title being typed stays
 * - A folder that is not Todos's own offers no Connect, and a Connect asked
 *   for before sign-in does not open over it; Todos's own folder opens it
 *
 * Run with `bun run test:mounted`; the server-runtime tests exclude this file.
 */
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openFolder } from '@epicenter/folder/browser';
import { createFolderContext } from '@epicenter/svelte/folder';
import { expectOk } from 'wellcrafted/testing';
import {
	browserStorage,
	configureRemote,
	createTestStorage,
} from '../../../../../packages/folder/src/browser-storage.test-support.js';
import {
	createGitHandler,
	type GitSession,
	prepareGitSession,
} from '../../../../../packages/folder/src/git-demo-server.test-support.js';
import { git } from '../../../../../packages/folder/src/git-http.test-support.js';
import { click } from '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { requestConnect } from '../../lib/connect-request.js';
import { todosDefinition } from '../../lib/definition.js';
import { quiet, rowEditor } from '../../lib/query.test-support.js';
import type { Todos } from '../../lib/todos.svelte.js';

const { flushSync, mount, unmount } = await import('svelte');
const { createTodos } = await import('../../lib/todos.svelte.ts');
mock.module(
	'$app/state',
	() => import('../../lib/app-state.test-support.svelte.ts'),
);
mock.module(
	'$app/navigation',
	() => import('../../lib/app-navigation.test-support.ts'),
);
const { default: TodosViewHost } = await import(
	'./fixtures/TodosViewHost.svelte'
);

const originalFetch = globalThis.fetch;
afterAll(() => {
	globalThis.fetch = originalFetch;
});

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

let count = 0;
const MILK = 'todos/milk.md';

/** Let writes, reads, and effects run, then render. */
async function settle(todos: Todos) {
	await quiet(todos);
	flushSync();
	await Bun.sleep(0);
	flushSync();
}

async function eventually(done: () => boolean) {
	for (let waited = 0; waited < 1000 && !done(); waited++) {
		await Bun.sleep(5);
		flushSync();
	}
	flushSync();
}

/**
 * The mounted view over a demo folder that shares milk with the native
 * checkout, then milk edited on both sides: "Buy oat milk" here and "Buy soy
 * milk" on the remote.
 */
async function competing() {
	const session = await prepareGitSession({ name: 'todos', port: 5990 });
	const handle = await createGitHandler(session);
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
		handle(new Request(input, init))) as typeof fetch;
	const storage = createTestStorage();
	const id = `todos-view-${count++}`;
	await configureRemote(storage, id, session.remoteUrl);
	const folder = expectOk(
		await openFolder({
			app: id,
			definition: todosDefinition,
			browser: {
				author: { name: 'Todos', email: 'todos@localhost' },
				...browserStorage(storage),
			},
		}),
	);
	const opened = createFolderContext(folder);
	const todos = createTodos(opened);
	cleanup.push(() => opened.close());
	expectOk(
		await folder.tables.todos.create(
			{ fields: { title: 'Buy milk', done: false }, body: '' },
			{ stem: 'milk' },
		),
	);
	expectOk(await todos.sync.run());
	await git(
		session.nativeCheckout,
		'pull',
		'--quiet',
		'--ff-only',
		session.bare,
		'main',
	);
	await pushMilk(session, '---\ntitle: Buy soy milk\ndone: false\n---\n');

	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(TodosViewHost, { target, props: { opened } });
	cleanup.push(() => {
		void unmount(view);
		target.remove();
	});
	await settle(todos);
	void rowEditor(todos, 'milk')({ title: 'Buy oat milk' });
	await settle(todos);
	return { todos, session, target };
}

async function pushMilk(session: GitSession, text: string) {
	const native = session.nativeCheckout;
	await writeFile(join(native, MILK), text);
	await git(native, 'commit', '--quiet', '-am', 'Edit elsewhere');
	await git(native, 'push', '--quiet', session.bare, 'main');
}

/** The todo list, while it shows. */
const workspace = (target: Element) => {
	const list = target.querySelector('[aria-label="Todo list"]');
	return list?.closest('[hidden]') ? null : list;
};
const newTitle = (target: Element) =>
	target.querySelector<HTMLInputElement>('[aria-label="New todo title"]')!;

function sync(target: Element) {
	target
		.querySelector('[data-testid="sync"]')!
		.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

test('Sync with competing edits asks nothing: the workspace stays, this device wins, and a typed title stays', async () => {
	const { todos, session, target } = await competing();
	expect(workspace(target)?.textContent).toContain('Buy oat milk');
	newTitle(target).value = 'Buy bread';
	newTitle(target).dispatchEvent(new Event('input', { bubbles: true }));

	sync(target);
	const button = () =>
		target.querySelector<HTMLButtonElement>('[data-testid="sync"]')!;
	await eventually(() => !button().disabled);
	await settle(todos);
	expect(target.querySelector('[aria-label="Review sync changes"]')).toBeNull();
	expect(workspace(target)?.textContent).toContain('Buy oat milk');
	expect(newTitle(target).value).toBe('Buy bread');
	expect(await git(session.bare, 'show', `main:${MILK}`)).toContain(
		'title: Buy oat milk',
	);
	expect(await git(session.bare, 'log', '-1', '--format=%B', 'main')).toContain(
		`field="title" "${MILK}"`,
	);
}, 60_000);

test.each([
	[
		"Todos's own folder offers Connect and opens one asked for",
		true,
		['connect-open'],
		1,
	],
	['another folder offers no Connect and opens none asked for', false, [], 0],
] as const)('%s', async (_name, canConnect, offered, dialogs) => {
	const id = `todos-view-${count++}`;
	const storage = createTestStorage();
	const own = expectOk(
		await openFolder({
			app: id,
			definition: todosDefinition,
			browser: browserStorage(storage),
		}),
	);
	// Another folder is one Todos reads through its definition and does not
	// publish to: here, the same folder opened by its id once its first todo
	// published the declaration.
	expectOk(
		await own.tables.todos.create(
			{ fields: { title: 'Buy milk', done: false }, body: '' },
			{ stem: 'milk' },
		),
	);
	const folder = canConnect
		? own
		: (await own.close(),
			expectOk(
				await openFolder({
					id,
					definition: todosDefinition,
					browser: browserStorage(storage),
				}),
			));
	expect(folder.own).toBe(canConnect);
	const opened = createFolderContext(folder);
	const todos = createTodos(opened);
	cleanup.push(() => opened.close());
	// Sign-in returned to Connect, as it does after Connect sent it away.
	requestConnect();

	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(TodosViewHost, { target, props: { opened } });
	cleanup.push(() => {
		void unmount(view);
		target.remove();
	});
	await settle(todos);

	expect(
		[...target.querySelectorAll('[data-testid="connect-open"]')].map((button) =>
			button.getAttribute('data-testid'),
		),
	).toEqual([...offered]);
	expect(
		target.querySelector('[data-testid="remote"]')?.hasAttribute('disabled'),
	).toBe(!canConnect);
	expect(document.querySelectorAll('[role="dialog"]').length).toBe(dialogs);
	sessionStorage.clear();
});
