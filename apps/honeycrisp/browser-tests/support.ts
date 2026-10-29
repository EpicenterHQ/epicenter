/**
 * What the Honeycrisp browser tests share: the app built as it ships, served
 * from 127.0.0.1 once per person on a port of its own, and a repository
 * server behind a router. Each person's site is its own origin, so each has
 * its own storage, and the router tells them apart by the `Origin` of their
 * WebSocket: it connects each as its own user, and can take one offline
 * while the others stay on.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveRepository } from '@epicenter/repository/legacy-ws/server';
import type { BrowserType, Page } from 'playwright';

export const TIMEOUT = 90_000;
const app = join(import.meta.dir, '..');

type Data = { target: string; person: string; upstream?: WebSocket; buffered: (string | Buffer)[] };

/** Build Honeycrisp against a router, serve a site per person, and a repository behind the router. */
export async function startWorld(people: readonly string[]) {
	const dir = await mkdtemp(join(tmpdir(), 'honeycrisp-browser-'));
	const served = await serveRepository({ dir: join(dir, 'repo.git') });
	const sites = new Map<string, string>();
	const offline = new Set<string>();
	const clients = new Set<Bun.ServerWebSocket<Data>>();
	const router = Bun.serve<Data>({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request, server) {
			const origin = request.headers.get('origin') ?? '';
			const person = [...sites].find(([, url]) => url === origin)?.[0];
			if (person === undefined) return new Response('Unknown origin', { status: 403 });
			if (offline.has(person)) return new Response('Offline', { status: 503 });
			const target = new URL(served.url);
			target.search = new URL(request.url).search;
			target.searchParams.set('user', person);
			if (server.upgrade(request, { data: { target: target.href, person, buffered: [] } })) return undefined;
			return new Response('Expected a WebSocket upgrade', { status: 426 });
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

	// The static adapter always writes `build/` in the app.
	const build = join(app, 'build');
	const built = Bun.spawn(['bun', 'run', 'build'], {
		cwd: app,
		stdout: 'ignore',
		stderr: 'pipe',
		env: { ...process.env, VITE_HONEYCRISP_SERVER: `ws://127.0.0.1:${router.port}/` },
	});
	if ((await built.exited) !== 0) throw new Error(`The Honeycrisp build failed: ${await new Response(built.stderr).text()}`);
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
	const agent = served.repository.connect({ device: 'agent', user: 'agent' });
	let agentBatches = 0;
	return {
		/** The site `person` opens. */
		url: (person: string) => `${sites.get(person)}/`,
		/** Take `person` offline, dropping their connection, or bring them back. */
		setOnline(person: string, value: boolean) {
			if (value) offline.delete(person);
			else {
				offline.add(person);
				for (const client of clients) if (client.data.person === person) client.close();
			}
		},
		/** The note's text as the server holds it. */
		read: (path: string) => served.repository.read(path),
		/**
		 * Create a file on the server as an agent would, with any text: one
		 * whose frontmatter does not parse included, as Git can hold one.
		 */
		async createFile(path: string, text: string) {
			const outcome = await agent.push({
				device: 'agent',
				n: ++agentBatches,
				seq: served.repository.sequence(),
				policy: 'refuse',
				changes: [{ kind: 'write', path, base: null, text }],
			});
			if (outcome.kind !== 'applied') throw new Error(`The server did not create ${path}: ${JSON.stringify(outcome)}`);
		},
		async stop() {
			for (const site of statics) site.stop(true);
			router.stop(true);
			await served.stop();
			await rm(dir, { recursive: true, force: true });
		},
	};
}
export type World = Awaited<ReturnType<typeof startWorld>>;

/** A persistent profile, as a person's browser has, opened on `url`; `cleanup` removes it. */
export async function openProfile(browser: BrowserType, url: string) {
	const dir = await mkdtemp(join(tmpdir(), 'honeycrisp-profile-'));
	// Wide enough for the folders, the list and the open note side by side.
	const context = await browser.launchPersistentContext(dir, { headless: true, viewport: { width: 1400, height: 900 } });
	const page = context.pages()[0] ?? (await context.newPage());
	page.on('pageerror', (error) => console.error('page error:', error));
	await page.goto(url);
	await opened(page);
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
