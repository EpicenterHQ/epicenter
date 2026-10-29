/**
 * What the shell's browser tests share: the shell built as it ships, served
 * from 127.0.0.1 once per person on a port of its own, and the repository's
 * development server on Bun behind a proxy. Each person's site is its own
 * origin, so each has its own storage (Playwright's WebKit shares one
 * origin's OPFS across persistent profiles, and every person's home is
 * `me/home`), and the proxy tells them apart by the `Origin` of their
 * requests and sockets: it can take one offline while the others stay on.
 *
 * A person joins the world's synced repository by its link,
 * `/<owner>/<repository>?server=<proxy>`, syncing as themselves.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDiskRepository, serveRepository } from '@epicenter/repository/bun';
import { authenticateBearer } from '@epicenter/repository/wire';
import type { BrowserContext, BrowserType, Page } from 'playwright';

export const TIMEOUT = 90_000;
const shell = join(import.meta.dir, '..');
// The static adapter writes `build/` in the shell.
const build = join(shell, 'build');

/** Who owns the world's synced repository, as its link names them. */
export const OWNER = 'team';

/** Each first-party app's hostname, its address segment. */
export const HOSTNAMES = { files: 'files.epicenter.so', todos: 'todos.epicenter.so', honeycrisp: 'honeycrisp.epicenter.so' } as const;
export type AppName = keyof typeof HOSTNAMES;

type Data = { target: string; person: string; upstream?: WebSocket; buffered: (string | Buffer)[] };

/** Build the shell as it ships (`vite build`). */
async function buildShell() {
	const built = Bun.spawn(['bun', 'run', 'build'], { cwd: shell, stdout: 'ignore', stderr: 'pipe' });
	if ((await built.exited) !== 0) throw new Error(`The shell's build failed: ${await new Response(built.stderr).text()}`);
}

/** Serve the built shell from 127.0.0.1 on a port of its own: one origin. */
function serveSite() {
	return Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request) {
			const { pathname } = new URL(request.url);
			const file = Bun.file(join(build, pathname));
			// A single-page app: every address is the index page.
			return new Response(pathname !== '/' && (await file.exists()) ? file : Bun.file(join(build, 'index.html')));
		},
	});
}

/** Build the shell, serve a site per person, and the repository server behind a proxy. */
export async function startWorld(people: readonly string[]) {
	await buildShell();
	const sites = new Map<string, string>();
	const offline = new Set<string>();
	const clients = new Set<Bun.ServerWebSocket<Data>>();
	const statics = people.map((person) => {
		const site = serveSite();
		sites.set(person, site.url.origin);
		return site;
	});

	const dir = await mkdtemp(join(tmpdir(), 'shell-browser-'));
	const server = await openDiskRepository(join(dir, 'repo.git'));
	// A repository no other run uses.
	const repository = `shared-${crypto.randomUUID().slice(0, 8)}`;
	const served = serveRepository({
		repository,
		serverId: 'shell-browser',
		server,
		authenticate: authenticateBearer((token) => ({ user: token, role: 'writer' })),
		origins: [...sites.values()],
	});
	const upstream = new URL(served.url);

	const proxy = Bun.serve<Data>({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request, bun) {
			const origin = request.headers.get('origin') ?? '';
			const person = [...sites].find(([, url]) => url === origin)?.[0];
			if (person === undefined) return new Response('Unknown origin', { status: 403 });
			if (offline.has(person)) return new Response('Offline', { status: 503 });
			const url = new URL(request.url);
			const target = new URL(`${url.pathname}${url.search}`, upstream);
			if (url.pathname === '/socket') {
				target.protocol = 'ws:';
				if (bun.upgrade(request, { data: { target: target.href, person, buffered: [] } })) return undefined;
				return new Response('Expected a WebSocket upgrade', { status: 426 });
			}
			const headers = new Headers(request.headers);
			headers.delete('host');
			const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
			return fetch(target, { method: request.method, headers, body, redirect: 'manual' });
		},
		websocket: {
			open(client) {
				clients.add(client);
				const socket = new WebSocket(client.data.target);
				client.data.upstream = socket;
				socket.onopen = () => {
					for (const frame of client.data.buffered.splice(0)) socket.send(frame);
				};
				socket.onmessage = (event) => client.send(String(event.data));
				socket.onclose = () => client.close();
			},
			message(client, frame) {
				const socket = client.data.upstream;
				if (socket?.readyState === WebSocket.OPEN) socket.send(frame);
				else client.data.buffered.push(frame);
			},
			close(client) {
				clients.delete(client);
				client.data.upstream?.close();
			},
		},
	});

	const site = (person: string) => {
		const origin = sites.get(person);
		if (origin === undefined) throw new Error(`${person} has no site in this world`);
		return origin;
	};
	/** The synced repository's address. */
	const address = `/${OWNER}/${repository}`;
	/** The link that joins the synced repository, on `person`'s site. */
	const link = (person: string) => `${site(person)}${address}?server=${encodeURIComponent(proxy.url.href)}`;
	return {
		address,
		link,
		/** `person`'s site, at `path`. */
		url: (person: string, path = '/') => `${site(person)}${path}`,
		/** `person`'s profile on their site, opened at `path` (by default `/`, their home). */
		local: (browser: BrowserType, person: string, path = '/') => openProfile(browser, `${site(person)}${path}`),
		/** `person`'s profile with this browser's copy of the synced repository, joined by its link as them, open in `app`. */
		async open(browser: BrowserType, person: string, app: AppName) {
			const profile = await openProfile(browser, link(person));
			await joined(profile.page, person);
			await profile.page.goto(`${site(person)}${address}/${HOSTNAMES[app]}`);
			await opened(profile.page, app);
			return profile;
		},
		/** Take `person` offline, dropping their socket, or bring them back. */
		setOnline(person: string, value: boolean) {
			if (value) offline.delete(person);
			else {
				offline.add(person);
				for (const client of clients) if (client.data.person === person) client.close();
			}
		},
		/** The file's text on the server's main. */
		read: async (path: string) => server.read(path),
		async stop() {
			for (const running of statics) running.stop(true);
			proxy.stop(true);
			await served.stop();
			// Flushed and idle, so no flush timer outlives the directory.
			await server.flush();
			await server.idle();
			await rm(dir, { recursive: true, force: true });
		},
	};
}
export type World = Awaited<ReturnType<typeof startWorld>>;

