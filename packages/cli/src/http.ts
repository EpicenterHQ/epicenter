/**
 * `epicenter serve` over HTTP (ADR-0864): one address for people and agents.
 *
 * ```txt
 * POST /                MCP, stateless JSON
 * GET  /                the launcher; 405 when asked for an event stream (MCP)
 * GET  /<app>/...       the app's UI, ui/dist/, as static files
 * GET  /<app>           308 to /<app>/
 * POST /<app>/<action>  run the action for the UI; JSON lines (`callResponse`)
 * ```
 *
 * `serve` runs every call itself, from the app's code as it is on disk when
 * the call arrives (`home.ts`, `run.ts`).
 *
 * Every path of the server's own starts with `.`, which no app name can, so
 * no name is reserved for the server.
 *
 * `serve` has no sign-in: who reaches it is its host's decision (ADR-0883).
 * It trusts every request it answers, so the address it listens on is its
 * access control: 127.0.0.1 unless `--host` names another loopback address
 * or one of the tailnet's (`listenProblem`), never a wildcard or a public
 * address. It answers only a `Host` that is a loopback name, an IP literal,
 * or a `*.ts.net` name, which a DNS rebinding name is not; the client writes
 * that header, so it guards against rebinding and decides nothing about who
 * may call. It refuses a request a Tailscale Funnel or Cloudflare Tunnel
 * delivered. Both set their header on every request, and Funnel removes a
 * copy the client sent, so a tunnel aimed at this port by mistake reaches
 * only refusals.
 *
 * A write call commits pending data before it answers (`run.ts`).
 * Everything else reaches history and the backup on the server's clock: when
 * it starts, every 5 minutes, and when it stops, it does for each app what
 * `epicenter sync <app>` does, then the same for the Epicenter's own
 * repository (ADR-0884), snapshotting what is pending as changed
 * outside epicenter and pushing to `origin` when there is something to push.
 * The clock's interval is how old an unbacked change can get, not a guess at
 * when an edit is done. A tick skips an idle app and never waits for a call:
 * it skips an app whose lock a call holds (`lock.ts`). The call's commit,
 * or the next tick, takes what the call wrote.
 */

import { realpath, stat } from 'node:fs/promises';
import { BlockList, isIP } from 'node:net';
import { basename, isAbsolute, join, sep } from 'node:path';
import { isName } from '@epicenter/app';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { extractErrorMessage } from 'wellcrafted/error';
import { linkAppPackage } from './app-package.ts';
import { CliError } from './errors.ts';
import { chooseApps, homeEntries, loadHomeApp } from './home.ts';
import { createMcpServer } from './mcp.ts';
import { type Answer, writeErr } from './output.ts';
import { epicenterDir } from './root.ts';
import { callAction } from './run.ts';
import { nothingToBackUp } from './snapshot.ts';
import { type Synced, syncEpicenter, syncFailures, syncOne } from './sync.ts';
import { createUiRefresher, UI_DIST } from './ui.ts';

/** How often `serve` backs up every app. */
const BACKUP_EVERY_MS = 5 * 60_000;

/** How long `serve` waits for the backup it runs when it stops. */
const BACKUP_WAIT_MS = 10_000;

/** Headers a tunnel adds: Tailscale Funnel's, and Cloudflare Tunnel's. */
const TUNNEL_HEADERS = ['tailscale-funnel-request', 'cf-connecting-ip'];

/** Whether `work` finished within `ms`; it runs on after `false`. */
function within(ms: number, work: Promise<unknown>) {
	const { promise: late, resolve } = Promise.withResolvers<false>();
	setTimeout(() => resolve(false), ms).unref();
	return Promise.race([work.then(() => true as const), late]);
}

