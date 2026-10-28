/**
 * Todos Browser Smoke Test
 *
 * Builds Todos as it ships (`vite build`), serves the static site from
 * 127.0.0.1, and drives it in Chromium and WebKit with persistent profiles:
 * the page opens the repository through the browser host, so todos live in
 * SQLite in OPFS, owned by the tab's worker. No server is set, so nothing
 * syncs.
 *
 * Key behaviors:
 * - Create, edit, complete, and delete a todo
 * - Each survives a reload
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page, webkit } from 'playwright';

const app = join(import.meta.dir, '..');
const build = join(app, 'build');
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
	const built = Bun.spawn(['bun', 'run', 'build'], { cwd: app, stdout: 'ignore', stderr: 'pipe', env: { ...process.env, VITE_TODOS_SERVER: '' } });
	if ((await built.exited) !== 0) throw new Error(`The Todos build failed: ${await new Response(built.stderr).text()}`);
	server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request) {
			const { pathname } = new URL(request.url);
			const file = Bun.file(join(build, pathname));
			// A single-page app: every route is the index page.
			return new Response(pathname !== '/' && (await file.exists()) ? file : Bun.file(join(build, 'index.html')));
		},
	});
}, 120_000);
afterAll(() => server?.stop(true));

/** Wait for the page to open the repository and list the todos. */
async function opened(page: Page) {
	await page.getByRole('list', { name: 'Todos' }).waitFor();
}

for (const [engine, browser] of [
	['chromium', chromium],
	['webkit', webkit],
] as const) {
	describe(engine, () => {
		test(
			'create, edit, complete, and delete a todo, each surviving a reload',
			async () => {
				const dir = await mkdtemp(join(tmpdir(), 'todos-smoke-'));
				// Wide enough for the list and the open todo side by side.
				const context = await browser.launchPersistentContext(dir, { headless: true, viewport: { width: 1280, height: 800 } });
				try {
					const page = context.pages()[0] ?? (await context.newPage());
					page.on('pageerror', (error) => console.error('page error:', error));
					await page.goto(server.url.href);
					await opened(page);
					await expect(page.getByText('No todos yet').isVisible()).resolves.toBe(true);

					await page.getByLabel('New todo title').fill('Buy milk');
					await page.getByRole('button', { name: 'Add', exact: true }).click();
					const title = page.getByLabel('Title', { exact: true });
					await expect(title.inputValue()).resolves.toBe('Buy milk');

					await title.fill('Buy oat milk');
					await page.getByLabel('Notes').fill('Two litres');
					await page.getByRole('checkbox', { name: 'Done' }).click();
					await page.getByRole('checkbox', { name: 'Reopen Buy oat milk' }).waitFor();

					await page.reload();
					await opened(page);
					await expect(title.inputValue()).resolves.toBe('Buy oat milk');
					await expect(page.getByLabel('Notes').inputValue()).resolves.toBe('Two litres');
					await expect(page.getByRole('checkbox', { name: 'Done' }).getAttribute('aria-checked')).resolves.toBe('true');
					await expect(page.getByRole('checkbox', { name: 'Reopen Buy oat milk' }).getAttribute('aria-checked')).resolves.toBe('true');

					await page.getByRole('button', { name: 'Delete', exact: true }).click();
					await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
					await page.getByText('No todos yet').waitFor();

					await page.reload();
					await opened(page);
					await page.getByText('No todos yet').waitFor();
					await expect(page.getByRole('checkbox', { name: 'Reopen Buy oat milk' }).count()).resolves.toBe(0);
				} finally {
					await context.close();
					await rm(dir, { recursive: true, force: true });
				}
			},
			90_000,
		);
	});
}