/**
 * A persistent profile, as a person's browser has, opened on `url`; it
 * counts the workers its pages start (`workers(page)`), so a test can tell a
 * repository opening again from one that stayed open. `cleanup` removes it.
 */
export async function openProfile(browser: BrowserType, url: string) {
	const dir = await mkdtemp(join(tmpdir(), 'shell-profile-'));
	// Wide enough for the folders, the list and the open note side by side.
	const context = await browser.launchPersistentContext(dir, { headless: true, viewport: { width: 1400, height: 900 } });
	await context.addInitScript(() => {
		const counted = globalThis as unknown as { workers: number };
		counted.workers = 0;
		const Original = Worker;
		globalThis.Worker = class extends Original {
			constructor(...args: ConstructorParameters<typeof Worker>) {
				super(...args);
				counted.workers++;
			}
		};
	});
	const page = context.pages()[0] ?? (await context.newPage());
	page.on('pageerror', (error) => console.error('page error:', error));
	await page.goto(url);
	return profile(context, page, dir);
}

function profile(context: BrowserContext, page: Page, dir: string) {
	return {
		context,
		page,
		async cleanup() {
			await context.close();
			await rm(dir, { recursive: true, force: true });
		},
	};
}

/** How many workers `page` has started since it loaded. */
export const workers = (page: Page) => page.evaluate(() => (globalThis as unknown as { workers: number }).workers);

/** Wait for a repository's page. */
export const repositoryPage = (page: Page) => page.getByRole('list', { name: 'Apps', exact: true }).waitFor();

/**
 * On a join link: join as `account`, unless this browser already has the
 * copy (Playwright's WebKit shares one origin's storage across profiles),
 * then wait for the repository's page.
 */
export async function joined(page: Page, account: string) {
	const form = page.getByRole('form', { name: 'Join a synced repository' });
	const apps = page.getByRole('list', { name: 'Apps', exact: true });
	await form.or(apps).first().waitFor();
	if (await form.isVisible()) {
		await form.getByLabel('Sync as').fill(account);
		await form.getByRole('button', { name: 'Join' }).click();
	}
	await apps.waitFor();
}

/** Wait for `app` to show the repository: Files its folder, Todos its todos, Honeycrisp its notes. */
export async function opened(page: Page, app: AppName) {
	if (app === 'files') await page.getByRole('region', { name: 'Folder' }).waitFor();
	else if (app === 'todos') await page.getByRole('list', { name: 'Todos' }).waitFor();
	else await page.getByRole('region', { name: 'Notes' }).waitFor();
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
