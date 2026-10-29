/**
 * Shell Browser Tests
 *
 * The built shell in Chromium and WebKit with persistent profiles, each
 * test on a site (an origin) of its own: every person's home is `me/home`,
 * and Playwright's WebKit shares one origin's storage across profiles.
 * Each page counts the workers it starts, so a repository that stayed open
 * is told from one that opened again.
 *
 * Key behaviors:
 * - `/` opens `/me`: your repositories, installed apps, storage and account; home is made when first opened
 * - Apps are addressed by hostname and share one open repository; switching apps never opens it again
 * - A reload restores the repository, the app and the app's path from the URL alone
 * - Back and Forward move between repositories, each showing its own files
 * - Storage, on `/me`, removes a copy, saying first what is only in this browser
 * - A link to an app that is not installed offers Install and Open in Files
 * - An app segment that is not a hostname is not found
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chromium, type Page, webkit } from 'playwright';
import { HOSTNAMES, opened, repositoryPage, startWorld, TIMEOUT, type World, workers } from './support.js';

const ENGINES = [
	['chromium', chromium],
	['webkit', webkit],
] as const;

let world: World;
beforeAll(async () => {
	world = await startWorld(ENGINES.flatMap(([engine]) => ['home', 'switch', 'storage', 'missing'].map((name) => `${engine}-${name}`)));
}, 180_000);
afterAll(() => world?.stop());

/** The apps a repository's page lists: those with data in it, and Files. */
const apps = (page: Page) => page.getByRole('list', { name: 'Apps', exact: true });
/** The installed apps a repository's page offers to start there. */
const others = (page: Page) => page.getByRole('region', { name: 'Other installed apps' });
/** The repository bar's link to the repository's page. */
const toRepository = (page: Page, name: string) => page.getByRole('link', { name: `${name}: this repository's page` });
const pathOf = (page: Page) => new URL(page.url()).pathname;

async function addTodo(page: Page, title: string) {
	await page.getByLabel('New todo title').fill(title);
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await page.getByRole('checkbox', { name: `Complete ${title}` }).waitFor();
}

