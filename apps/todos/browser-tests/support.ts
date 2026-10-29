/**
 * What the Todos browser tests share: the app built as it ships, served from
 * 127.0.0.1 on a port of its own per person (so each person's site is its own
 * origin with its own storage: Playwright's WebKit shares one origin's OPFS
 * across persistent profiles), the repository's development server on Bun,
 * and a persistent profile per person.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDiskRepository, serveRepository } from '@epicenter/repository/bun';
import { authenticateBearer } from '@epicenter/repository/wire';
import type { BrowserType, Page } from 'playwright';

export const TIMEOUT = 90_000;
const app = join(import.meta.dir, '..');
const build = join(app, 'build');

/** Build Todos as it ships (`vite build`). */
export async function buildTodos() {
	const built = Bun.spawn(['bun', 'run', 'build'], { cwd: app, stdout: 'ignore', stderr: 'pipe' });
	if ((await built.exited) !== 0) throw new Error(`The Todos build failed: ${await new Response(built.stderr).text()}`);
}

/** Serve the built site from 127.0.0.1 on a port of its own: one origin. */
export function serveSite() {
	return Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request) {
			const { pathname } = new URL(request.url);
			const file = Bun.file(join(build, pathname));
			// A single-page app: every route is the index page.
			return new Response(pathname !== '/' && (await file.exists()) ? file : Bun.file(join(build, 'index.html')));
		},
	});
}

/** The development server for the repository `repository`, which pages from `origins` may call; anyone is the writer their bearer token names. */
export async function startServer(repository: string, origins: string[]) {
	const dir = await mkdtemp(join(tmpdir(), 'todos-server-'));
	const server = await openDiskRepository(join(dir, 'repo.git'));
	const served = serveRepository({
		repository,
		serverId: 'todos-browser',
		server,
		authenticate: authenticateBearer((token) => ({ user: token, role: 'writer' })),
		origins,
	});
	return {
		url: served.url,
		/** The file's text on the server's main. */
		read: (path: string) => server.read(path),
		async stop() {
			await served.stop();
			// Flushed and idle, so no flush timer outlives the directory.
			await server.flush();
			await server.idle();
			await rm(dir, { recursive: true, force: true });
		},
	};
}

/** What a person enters in the repository chooser to make a repository: nothing for one kept on this device. */
export type NewRepository = { name?: string; server?: { url: string; repository: string; account: string } };

/** Make a repository in the chooser on `page`, which opens it. */
export async function createRepository(page: Page, { name, server }: NewRepository = {}) {
	const form = page.getByRole('form', { name: 'New repository' });
	await form.waitFor();
	if (name !== undefined) await form.getByLabel('Name').fill(name);
	if (server !== undefined) {
		await form.getByLabel(/^Server/).fill(server.url);
		await form.getByLabel('Repository on the server').fill(server.repository);
		await form.getByLabel('Sync as').fill(server.account);
	}
	await form.getByRole('button', { name: 'Create' }).click();
	await opened(page);
}

/** A persistent profile, as a person's browser has, opened on `url` with a new repository made in its chooser; `cleanup` removes it. */
export async function openProfile(browser: BrowserType, url: string, repository: NewRepository = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'todos-profile-'));
	// Wide enough for the list and the open todo side by side.
	const context = await browser.launchPersistentContext(dir, { headless: true, viewport: { width: 1280, height: 800 } });
	const page = context.pages()[0] ?? (await context.newPage());
	page.on('pageerror', (error) => console.error('page error:', error));
	await page.goto(url);
	await createRepository(page, repository);
	return {
		context,
		page,
		async cleanup() {
			await context.close();
			await rm(dir, { recursive: true, force: true });
		},
	};
}

/** Wait for the page to open the repository and list the todos. */
export async function opened(page: Page) {
	await page.getByRole('list', { name: 'Todos' }).waitFor();
}

/** Poll until `check` holds. */
export async function until(check: () => Promise<boolean>, what: string, timeout = 20_000) {
	const deadline = Date.now() + timeout;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await Bun.sleep(50);
	}
}

/** The open todo's notes editor. */
export const notesOf = (page: Page) => page.getByRole('region', { name: 'Todo' }).getByRole('textbox', { name: 'Notes' });
