/**
 * Todos end to end, per engine, as one person in one persistent browser
 * profile with a desktop sandbox beside it (see `stack.ts`):
 *
 * 1. Signed out, todos are created, edited, completed and deleted in the
 *    browser (OPFS), as Markdown notes at `todos/<id>.md`.
 * 2. Signed in, they upload on their own and the browser lets go of its
 *    copies; a todo added signed in goes straight to the repository.
 * 3. `epicenter clone` holds them as written, and `epicenter check` passes
 *    against the published contract.
 * 4. A title edited on the desktop and synced shows on the web, with no
 *    reload; notes edited on the web reach the desktop's next sync.
 * 5. A note the desktop wrote that does not read as a todo shows on the
 *    web with its text, and saving fixed text there repairs it.
 * 6. Signing out leaves this browser with no todos.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserContext, expect, type Page } from 'playwright/test';
import {
	emptyOpfs,
	epicenter,
	opfsFiles,
	opfsText,
	stackTest,
	sync,
} from '../../../packages/cli/src/app-e2e.test-support.ts';

const test = stackTest('TODOS_E2E_STATE');

test.describe.configure({ mode: 'serial' });

let profile: string;
let context: BrowserContext;
let page: Page;

/** What the first steps learn, for the later ones. */
let milk: string;
let bread: string;
let clone: string;

test.beforeAll(async ({ playwright, browserName, launchOptions }) => {
	profile = await mkdtemp(join(tmpdir(), `todos-${browserName}-`));
	// A persistent profile: WebKit refuses OPFS in an ephemeral context.
	context = await playwright[browserName].launchPersistentContext(profile, {
		...launchOptions,
		viewport: { width: 1280, height: 800 },
	});
	page = context.pages()[0] ?? (await context.newPage());
});

test.afterAll(async () => {
	await context?.close();
	if (profile) await rm(profile, { recursive: true, force: true });
});

const list = () => page.getByRole('list', { name: 'Todos' });
const row = (id: string) => page.locator(`li[data-id="${id}"]`);
const detail = () => page.getByRole('region', { name: 'Todo', exact: true });

/** Add a todo by its title; answers its id, from the row that shows it. */
async function add(title: string) {
	const before = await list()
		.locator('li[data-id]')
		.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-id')));
	await page.getByLabel('New todo title').fill(title);
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	const added = list().locator('li[data-id]', { hasText: title });
	await expect(added).toHaveCount(1);
	const id = (await added.getAttribute('data-id')) as string;
	expect(before).not.toContain(id);
	// Add opens the new todo.
	await expect(detail().getByLabel('Title', { exact: true })).toHaveValue(
		title,
	);
	return id;
}

/** The todos in this origin's OPFS: their paths, without the device's own hidden files. */
async function todoFiles() {
	return Object.keys(await opfsFiles(page))
		.filter((path) => path.startsWith('todos/'))
		.sort();
}

test('1. signed out, todos are created, edited, completed and deleted in the browser', async ({
	stack,
}) => {
	// WebKit keeps OPFS outside the profile directory: start from an empty origin.
	await page.goto(`${stack.app}/`);
	await emptyOpfs(page);
	await page.goto(`${stack.app}/`);
	await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
	await expect(page.getByText('No todos yet')).toBeVisible();

	milk = await add('Buy milk');
	expect(await opfsText(page, `todos/${milk}.md`)).toBe(
		'---\ntitle: Buy milk\ndone: false\n---\n',
	);

	await detail().getByLabel('Title', { exact: true }).fill('Buy oat milk');
	await detail().getByLabel('Notes').fill('Not dairy.\n');
	await expect(row(milk)).toContainText('Buy oat milk');
	await expect
		.poll(() => opfsText(page, `todos/${milk}.md`))
		.toBe('---\ntitle: Buy oat milk\ndone: false\n---\nNot dairy.\n');

	await row(milk)
		.getByRole('checkbox', { name: 'Complete Buy oat milk' })
		.click();
	await expect(
		row(milk).getByRole('checkbox', { name: 'Reopen Buy oat milk' }),
	).toBeVisible();
	await expect
		.poll(() => opfsText(page, `todos/${milk}.md`))
		.toBe('---\ntitle: Buy oat milk\ndone: true\n---\nNot dairy.\n');

	const gone = await add('Never mind');
	bread = await add('Buy bread');
	await row(gone).getByRole('button', { name: 'Never mind' }).click();
	await detail().getByRole('button', { name: 'Delete' }).click();
	await page
		.getByRole('alertdialog')
		.getByRole('button', { name: 'Delete' })
		.click();
	await expect(row(gone)).toHaveCount(0);

	// Open todos first, then done ones.
	await expect(list().locator('li[data-id]')).toHaveText([
		/Buy bread/,
		/Buy oat milk/,
	]);
	expect(await todoFiles()).toEqual(
		[`todos/${bread}.md`, `todos/${milk}.md`].sort(),
	);

	// Still there after a reload.
	await page.reload();
	await expect(list().locator('li[data-id]')).toHaveText([
		/Buy bread/,
		/Buy oat milk/,
	]);
});

