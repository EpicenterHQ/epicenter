/**
 * Todos end to end, per engine, as one person in one persistent browser
 * profile with a desktop sandbox beside it (see `stack.ts`).
 *
 * Todos in a browser is its online variant only: the person's repository,
 * behind sign-in, with nothing kept in the browser (ADR-0700). The desktop
 * variant is the Tauri window's folder, which `epicenter sync` syncs; the
 * sandbox's CLI stands in for it here.
 *
 * 1. Signed out, Todos asks for a sign-in. Signed in, todos are created,
 *    edited, completed and deleted in the repository, never in this
 *    browser's files, and a reload shows them again.
 * 2. `epicenter clone` holds them as written, and `epicenter check` passes
 *    against the published contract.
 * 3. A title edited on the desktop and synced shows with no reload; notes
 *    edited in the browser reach the desktop's next sync.
 * 4. A note the desktop wrote that does not read as a todo shows with its
 *    text, and saving fixed text there repairs it.
 * 5. Signing out asks for a sign-in again, and the browser holds nothing.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserContext, expect, type Page } from 'playwright/test';
import {
	emptyOpfs,
	epicenter,
	opfsFiles,
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
		// No step opens the app offline from a reload, so no service worker:
		// one would answer the page's requests out of sight of the test.
		serviceWorkers: 'block',
	});
	page = context.pages()[0] ?? (await context.newPage());
});

test.afterAll(async () => {
	await context?.close();
	if (profile) await rm(profile, { recursive: true, force: true });
});

const list = () => page.getByRole('list', { name: 'Todos' });
const status = () => page.getByTestId('status-summary');
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

test('1. signed in, todos are created, edited, completed and deleted in the repository, never in the browser', async ({
	stack,
	person,
}) => {
	// WebKit keeps OPFS outside the profile directory: start from an empty origin.
	await page.goto(`${stack.app}/`);
	await emptyOpfs(page);
	await page.goto(`${stack.app}/`);
	await expect(
		page.getByText('Sign in to use the todos in your Epicenter repository.'),
	).toBeVisible();

	// A signed-in session on the API; the real authorization redirect does the rest.
	await context.addCookies([{ ...person.cookie, url: stack.origin }]);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
	await expect(page).toHaveURL(`${stack.app}/`);
	await expect(status()).toHaveAttribute('aria-label', /^Status: Online\./);
	await expect(page.getByText('No todos yet')).toBeVisible();

	milk = await add('Buy milk');
	await detail().getByLabel('Title', { exact: true }).fill('Buy oat milk');
	await detail().getByLabel('Notes').fill('Not dairy.\n');
	await expect(row(milk)).toContainText('Buy oat milk');
	await row(milk)
		.getByRole('checkbox', { name: 'Complete Buy oat milk' })
		.click();
	await expect(
		row(milk).getByRole('checkbox', { name: 'Reopen Buy oat milk' }),
	).toBeVisible();

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
	// Nothing is kept in this browser.
	expect(await opfsFiles(page)).toEqual({});

	// The repository still has them after a reload.
	await page.reload();
	await expect(list().locator('li[data-id]')).toHaveText([
		/Buy bread/,
		/Buy oat milk/,
	]);
});

test('2. a desktop clone holds the todos as written, and the folder fits the contract', async ({
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
	expect((await readdir(join(clone, 'todos'))).sort()).toEqual(
		[`${bread}.md`, `${milk}.md`].sort(),
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

test('3. a title edited on the desktop shows with no reload, and notes edited in the browser reach the desktop', async ({
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

test('4. a note that does not read as a todo shows with its text, and is repaired', async ({
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
	await expect(row('call')).toContainText('Call mom');

	await sync(stack, person, clone);
	expect(await readFile(join(clone, 'todos/call.md'), 'utf8')).toBe(
		'---\ntitle: Call mom\ndone: false\n---\nSunday\n',
	);
});

test('5. signed out, Todos asks for a sign-in again, and the browser holds nothing', async () => {
	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(
		page.getByText('Sign in to use the todos in your Epicenter repository.'),
	).toBeVisible();
	expect(await opfsFiles(page)).toEqual({});
});
