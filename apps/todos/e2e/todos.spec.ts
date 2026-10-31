/**
 * Todos end to end, per engine, as one person in one persistent browser
 * profile with a desktop sandbox beside it (see `stack.ts`).
 *
 * Todos has two web variants, each over one store for the page's life, and
 * nothing moves between them (ADR-0700): "On this browser" (`/`), this
 * browser's files, with no account; and "Online" (`/online`), the person's
 * repository, signed in.
 *
 * 1. On this browser, todos are created, edited, completed and deleted as
 *    Markdown notes at `todos/<id>.md` in OPFS, and survive a reload.
 * 2. Offline, the local variant still creates and edits.
 * 3. Online asks for a sign-in; signed in, it shows the repository, which
 *    holds none of this browser's todos, and a todo created and edited
 *    there lands in the repository and never in this browser.
 * 4. `epicenter clone` holds it as written, and `epicenter check` passes
 *    against the published contract.
 * 5. A title edited on the desktop and synced shows online with no reload;
 *    notes edited online reach the desktop's next sync.
 * 6. A note the desktop wrote that does not read as a todo shows online
 *    with its text, and saving fixed text there repairs it.
 * 7. Signing in moved nothing: this browser's todos are where they were,
 *    and the repository has none of them. Signing out leaves them too.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserContext, expect, type Page } from 'playwright/test';
import {
	emptyOpfs,
	epicenter,
	goOffline,
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
let flour: string;
/** The todos made online, in the repository. */
let eggs: string;
let loaf: string;
let clone: string;
/** This browser's files once the local steps are done. */
let localFiles: Record<string, string>;

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
const ways = () => page.getByRole('navigation', { name: 'Ways to use Todos' });
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

/** The todos in this origin's OPFS: their paths, without the device's own hidden files. */
async function todoFiles() {
	return Object.keys(await opfsFiles(page))
		.filter((path) => path.startsWith('todos/'))
		.sort();
}

test('1. on this browser, todos are created, edited, completed and deleted, and survive a reload', async ({
	stack,
}) => {
	// WebKit keeps OPFS outside the profile directory: start from an empty origin.
	await page.goto(`${stack.app}/`);
	await emptyOpfs(page);
	await page.goto(`${stack.app}/`);
	await expect(
		ways().getByRole('link', { name: 'On this browser' }),
	).toHaveAttribute('aria-current', 'page');
	await expect(status()).toHaveAttribute(
		'aria-label',
		/^Status: On this browser\./,
	);
	// The local variant needs no account, and offers none.
	await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
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

test('2. offline, the local variant still creates and edits', async () => {
	const online = await goOffline(context);
	try {
		flour = await add('Buy flour');
		await detail().getByLabel('Notes').fill('Rye.\n');
		await expect
			.poll(() => opfsText(page, `todos/${flour}.md`))
			.toBe('---\ntitle: Buy flour\ndone: false\n---\nRye.\n');
		await expect(status()).toHaveAttribute(
			'aria-label',
			/^Status: On this browser\./,
		);
	} finally {
		await online();
	}
	await expect(list().locator('li[data-id]')).toHaveText([
		/Buy bread/,
		/Buy flour/,
		/Buy oat milk/,
	]);
	localFiles = await opfsFiles(page);
	expect(Object.keys(localFiles).sort()).toEqual(
		[`todos/${bread}.md`, `todos/${flour}.md`, `todos/${milk}.md`].sort(),
	);
});

test('3. online, signed in, shows the repository; a todo made and edited there lands in it, never in this browser', async ({
	stack,
	person,
}) => {
	await ways().getByRole('link', { name: 'Online' }).click();
	await expect(page).toHaveURL(`${stack.app}/online`);
	await expect(
		page.getByText('Sign in to use the todos in your Epicenter repository.'),
	).toBeVisible();

	// A signed-in session on the API; the real authorization redirect does the rest.
	await context.addCookies([{ ...person.cookie, url: stack.origin }]);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
	await expect(page).toHaveURL(`${stack.app}/online`);
	await expect(ways().getByRole('link', { name: 'Online' })).toHaveAttribute(
		'aria-current',
		'page',
	);
	await expect(status()).toHaveAttribute('aria-label', /^Status: Online\./);
	// The repository is its own list: none of this browser's todos are in it.
	await expect(page.getByText('No todos yet')).toBeVisible();

	eggs = await add('Buy eggs');
	await detail().getByLabel('Notes').fill('A dozen.\n');
	await row(eggs).getByRole('checkbox', { name: 'Complete Buy eggs' }).click();
	await expect(
		row(eggs).getByRole('checkbox', { name: 'Reopen Buy eggs' }),
	).toBeVisible();
	loaf = await add('Buy bread');
	await expect(list().locator('li[data-id]')).toHaveText([
		/Buy bread/,
		/Buy eggs/,
	]);
	// Nothing online is kept in this browser.
	expect(await opfsFiles(page)).toEqual(localFiles);
});

test('4. a desktop clone holds the todos as written, and the folder fits the contract', async ({
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

	await expect
		.poll(() => readFile(join(clone, `todos/${eggs}.md`), 'utf8'))
		.toBe('---\ntitle: Buy eggs\ndone: true\n---\nA dozen.\n');
	expect(await readFile(join(clone, `todos/${loaf}.md`), 'utf8')).toBe(
		'---\ntitle: Buy bread\ndone: false\n---\n',
	);
	expect((await readdir(join(clone, 'todos'))).sort()).toEqual(
		[`${loaf}.md`, `${eggs}.md`].sort(),
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

test('5. a title edited on the desktop shows online with no reload, and notes edited there reach the desktop', async ({
	stack,
	person,
}) => {
	const path = join(clone, `todos/${loaf}.md`);
	await writeFile(
		path,
		(await readFile(path, 'utf8')).replace(
			/^title: .*$/m,
			'title: Buy rye bread',
		),
	);
	await sync(stack, person, clone);

	// The remote hears main move (a poll until the notify Durable Object).
	await expect(row(loaf)).toContainText('Buy rye bread');

	await row(loaf).getByRole('button', { name: 'Buy rye bread' }).click();
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

test('6. a note that does not read as a todo shows online with its text, and is repaired there', async ({
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

test('7. signing in moved nothing: this browser keeps its todos, the repository has none of them, and signing out keeps them too', async ({
	stack,
	person,
}) => {
	await ways().getByRole('link', { name: 'On this browser' }).click();
	await expect(page).toHaveURL(`${stack.app}/`);
	await expect(list().locator('li[data-id]')).toHaveText([
		/Buy bread/,
		/Buy flour/,
		/Buy oat milk/,
	]);
	expect(await opfsFiles(page)).toEqual(localFiles);

	await sync(stack, person, clone);
	expect((await readdir(join(clone, 'todos'))).sort()).toEqual(
		['call.md', `${loaf}.md`, `${eggs}.md`].sort(),
	);

	await ways().getByRole('link', { name: 'Online' }).click();
	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(
		page.getByText('Sign in to use the todos in your Epicenter repository.'),
	).toBeVisible();
	await page.getByRole('link', { name: 'On this browser' }).click();
	await expect(list().locator('li[data-id]')).toHaveCount(3);
	expect(await opfsFiles(page)).toEqual(localFiles);
});
