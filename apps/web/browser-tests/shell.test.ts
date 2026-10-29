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
 * - `/` makes your home, `me/home`, and opens it; `/` and `/me` open the same one again
 * - Todos and Honeycrisp open one repository by URL, and moving between them keeps it open
 * - A reload opens the repository and app from the URL alone
 * - Back and Forward move between repositories, each showing its own files
 * - Storage removes a copy, saying first what is only in this browser
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chromium, type Page, webkit } from 'playwright';
import { opened, repositoryPage, startWorld, TIMEOUT, type World, workers } from './support.js';

const ENGINES = [
	['chromium', chromium],
	['webkit', webkit],
] as const;

let world: World;
beforeAll(async () => {
	world = await startWorld(ENGINES.flatMap(([engine]) => ['home', 'switch', 'storage'].map((name) => `${engine}-${name}`)));
}, 180_000);
afterAll(() => world?.stop());

const apps = (page: Page) => page.getByRole('list', { name: 'Apps' });
const dataOf = (page: Page, app: string) => apps(page).getByRole('listitem').filter({ hasText: app }).getByTestId('app-data');
/** The app header's link to the repository's page. */
const toRepository = (page: Page, name: string) => page.getByRole('link', { name: `${name}: its apps and this browser's other repositories` });

async function addTodo(page: Page, title: string) {
	await page.getByLabel('New todo title').fill(title);
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await page.getByRole('checkbox', { name: `Complete ${title}` }).waitFor();
}

for (const [engine, browser] of ENGINES) {
	describe(engine, () => {
		test(
			'/ makes your home and opens it, and / and /me open the same one again',
			async () => {
				const person = `${engine}-home`;
				const { page, cleanup } = await world.local(browser, person);
				try {
					await repositoryPage(page);
					expect(new URL(page.url()).pathname).toBe('/me/home');
					await page.getByRole('heading', { name: 'Home', exact: true }).waitFor();
					await expect(dataOf(page, 'Todos').innerText()).resolves.toBe('No data yet');
					await expect(dataOf(page, 'Honeycrisp').innerText()).resolves.toBe('No data yet');

					for (const path of ['/', '/me']) {
						await page.goto(world.url(person, path));
						await repositoryPage(page);
						expect(new URL(page.url()).pathname).toBe('/me/home');
					}
					await page.goto(world.url(person, '/-/storage'));
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
			'Todos and Honeycrisp share one open repository by URL; a reload restores it, and Back and Forward move between repositories',
			async () => {
				const person = `${engine}-switch`;
				const { page, cleanup } = await world.local(browser, person, '/me/home/todos');
				try {
					await opened(page, 'todos');
					await addTodo(page, 'Water plants');
					// Making home on first use opened and closed it once; from here on, one worker serves every app.
					const started = await workers(page);

					// The repository's page, then Honeycrisp, then back: one repository, never opened again.
					await toRepository(page, 'Home').click();
					await repositoryPage(page);
					await dataOf(page, 'Todos').getByText('Has data').waitFor();
					await expect(dataOf(page, 'Honeycrisp').innerText()).resolves.toBe('No data yet');
					await apps(page).getByRole('link', { name: 'Honeycrisp' }).click();
					await opened(page, 'honeycrisp');
					expect(new URL(page.url()).pathname).toBe('/me/home/honeycrisp');
					await page.getByRole('button', { name: 'New note' }).click();
					await page.getByLabel('Title', { exact: true }).fill('Shell note');
					await page.getByRole('region', { name: 'Notes' }).locator('[data-note]', { hasText: 'Shell note' }).waitFor();
					await page.goBack();
					await dataOf(page, 'Honeycrisp').getByText('Has data').waitFor();
					await page.goBack();
					await page.getByRole('checkbox', { name: 'Complete Water plants' }).waitFor();
					expect(await workers(page)).toBe(started);

					// A reload opens the repository and the app from the URL alone.
					await page.reload();
					await page.getByRole('checkbox', { name: 'Complete Water plants' }).waitFor();
					await page.goto(world.url(person, '/me/home/honeycrisp'));
					await page.getByRole('region', { name: 'Notes' }).locator('[data-note]', { hasText: 'Shell note' }).waitFor();

					// A second repository, made in Storage, has its own todos.
					await page.goto(world.url(person, '/-/storage'));
					const form = page.getByRole('form', { name: 'New repository' });
					await form.getByLabel('Name').fill('Work');
					await form.getByRole('button', { name: 'Create' }).click();
					await repositoryPage(page);
					expect(new URL(page.url()).pathname).toBe('/me/work');
					await apps(page).getByRole('link', { name: 'Todos' }).click();
					await opened(page, 'todos');
					await addTodo(page, 'Work item');

					// To home through the repository's page: its other repositories.
					await toRepository(page, 'Work').click();
					await page.getByRole('region', { name: 'Other repositories' }).getByRole('link', { name: 'Home (home)' }).click();
					await repositoryPage(page);
					await apps(page).getByRole('link', { name: 'Todos' }).click();
					await page.getByRole('checkbox', { name: 'Complete Water plants' }).waitFor();
					await expect(page.getByRole('checkbox', { name: 'Complete Work item' }).count()).resolves.toBe(0);

					// Back to Work's todos, and Forward to home's.
					for (let step = 0; step < 3; step++) await page.goBack();
					expect(new URL(page.url()).pathname).toBe('/me/work/todos');
					await page.getByRole('checkbox', { name: 'Complete Work item' }).waitFor();
					await expect(page.getByRole('checkbox', { name: 'Complete Water plants' }).count()).resolves.toBe(0);
					for (let step = 0; step < 3; step++) await page.goForward();
					expect(new URL(page.url()).pathname).toBe('/me/home/todos');
					await page.getByRole('checkbox', { name: 'Complete Water plants' }).waitFor();
					await expect(page.getByTestId('repository-status').count()).resolves.toBe(0);
				} finally {
					await cleanup();
				}
			},
			TIMEOUT,
		);

		test(
			'Storage removes a copy, saying first what is only in this browser',
			async () => {
				const person = `${engine}-storage`;
				const { page, cleanup } = await world.local(browser, person, '/-/storage');
				try {
					const form = page.getByRole('form', { name: 'New repository' });
					await form.getByLabel('Name').fill('Spare');
					await form.getByRole('button', { name: 'Create' }).click();
					await repositoryPage(page);
					await apps(page).getByRole('link', { name: 'Todos' }).click();
					await opened(page, 'todos');
					await addTodo(page, 'Only here');

					// Leaving the repository closes it, so this tab can remove it.
					await toRepository(page, 'Spare').click();
					await page.getByRole('region', { name: 'Other repositories' }).getByRole('link', { name: 'Storage' }).click();
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
	});
}
