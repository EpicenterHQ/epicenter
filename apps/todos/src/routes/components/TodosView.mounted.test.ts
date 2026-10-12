/**
 * Todos View Mounted Tests
 *
 * Mounts the whole `TodosView` in jsdom, inside the query client the layout
 * provides, over the real Todos owner and a production browser folder whose
 * remote is the demo's real Git target: a bare repository served by
 * `git http-backend`, and a native checkout that commits and pushes with
 * system Git. jsdom matches no media query, so the view lays out as on a
 * narrow screen. Buttons are clicked through the DOM.
 *
 * Key behaviors:
 * - Sync with competing edits opens the shared review in place of the
 *   workspace, and nothing is written; Cancel forgets it and gives the
 *   workspace back
 * - A refused choice shows beside its row and keeps the review; Apply with
 *   valid choices ends it, and the list shows the result
 *
 * Run with `bun run test:mounted`; the server-runtime tests exclude this file.
 */
import '../../lib/svelte-dom.test-support.js';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openFolder } from '@epicenter/folder/browser';
import { expectOk } from 'wellcrafted/testing';
import {
	browserStorage,
	createTestStorage,
} from '../../../../../packages/folder/src/browser-storage.test-support.js';
import {
	createGitHandler,
	type GitSession,
	prepareGitSession,
} from '../../../server/git-server.js';
import { todosDefinition } from '../../lib/definition.js';
import {
	clearQueryClient,
	quiet,
	rowEditor,
} from '../../lib/query.test-support.js';
import { click } from '../../lib/svelte-dom.test-support.js';

const { flushSync, mount, unmount } = await import('svelte');
const { startTodos } = await import('../../lib/todos.svelte.ts');
const { default: TodosViewHost } = await import(
	'./fixtures/TodosViewHost.svelte'
);

const originalFetch = globalThis.fetch;
const env = {
	...process.env,
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_AUTHOR_NAME: 'Native',
	GIT_AUTHOR_EMAIL: 'native@localhost',
	GIT_COMMITTER_NAME: 'Native',
	GIT_COMMITTER_EMAIL: 'native@localhost',
};

beforeAll(() => {
	process.env.GIT_CONFIG_GLOBAL = '/dev/null';
	delete process.env.TODOS_DEMO_ROOT;
});
afterAll(() => {
	globalThis.fetch = originalFetch;
});

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
	clearQueryClient();
});

let count = 0;
const MILK = 'todos/milk.md';

async function run(cwd: string, command: string[]) {
	const child = Bun.spawn(command, {
		cwd,
		env,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`${command.join(' ')}: ${stderr}${stdout}`);
	return stdout.trim();
}

/** Let writes, reads, and effects run, then render. */
async function settle() {
	await quiet();
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
	const session = await prepareGitSession(5990);
	const handle = await createGitHandler(session);
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
		handle(new Request(input, init))) as typeof fetch;
	const folder = expectOk(
		await openFolder({
			id: `todos-view-${count++}`,
			definition: todosDefinition,
			browser: {
				author: { name: 'Todos', email: 'todos@localhost' },
				remote: { url: session.remoteUrl, branch: 'main' },
				...browserStorage(createTestStorage()),
			},
		}),
	);
	const todos = startTodos(folder);
	cleanup.push(() => todos.close());
	expectOk(
		await folder.tables.todos.create(
			{ fields: { title: 'Buy milk', done: false }, body: '' },
			{ stem: 'milk' },
		),
	);
	expectOk(await todos.sync());
	await run(session.nativeCheckout, [
		'git',
		'pull',
		'--quiet',
		'--ff-only',
		session.bare,
		'main',
	]);
	await pushMilk(session, '---\ntitle: Buy soy milk\ndone: false\n---\n');

	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(TodosViewHost, { target });
	cleanup.push(() => {
		void unmount(view);
		target.remove();
	});
	await settle();
	rowEditor(
		todos,
		'milk',
	)((row) => ({
		...row,
		fields: { ...row.fields, title: 'Buy oat milk' },
	}));
	await settle();
	return { todos, session, target };
}

async function pushMilk(session: GitSession, text: string) {
	const native = session.nativeCheckout;
	await writeFile(join(native, MILK), text);
	await run(native, ['git', 'commit', '--quiet', '-am', 'Edit elsewhere']);
	await run(native, ['git', 'push', '--quiet', session.bare, 'main']);
}

const review = (target: Element) =>
	target.querySelector('[aria-label="Review sync changes"]');
const workspace = (target: Element) =>
	target.querySelector('[aria-label="Todo list"]');

function sync(target: Element) {
	target
		.querySelector('[data-testid="sync"]')!
		.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

test('Sync with competing edits opens the review in place of the workspace and writes nothing; Cancel forgets it', async () => {
	const { session, target } = await competing();
	expect(workspace(target)?.textContent).toContain('Buy oat milk');

	sync(target);
	await eventually(() => review(target) !== null);
	expect(review(target)?.textContent).toContain(MILK);
	expect(workspace(target)).toBeNull();
	// The Git actions wait while the review shows.
	expect(
		target.querySelector<HTMLButtonElement>('[data-testid="sync"]')!.disabled,
	).toBe(true);
	expect(await run(session.bare, ['git', 'show', `main:${MILK}`])).toContain(
		'title: Buy soy milk',
	);

	click(review(target)!, 'Cancel');
	await eventually(() => review(target) === null);
	await settle();
	expect(review(target)).toBeNull();
	expect(workspace(target)?.textContent).toContain('Buy oat milk');
	expect(
		target.querySelector<HTMLButtonElement>('[data-testid="sync"]')!.disabled,
	).toBe(false);
}, 60_000);

test('a refused choice shows beside its row and keeps the review; Apply with a valid choice ends it, and the list shows the result', async () => {
	const { session, target } = await competing();
	sync(target);
	await eventually(() => review(target) !== null);

	// Leaving out a required field is refused by the folder.
	click(review(target)!, 'Leave out');
	flushSync();
	click(review(target)!, 'Apply and sync');
	await eventually(() =>
		Boolean(review(target)?.querySelector('[aria-invalid="true"]')),
	);
	expect(review(target)).not.toBeNull();
	expect(
		review(target)!
			.querySelector('[aria-label="Result for title"]')
			?.getAttribute('aria-invalid'),
	).toBe('true');

	// Take the remote's title.
	const [, remote] = [...review(target)!.querySelectorAll('button')].filter(
		(button) => button.textContent?.trim() === 'Use this',
	);
	remote!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	flushSync();
	click(review(target)!, 'Apply and sync');
	await eventually(() => review(target) === null);
	await settle();
	expect(workspace(target)?.textContent).toContain('Buy soy milk');
	expect(await run(session.bare, ['git', 'show', `main:${MILK}`])).toContain(
		'title: Buy soy milk',
	);
}, 60_000);