for (const [engine, browser] of ENGINES) {
	describe(engine, () => {
		test(
			'/ opens /me, which lists your repositories, installed apps, storage and account; home is made when first opened',
			async () => {
				const person = `${engine}-home`;
				const { page, cleanup } = await world.local(browser, person);
				try {
					await page.getByRole('heading', { name: 'You', exact: true }).waitFor();
					expect(pathOf(page)).toBe('/me');
					const installed = page.getByRole('list', { name: 'Apps installed in this browser' });
					// A new device starts with Files, Todos and Honeycrisp installed.
					await expect(installed.getByRole('listitem').locator('code').filter({ hasText: /\.epicenter\.so$/ }).allInnerTexts()).resolves.toEqual([HOSTNAMES.files, HOSTNAMES.todos, HOSTNAMES.honeycrisp]);
					// Each install pins its bundle by hash.
					for (const hash of await installed.getByTestId('app-hash').allInnerTexts()) expect(hash).toMatch(/^sha256-[0-9a-f]{12}/);
					await page.getByRole('region', { name: 'Account' }).getByText('Accounts are not built yet').waitFor();

					await page.getByRole('region', { name: 'Repositories' }).getByRole('link', { name: 'Home (home)' }).click();
					await repositoryPage(page);
					expect(pathOf(page)).toBe('/me/home');
					await page.getByRole('heading', { name: 'Home', exact: true }).waitFor();
					// A new home has no app's data: it lists Files, and offers the others to start here.
					await apps(page).getByRole('link', { name: 'Files' }).waitFor();
					await others(page).getByRole('link', { name: 'Todos' }).waitFor();
					await others(page).getByRole('link', { name: 'Honeycrisp' }).waitFor();
					await expect(apps(page).getByRole('link', { name: 'Todos' }).count()).resolves.toBe(0);

					await page.goto(world.url(person, '/me'));
					const copies = page.getByRole('list', { name: 'Copies in this browser' }).getByRole('listitem');
					await copies.first().waitFor();
					await expect(copies.count()).resolves.toBe(1);
					await expect(copies.first().innerText()).resolves.toContain('Home (home)');
				} finally {
					await cleanup();
				}
			},
			TIMEOUT,
		);

		test(
			'apps share one open repository by hostname; a reload restores the app and its path, and Back and Forward move between repositories',
			async () => {
				const person = `${engine}-switch`;
				const { page, cleanup } = await world.local(browser, person, `/me/home/${HOSTNAMES.todos}`);
				try {
					await opened(page, 'todos');
					await addTodo(page, 'Water plants');
					// The open todo is Todos' path.
					expect(pathOf(page)).toMatch(new RegExp(`^/me/home/${HOSTNAMES.todos}/[^/]+$`));
					// Making home on first use opened and closed it once; from here on, one worker serves every app.
					const started = await workers(page);

					// The repository's page, then Honeycrisp, then back: one repository, never opened again.
					await toRepository(page, 'Home').click();
					await repositoryPage(page);
					await apps(page).getByRole('link', { name: 'Todos' }).waitFor();
					await others(page).getByRole('link', { name: 'Honeycrisp' }).click();
					await opened(page, 'honeycrisp');
					expect(pathOf(page)).toBe(`/me/home/${HOSTNAMES.honeycrisp}`);
					await page.getByRole('button', { name: 'New note' }).click();
					await page.getByLabel('Title', { exact: true }).fill('Shell note');
					await page.getByRole('region', { name: 'Notes' }).locator('[data-note]', { hasText: 'Shell note' }).waitFor();
					const notePath = pathOf(page);
					expect(notePath).toMatch(new RegExp(`^/me/home/${HOSTNAMES.honeycrisp}/notes/[^/]+\\.md$`));
					// The open note is Honeycrisp's path: Back closes it, then leaves Honeycrisp.
					await page.goBack();
					await page.getByText('No note selected').waitFor();
					await page.goBack();
					await apps(page).getByRole('link', { name: 'Honeycrisp' }).waitFor();
					await page.goBack();
					await page.getByRole('checkbox', { name: 'Complete Water plants' }).waitFor();
					expect(await workers(page)).toBe(started);

					// A reload opens the repository, the app and its path from the URL alone.
					await page.reload();
					await page.getByRole('region', { name: 'Todo' }).getByLabel('Title', { exact: true }).waitFor();
					await expect(page.getByLabel('Title', { exact: true }).inputValue()).resolves.toBe('Water plants');
					await page.goto(world.url(person, notePath));
					await page.getByRole('region', { name: 'Note' }).getByLabel('Title', { exact: true }).waitFor();
					await expect(page.getByLabel('Title', { exact: true }).inputValue()).resolves.toBe('Shell note');

					// A second repository, made on /me, has its own todos.
					await page.goto(world.url(person, '/me'));
					const form = page.getByRole('form', { name: 'New repository' });
					await form.getByLabel('Name').fill('Work');
					await form.getByRole('button', { name: 'Create' }).click();
					await repositoryPage(page);
					expect(pathOf(page)).toBe('/me/work');
					await others(page).getByRole('link', { name: 'Todos' }).click();
					await opened(page, 'todos');
					await addTodo(page, 'Work item');

					// To home through the repository's page and your repositories.
					await toRepository(page, 'Work').click();
					await page.getByRole('link', { name: 'Your repositories' }).click();
					await page.getByRole('region', { name: 'Repositories' }).getByRole('link', { name: 'Home (home)' }).click();
					await repositoryPage(page);
					await apps(page).getByRole('link', { name: 'Todos' }).click();
					await page.getByRole('checkbox', { name: 'Complete Water plants' }).waitFor();
					await expect(page.getByRole('checkbox', { name: 'Complete Work item' }).count()).resolves.toBe(0);

					// Back to Work's todos, and Forward to home's.
					for (let step = 0; step < 4; step++) await page.goBack();
					expect(pathOf(page)).toMatch(new RegExp(`^/me/work/${HOSTNAMES.todos}/[^/]+$`));
					await page.getByRole('checkbox', { name: 'Complete Work item' }).waitFor();
					await expect(page.getByRole('checkbox', { name: 'Complete Water plants' }).count()).resolves.toBe(0);
					for (let step = 0; step < 4; step++) await page.goForward();
					expect(pathOf(page)).toBe(`/me/home/${HOSTNAMES.todos}`);
					await page.getByRole('checkbox', { name: 'Complete Water plants' }).waitFor();
					await expect(page.getByTestId('repository-status').count()).resolves.toBe(0);
					await expect(page.getByTestId('repository-sync').innerText()).resolves.toBe('On this device');
				} finally {
					await cleanup();
				}
			},
			TIMEOUT,
		);

		test(
			'Storage on /me removes a copy, saying first what is only in this browser',
			async () => {
				const person = `${engine}-storage`;
				const { page, cleanup } = await world.local(browser, person, '/me');
				try {
					const form = page.getByRole('form', { name: 'New repository' });
					await form.getByLabel('Name').fill('Spare');
					await form.getByRole('button', { name: 'Create' }).click();
					await repositoryPage(page);
					await others(page).getByRole('link', { name: 'Todos' }).click();
					await opened(page, 'todos');
					await addTodo(page, 'Only here');

					// Leaving the repository closes it, so this tab can remove it.
					await toRepository(page, 'Spare').click();
					await page.getByRole('link', { name: 'Your repositories' }).click();
					const row = page.getByRole('list', { name: 'Copies in this browser' }).getByRole('listitem').filter({ hasText: 'Spare' });
					await row.getByRole('button', { name: 'Remove Spare' }).click();
					await row.getByRole('button', { name: 'Remove', exact: true }).click();
					await row.getByRole('alert').filter({ hasText: '1 file(s) are only in this browser' }).waitFor();
					await row.getByRole('button', { name: 'Remove anyway' }).click();
					await row.waitFor({ state: 'detached' });

					await page.reload();
					await page.getByRole('form', { name: 'New repository' }).waitFor();
					await expect(row.count()).resolves.toBe(0);
					await page.goto(world.url(person, '/me/spare'));
					await page.getByRole('heading', { name: '/me/spare is not in this browser' }).waitFor();
				} finally {
					await cleanup();
				}
			},
			TIMEOUT,
		);

		test(
			'a link to an app that is not installed offers Install and Open in Files, and a segment that is not a hostname is not found',
			async () => {
				const person = `${engine}-missing`;
				const { page, cleanup } = await world.local(browser, person, '/me/home/recipes.pages.dev/notes/pasta.md');
				try {
					const missing = page.getByRole('main', { name: 'App not installed' });
					await missing.getByRole('heading', { name: 'recipes.pages.dev is not installed' }).waitFor();
					await missing.getByRole('button', { name: 'Install recipes.pages.dev' }).click();
					await missing.getByRole('alert').getByText('Installing an app from recipes.pages.dev is not built yet', { exact: false }).waitFor();
					await missing.getByRole('link', { name: 'Open in Files' }).click();
					await page.waitForURL((url) => url.pathname === `/me/home/${HOSTNAMES.files}/notes/pasta.md`);
					await opened(page, 'files');
					await page.getByRole('region', { name: 'File' }).getByText('No file is at notes/pasta.md').waitFor();

					// An app's old address, by a short name, is no address: an app is its hostname.
					await page.goto(world.url(person, '/me/home/todos'));
					await page.getByRole('heading', { name: 'Nothing is at /me/home/todos' }).waitFor();
				} finally {
					await cleanup();
				}
			},
			TIMEOUT,
		);
	});
}