test('2. signed in, the todos upload and leave the browser, and a new one goes straight to the repository', async ({
	stack,
	person,
}) => {
	// A signed-in session on the API; the real authorization redirect does the rest.
	await context.addCookies([{ ...person.cookie, url: stack.origin }]);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

	await expect(row(milk)).toHaveAttribute('data-where', 'repository');
	await expect(row(bread)).toHaveAttribute('data-where', 'repository');
	await expect(page.getByText('not uploaded yet')).toHaveCount(0);
	// The browser let go of every todo and of the outbox: the repository has them.
	await expect.poll(() => opfsFiles(page)).toEqual({});

	const eggs = await add('Buy eggs');
	await expect(row(eggs)).toHaveAttribute('data-where', 'repository');
	expect(await opfsFiles(page)).toEqual({});
});

test('3. a desktop clone holds the todos as written, and the folder fits the contract', async ({
	stack,
	person,
}) => {
	clone = join(person.home, 'todos');
	const cloned = await epicenter(
		stack,
		person,
		'clone',
		`${person.namespace}/todos`,
		clone,
	);
	expect(cloned.code, `${cloned.stdout}\n${cloned.stderr}`).toBe(0);

	expect(await readFile(join(clone, `todos/${milk}.md`), 'utf8')).toBe(
		'---\ntitle: Buy oat milk\ndone: true\n---\nNot dairy.\n',
	);
	expect(await readFile(join(clone, `todos/${bread}.md`), 'utf8')).toBe(
		'---\ntitle: Buy bread\ndone: false\n---\n',
	);

	const checked = await epicenter(
		stack,
		person,
		'check',
		`${stack.app}/contract.json`,
		clone,
	);
	expect(checked.code, `${checked.stdout}\n${checked.stderr}`).toBe(0);
});

test('4. a title edited on the desktop shows on the web with no reload, and notes edited on the web reach the desktop', async ({
	stack,
	person,
}) => {
	const path = join(clone, `todos/${bread}.md`);
	await writeFile(
		path,
		(await readFile(path, 'utf8')).replace(
			/^title: .*$/m,
			'title: Buy rye bread',
		),
	);
	await sync(stack, person, clone);

	// The remote hears main move (a poll until the notify Durable Object).
	await expect(row(bread)).toContainText('Buy rye bread');

	await row(bread).getByRole('button', { name: 'Buy rye bread' }).click();
	await expect(detail().getByLabel('Title', { exact: true })).toHaveValue(
		'Buy rye bread',
	);
	await detail().getByLabel('Notes').fill('From the bakery.\n');
	await expect
		.poll(async () => {
			await sync(stack, person, clone);
			return readFile(path, 'utf8');
		})
		.toBe('---\ntitle: Buy rye bread\ndone: false\n---\nFrom the bakery.\n');
});

test('5. a note that does not read as a todo shows with its text, and is repaired on the web', async ({
	stack,
	person,
}) => {
	const broken = '---\ntitle: [Call mom\n---\nSunday\n';
	await writeFile(join(clone, 'todos/call.md'), broken);
	await sync(stack, person, clone);

	const repair = page.getByRole('region', { name: 'Needs repair' });
	await expect(repair).toContainText('todos/call.md');
	await repair.getByRole('button', { name: 'Show' }).click();
	await expect(detail().getByTestId('needs-repair')).toBeVisible();
	const text = detail().getByLabel('Text of todos/call.md');
	await expect(text).toHaveValue(broken);

	// Text that still does not fit is refused, and stays to fix.
	await text.fill('---\ntitle: Call mom\n---\nSunday\n');
	await detail().getByRole('button', { name: 'Save repair' }).click();
	await expect(detail().getByRole('alert')).toContainText('done');

	await text.fill('---\ntitle: Call mom\ndone: false\n---\nSunday\n');
	await detail().getByRole('button', { name: 'Save repair' }).click();
	await expect(detail().getByLabel('Title', { exact: true })).toHaveValue(
		'Call mom',
	);
	await expect(repair).toHaveCount(0);
	await expect(row('call')).toHaveAttribute('data-where', 'repository');

	await sync(stack, person, clone);
	expect(await readFile(join(clone, 'todos/call.md'), 'utf8')).toBe(
		'---\ntitle: Call mom\ndone: false\n---\nSunday\n',
	);
});

test('6. signed out, the browser holds no todos', async () => {
	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
	await expect(page.getByText('No todos yet')).toBeVisible();
	expect(await opfsFiles(page)).toEqual({});
});