const escapeHtml = (text: string) =>
	text.replace(
		/[&<>"']/g,
		(char) =>
			({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
				char
			] as string,
	);

/** The page at `/`: each app with a UI, its icon, name, and description, linking to `/<app>/`. */
function launcherPage(
	name: string,
	apps: { name: string; description: string; icon: boolean }[],
) {
	const items = apps
		.map(({ name, description, icon }) => {
			const href = `/${encodeURIComponent(name)}/`;
			const image = icon
				? `<img src="${href}icon.png" alt="" width="56" height="56">`
				: `<span class="blank">${escapeHtml(name.slice(0, 1).toUpperCase())}</span>`;
			return `<li><a href="${href}">${image}<span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(description)}</small></span></a></li>`;
		})
		.join('');
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="color-scheme" content="light dark"><title>${escapeHtml(name)}</title><style>
:root{--bg:#fafafa;--fg:#0a0a0a;--muted:#6b6b6b;--card:#fff;--line:#e5e5e5}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#f5f5f5;--muted:#a0a0a0;--card:#1e1e1e;--line:#2c2c2c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:max(24px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left))}
main{max-width:560px;margin:0 auto}h1{font-size:28px;margin:8px 0 20px;letter-spacing:-.02em}
ul{list-style:none;margin:0;padding:0;display:grid;gap:10px}
a{display:flex;gap:14px;align-items:center;padding:12px;border:1px solid var(--line);border-radius:16px;background:var(--card);color:inherit;text-decoration:none}
a:active{transform:scale(.99)}img,.blank{width:56px;height:56px;border-radius:13px;flex:none}
.blank{display:grid;place-items:center;background:var(--line);font-weight:600;font-size:22px}
strong{display:block;font-size:17px;text-transform:capitalize}small{display:block;color:var(--muted);font-size:14px}
p{color:var(--muted)}
</style></head><body><main><h1>${escapeHtml(name)}</h1>${items ? `<ul>${items}</ul>` : '<p>No app here has a UI yet.</p>'}</main></body></html>`;
}

/** What the listener serves. */
type Site = {
	/** Answer an MCP request. */
	mcp(request: Request): Promise<Response>;
	/** The launcher at `GET /`, or 405 when MCP asks for an event stream. */
	launcher(request: Request): Promise<Response>;
	/** `GET /<app>` and `/<app>/<path>`: the app's UI, or 404. */
	ui(request: Request): Promise<Response>;
	/** `POST /<app>/<action>`: run the action for the app's UI, or 404. */
	call(request: Request): Promise<Response>;
};

/** One line of a call's response: a JSON value and a newline. */
const line = (value: unknown) =>
	new TextEncoder().encode(`${JSON.stringify(value)}\n`);

/**
 * Run the action `POST /<app>/<action>` names, its words joined by `.`
 * (`/tasks/add`, `/vocab/words.add`), with the request's body as its whole
 * input. The response is JSON lines: `{"yielded": value}` for each value the
 * action yields, as it yields it, then `{"answer": answer}`, the same answer
 * `--json` prints. A caller that stops reading stops the action at its next
 * yield; what it wrote is committed.
 */
async function callResponse(request: Request): Promise<Response> {
	const match = /^\/([^/]+)\/([^/]+)$/.exec(new URL(request.url).pathname);
	if (!match) return notFound();
	const [, app = '', action = ''] = match;
	const words = action.split('.');
	if (!isName(app) || !words.every(isName)) return notFound();
	let input: unknown;
	try {
		input = await request.json();
	} catch {
		input = undefined;
	}
	const stopped = new AbortController();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			void (async () => {
				let answer: Answer;
				try {
					answer = await callAction(app, words.join(' '), input, {
						onYield: (value) => {
							if (!stopped.signal.aborted)
								controller.enqueue(line({ yielded: value }));
						},
						signal: stopped.signal,
					});
				} catch (cause) {
					answer = { error: CliError.Internal({ cause }).error };
				}
				if (stopped.signal.aborted) return;
				controller.enqueue(line({ answer }));
				controller.close();
			})();
		},
		cancel() {
			stopped.abort();
		},
	});
	return new Response(body, {
		headers: {
			'content-type': 'application/x-ndjson',
			'cache-control': 'no-store',
		},
	});
}

const notFound = () => new Response('Not found', { status: 404 });

/** How long a page load waits for a UI's first build before answering 404. */
const FIRST_BUILD_WAIT_MS = 60_000;

async function exists(path: string) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** The private listener's site: MCP, the launcher, and each app's UI and actions. */
function createSite(refreshUi: (app: string, folder: string) => unknown): Site {
	const uiFile = async (app: string, path: string) => {
		if (!isName(app)) return notFound();
		const [entry] = (await chooseApps(app)).data ?? [];
		if (!entry) return notFound();
		let decoded: string;
		try {
			decoded = decodeURIComponent(path);
		} catch {
			return notFound();
		}
		if (
			decoded.includes('\\') ||
			isAbsolute(decoded) ||
			// `.` and `..`, and the build's own stamp: never part of a UI.
			decoded.split('/').some((part) => part.startsWith('.'))
		)
			return notFound();
		// A page load, not each of its files, checks that the UI is of its sources now.
		// A UI that has never built waits for its first build, up to a minute;
		// after that, the last good build answers while the next one runs.
		if (decoded === '' || decoded === 'index.html') {
			const refreshed = refreshUi(entry.entry, entry.realPath);
			if (!(await exists(join(entry.realPath, UI_DIST, 'index.html')))) {
				let timer: Timer | undefined;
				await Promise.race([
					refreshed,
					new Promise((resolve) => {
						timer = setTimeout(resolve, FIRST_BUILD_WAIT_MS);
					}),
				]);
				clearTimeout(timer);
			}
		}
		try {
			// The UI in ui/dist/ is the only thing served (ADR-0860).
			const root = await realpath(join(entry.realPath, UI_DIST));
			if (!root.startsWith(`${entry.realPath}${sep}`)) return notFound();
			const candidate = join(root, decoded || 'index.html');
			const file = await realpath(
				(await stat(candidate)).isDirectory()
					? join(candidate, 'index.html')
					: candidate,
			);
			if (!file.startsWith(`${root}${sep}`) || !(await stat(file)).isFile())
				return notFound();
			return new Response(Bun.file(file), {
				headers: {
					'cache-control': decoded.startsWith('_app/immutable/')
						? 'public, max-age=31536000, immutable'
						: 'no-cache',
				},
			});
		} catch {
			return notFound();
		}
	};
	return {
		async mcp(request) {
			const server = await createMcpServer();
			const transport = new WebStandardStreamableHTTPServerTransport({
				enableJsonResponse: true,
			});
			try {
				await server.connect(transport);
				return await transport.handleRequest(request);
			} finally {
				await server.close();
			}
		},
		async launcher(request) {
			// MCP's GET for a server-sent stream: stateless, so there is none.
			const wantsStream = request.headers
				.get('accept')
				?.includes('text/event-stream');
			if (
				(request.method !== 'GET' && request.method !== 'HEAD') ||
				wantsStream
			)
				return new Response('Method not allowed', {
					status: 405,
					headers: { allow: 'GET, HEAD, POST' },
				});
			const apps = await Promise.all(
				(await homeEntries()).map(async (entry) => {
					if (!(await uiFile(entry.entry, 'index.html')).ok) return undefined;
					const { data: located } = await loadHomeApp(entry.entry);
					return {
						name: entry.entry,
						description: located?.ok ? located.app.description : '',
						icon: (await uiFile(entry.entry, 'icon.png')).ok,
					};
				}),
			);
			return new Response(
				launcherPage(
					basename(epicenterDir()),
					apps.filter((app) => app !== undefined),
				),
				{
					headers: {
						'content-type': 'text/html; charset=utf-8',
						'cache-control': 'no-cache',
					},
				},
			);
		},
		async ui(request) {
			if (request.method !== 'GET' && request.method !== 'HEAD')
				return notFound();
			const match = /^\/([^/]+)(?:\/(.*))?$/.exec(
				new URL(request.url).pathname,
			);
			if (!match) return notFound();
			const app = match[1];
			if (!isName(app)) return notFound();
			if (match[2] === undefined) {
				if ((await chooseApps(app)).error) return notFound();
				// Relative, so a proxy in front (tailscale serve) keeps its own host and scheme.
				return new Response(null, {
					status: 308,
					headers: { location: `/${encodeURIComponent(app)}/` },
				});
			}
			return uiFile(app, match[2]);
		},
		call: callResponse,
	};
}

/**
 * The addresses `serve` may listen on: this computer's loopback, and the
 * ranges Tailscale gives a tailnet's devices.
 */
const LISTENABLE = new BlockList();
LISTENABLE.addSubnet('127.0.0.0', 8, 'ipv4');
LISTENABLE.addAddress('::1', 'ipv6');
LISTENABLE.addSubnet('100.64.0.0', 10, 'ipv4');
LISTENABLE.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6');

/**
 * Why `serve` must not listen on `host`, or `undefined` when it may: `serve`
 * signs no one in, so only `localhost`, a loopback address, or a Tailscale
 * address will do. A wildcard such as `0.0.0.0` or a public address would
 * let anyone who reaches this computer call every action. 100.64.0.0/10 is
 * also carrier-grade NAT's range, so a 100.x address is the tailnet's only
 * when Tailscale assigned it.
 */
export function listenProblem(host: string, port: number): string | undefined {
	const address = host.replace(/^\[|\]$/g, '');
	const family = isIP(address);
	if (
		host === 'localhost' ||
		(family !== 0 && LISTENABLE.check(address, family === 6 ? 'ipv6' : 'ipv4'))
	)
		return undefined;
	return `serve signs no one in, so it listens only on this computer (127.0.0.1, ::1, localhost) or a Tailscale address (100.64.0.0/10, fd7a:115c:a1e0::/48), not ${JSON.stringify(host)}.
To reach it from your other devices, leave --host out and run: tailscale serve --bg ${port}`;
}

/**
 * Whether a `Host` header names this computer or the tailnet: a loopback
 * name, an IP literal, or a `*.ts.net` name, whose DNS Tailscale controls.
 * The client writes the header, so this stops DNS rebinding and nothing else;
 * the listening address (`listenProblem`) decides who reaches `serve`.
 */
function isPrivateHost(host: string | null) {
	if (!host) return false;
	let hostname: string;
	try {
		hostname = new URL(`http://${host}`).hostname.toLowerCase();
	} catch {
		return false;
	}
	return (
		hostname === 'localhost' ||
		hostname.endsWith('.localhost') ||
		hostname.endsWith('.ts.net') ||
		isIP(hostname.replace(/^\[|\]$/g, '')) !== 0
	);
}

const forbidden = () => new Response('Forbidden', { status: 403 });

/**
 * Start the listener and its backup clock, which backs up once now and every
 * 5 minutes after. The listener answers everything for a request from this
 * computer or the tailnet whose `Origin`, if any, is its own host. The caller
 * owns its lifetime and ends it with `stop`. Port 0 asks Bun for a free port.
 * `tick` runs one backup now, after any already running, and answers what it
 * did per app.
 */
export function startHttpServer(host: string, port: number) {
	/** Each app's last backup failure as logged, so an unchanged one is logged once. */
	const lastFailure = new Map<string, string>();
	const refreshUi = createUiRefresher();
	/** Log `failures` for the repository at `folder`, unless they are what was logged last. */
	const report = (
		folder: string,
		failures: { message: string; next?: string }[],
	) => {
		const failure = failures
			.map(({ message, next }) => `${message}${next ? `\nRun: ${next}` : ''}`)
			.join('\n');
		if (!failure) lastFailure.delete(folder);
		else if (lastFailure.get(folder) !== failure) {
			writeErr(failure);
			lastFailure.set(folder, failure);
		}
	};
	const backUpAll = async () => {
		const backedUp: Synced[] = [];
		for (const { entry, realPath } of await homeEntries()) {
			const idle = await nothingToBackUp(realPath);
			const synced = idle
				? undefined
				: await syncOne(entry, realPath, { wait: 0 });
			// A call to it is running: its commit, or the next tick, takes what it wrote.
			if (!synced || synced.busy) continue;
			backedUp.push(synced);
			report(realPath, syncFailures(synced));
		}
		// After the apps, so the list it records names the origins they pushed to.
		const root = epicenterDir();
		const own = await syncEpicenter(root);
		if (own) report(root, own.error ? [own.error] : []);
		return backedUp;
	};
	let previous: Promise<unknown> = Promise.resolve();
	const tick = (): Promise<Synced[]> => {
		const next = previous.then(backUpAll);
		previous = next.catch(() => undefined);
		return next;
	};
	const tickLogged = () =>
		tick().catch((error) => {
			writeErr(`Backing up failed: ${extractErrorMessage(error)}`);
		});
	let clock: ReturnType<typeof setTimeout> | undefined;
	let stopping = false;
	const schedule = () => {
		if (stopping) return;
		clock = setTimeout(() => {
			void tickLogged().finally(schedule);
		}, BACKUP_EVERY_MS);
		clock.unref();
	};
	void tickLogged().finally(schedule);
	const site = createSite(refreshUi);
	const answer = async (request: Request) => {
		if (TUNNEL_HEADERS.some((name) => request.headers.has(name)))
			return forbidden();
		if (!isPrivateHost(request.headers.get('host'))) return forbidden();
		const origin = request.headers.get('origin');
		if (origin !== null) {
			let originHost: string;
			try {
				originHost = new URL(origin).host;
			} catch {
				return forbidden();
			}
			if (
				originHost.toLowerCase() !== request.headers.get('host')?.toLowerCase()
			)
				return forbidden();
		}
		const { pathname } = new URL(request.url);
		if (request.method === 'POST')
			return pathname === '/' ? site.mcp(request) : site.call(request);
		if (pathname === '/') return site.launcher(request);
		return site.ui(request);
	};
	const server = Bun.serve({
		hostname: host,
		port,
		idleTimeout: 0,
		fetch: answer,
	});
	return {
		port: server.port as number,
		tick,
		/**
		 * Stop listening and the clock, then run the last backup, waiting for
		 * it at most 10 seconds; `false` when it gave up waiting.
		 */
		stop() {
			stopping = true;
			clearTimeout(clock);
			void server.stop();
			return within(BACKUP_WAIT_MS, tickLogged());
		},
	};
}

/**
 * Serve until the process receives SIGINT or SIGTERM, then back up once
 * more: a host stops `serve` with SIGTERM and allows it time for that
 * backup (ADR-0883).
 */
export async function serveHttp(host: string, port: number): Promise<number> {
	// Every installed app's tools resolve the `@epicenter/app` of the `serve`
	// that answers it, even when the `epicenter` they linked to is gone.
	for (const { realPath } of await homeEntries())
		if (await exists(join(realPath, 'node_modules')))
			await linkAppPackage(realPath);
	const server = startHttpServer(host, port);
	const address = isIP(host) === 6 ? `[${host}]` : host;
	writeErr(`Serving your apps at http://${address}:${server.port}.`);
	await new Promise<void>((resolve) => {
		process.once('SIGINT', resolve);
		process.once('SIGTERM', resolve);
	});
	const finished = await server.stop();
	if (!finished) {
		// A push still waiting on the network would keep the process alive.
		writeErr('Stopped without waiting longer for the last backup.');
		process.exit(0);
	}
	return 0;
}
