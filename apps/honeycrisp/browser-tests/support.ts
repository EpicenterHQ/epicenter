/**
 * What the Honeycrisp browser tests share: the app built as it ships, served
 * from 127.0.0.1 once per person on a port of its own, and the repository's
 * development server on Bun behind a proxy. Each person's site is its own
 * origin, so each has its own storage (Playwright's WebKit shares one
 * origin's OPFS across persistent profiles), and the proxy tells them apart
 * by the `Origin` of their requests and sockets: it can take one offline
 * while the others stay on.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDiskRepository, serveRepository } from '@epicenter/repository/bun';
import { authenticateBearer } from '@epicenter/repository/wire';
import type { BrowserContext, BrowserType, Page } from 'playwright';

export const TIMEOUT = 90_000;
const app = join(import.meta.dir, '..');

type Data = { target: string; person: string; upstream?: WebSocket; buffered: (string | Buffer)[] };

/** Build Honeycrisp, serve a site per person, and the repository server behind a proxy. */
export async function startWorld(people: readonly string[]) {
	const sites = new Map<string, string>();
	const offline = new Set<string>();
	const clients = new Set<Bun.ServerWebSocket<Data>>();
	// The static adapter always writes `build/` in the app.
	const build = join(app, 'build');
	const statics = people.map((person) => {
		const site = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			async fetch(request) {
				const { pathname } = new URL(request.url);
				const file = Bun.file(join(build, pathname));
				// A single-page app: every route is the index page.
				return new Response(pathname !== '/' && (await file.exists()) ? file : Bun.file(join(build, 'index.html')));
			},
		});
		sites.set(person, site.url.origin);
		return site;
	});

	const dir = await mkdtemp(join(tmpdir(), 'honeycrisp-browser-'));
	const server = await openDiskRepository(join(dir, 'repo.git'));
	// A repository no other run uses: Playwright's WebKit keeps one origin's storage across profiles.
	const repository = `honeycrisp-${crypto.randomUUID().slice(0, 8)}`;
	const served = serveRepository({
		repository,
		serverId: 'honeycrisp-browser',
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

	const built = Bun.spawn(['bun', 'run', 'build'], { cwd: app, stdout: 'ignore', stderr: 'pipe' });
	if ((await built.exited) !== 0) throw new Error(`The Honeycrisp build failed: ${await new Response(built.stderr).text()}`);
	const url = (person: string) => `${sites.get(person)}/`;
	return {
		/** The site `person` opens. */
		url,
		/** `person`'s profile on their site, with a replica of the repository made in the chooser, syncing as them through the proxy. */
		open: (browser: BrowserType, person: string) => openProfile(browser, url(person), { url: proxy.url.href, repository, account: person }),
		/** Take `person` offline, dropping their socket, or bring them back. */
		setOnline(person: string, value: boolean) {
			if (value) offline.delete(person);
			else {
				offline.add(person);
				for (const client of clients) if (client.data.person === person) client.close();
			}
		},
		/** The note's text on the server's main. */
		read: async (path: string) => server.read(path),
		async stop() {
			for (const site of statics) site.stop(true);
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
 * A persistent profile, as a person's browser has, opened on `url`, with a
 * repository made in the chooser (synced with `server`, if given); `cleanup`
 * removes it.
 */
export async function openProfile(browser: BrowserType, url: string, server?: { url: string; repository: string; account: string }) {
	const dir = await mkdtemp(join(tmpdir(), 'honeycrisp-profile-'));
	// Wide enough for the folders, the list and the open note side by side.
	const context = await browser.launchPersistentContext(dir, { headless: true, viewport: { width: 1400, height: 900 } });
	const page = context.pages()[0] ?? (await context.newPage());
	page.on('pageerror', (error) => console.error('page error:', error));
	await page.goto(url);
	const form = page.getByRole('form', { name: 'New repository' });
	await form.waitFor();
	// Playwright's WebKit shares one origin's storage across profiles, so this person's replica from an earlier profile may be listed: it is theirs, and opens.
	const theirs = page.getByRole('listitem').filter({ hasText: server === undefined ? 'Only on this device' : `as ${server.account}` });
	if (server !== undefined && (await theirs.count()) > 0) {
		await theirs.first().getByRole('button', { name: 'Open' }).click();
		await opened(page);
		return profile(context, page, dir);
	}
	if (server !== undefined) {
		await form.getByLabel(/^Server/).fill(server.url);
		await form.getByLabel('Repository on the server').fill(server.repository);
		await form.getByLabel('Sync as').fill(server.account);
	}
	await form.getByRole('button', { name: 'Create' }).click();
	await opened(page);
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

/** Wait for the page to open the repository and list the notes. */
export async function opened(page: Page) {
	await page.getByRole('region', { name: 'Notes' }).waitFor();
}
