/**
 * `epicenter serve` over HTTP (ADR-0864): one address for people and agents.
 *
 * ```txt
 * POST /                MCP, stateless JSON
 * GET  /                the launcher; 405 when asked for an event stream (MCP)
 * GET  /<app>/...       the app's UI, ui/dist/, as static files
 * GET  /<app>           308 to /<app>/
 * POST /<app>/<action>  call an action; its words are joined by `.`
 * ```
 *
 * `serve` runs every call itself, from the app's code as it is on disk when
 * the call arrives (`home.ts`, `run.ts`), and keeps nothing about it. A call's
 * body is its input as JSON. Its answer is JSON lines: `{"update": value}`
 * for each update the action sends, then `{"answer": ...}`. A call that is
 * refused before it runs answers that one answer as the body of an HTTP
 * error. An action runs to its end whether or not its caller stays: a caller
 * that leaves stops reading, and nothing stops the action from outside.
 *
 * `serve` has no sign-in: who reaches it is its host's decision (ADR-0883).
 * It listens only on 127.0.0.1 and trusts every request it answers: another
 * device reaches it only through a proxy the owner runs on this computer,
 * such as `tailscale serve`. It answers only a `Host` that
 * is a loopback name, an IP literal, or a `*.ts.net` name, which a DNS
 * rebinding name is not, and refuses a request a Tailscale Funnel or
 * Cloudflare Tunnel delivered. Both set their header on every request, and
 * Funnel removes a copy the client sent, so a tunnel aimed at this port by
 * mistake reaches only refusals.
 *
 * Calls leave their writes pending (`run.ts`).
 * The serve-owned clock checkpoints the root at startup, every five minutes
 * after completion, and on shutdown. Daily routines are checked at startup
 * and once a minute, independently of checkpoints (ADR-0908).
 */

import { realpath, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { basename, isAbsolute, join, sep } from 'node:path';
import { isName } from '@epicenter/app';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { extractErrorMessage } from 'wellcrafted/error';
import { linkAppPackage } from './app-package.ts';
import { type Checkpoint, checkpoint } from './checkpoint.js';
import { CliError } from './errors.ts';
import { chooseApps, homeEntries, loadHomeApp } from './home.ts';
import { createMcpServer } from './mcp.ts';
import { refused, writeErr } from './output.ts';
import { epicenterDir } from './root.ts';
import { createRoutines } from './routines.ts';
import { resolveAction, runAction } from './run.ts';
import { HOME_HEADER, homeName } from './serve-call.ts';
import { createUiRefresher, UI_DIST } from './ui.ts';

/** How often `serve` backs up every app. */
const BACKUP_EVERY_MS = 5 * 60_000;

/** How long `serve` waits for the checkpoint it runs when it stops. */
const BACKUP_WAIT_MS = 10_000;

/** `serve` listens only here; another device reaches it through a proxy on this computer. */
const LOOPBACK = '127.0.0.1';

/** Headers a tunnel adds: Tailscale Funnel's, and Cloudflare Tunnel's. */
const TUNNEL_HEADERS = ['tailscale-funnel-request', 'cf-connecting-ip'];

/** The largest input a call takes; Bun answers 413 past it. */
const MAX_INPUT_BYTES = 25 * 1024 * 1024;

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
};

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
		if (!entry || entry.problem) return notFound();
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
			const refreshed = refreshUi(entry.entry, entry.codePath);
			if (!(await exists(join(entry.codePath, UI_DIST, 'index.html')))) {
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
			const root = await realpath(join(entry.codePath, UI_DIST));
			if (!root.startsWith(`${entry.codePath}${sep}`)) return notFound();
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
	};
}

/**
 * `POST /<app>/<action>`: run the action and answer its updates and then its
 * answer as JSON lines. Updates wait in order for a slow caller, because one
 * can be a piece of text the next extends, and are dropped once it is gone.
 */
async function call(request: Request): Promise<Response> {
	// Every answer names this home, and a call meant for another is refused,
	// so a command in a second home cannot write into this one (ADR-0936).
	const home = await homeName();
	const meant = request.headers.get(HOME_HEADER);
	if (meant !== null && meant !== home)
		return new Response('This call is for another Epicenter', {
			status: 409,
			headers: { [HOME_HEADER]: home },
		});
	const answered = await callAnswer(request);
	answered.headers.set(HOME_HEADER, home);
	return answered;
}

async function callAnswer(request: Request): Promise<Response> {
	const parts = new URL(request.url).pathname.split('/');
	let app: string;
	let words: string[];
	try {
		app = decodeURIComponent(parts[1] ?? '');
		words = decodeURIComponent(parts[2] ?? '').split('.');
	} catch {
		return notFound();
	}
	if (parts.length !== 3 || !isName(app) || !words.every(isName))
		return notFound();
	const key = words.join(' ');
	const refuse = (status: number, message: string) =>
		Response.json(refused(CliError.Usage({ message }).error), { status });
	const bytes = await request.arrayBuffer();
	let input: unknown;
	try {
		input = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return refuse(400, 'The input is not valid JSON');
	}
	const resolved = await resolveAction(app, key, input);
	if (resolved.refusal) return Response.json(resolved.refusal, { status: 400 });
	const encoder = new TextEncoder();
	let listening = true;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const send = (line: object) => {
				if (!listening) return;
				try {
					controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
				} catch {
					listening = false;
				}
			};
			void runAction(resolved.located, key, resolved.action, resolved.input, {
				// JSON has no undefined, and a line with no update is not one.
				onUpdate: (update) => send({ update: update ?? null }),
			}).then((answer) => {
				send({ answer });
				if (listening) controller.close();
			});
		},
		cancel() {
			listening = false;
		},
	});
	return new Response(body, {
		headers: {
			'content-type': 'application/x-ndjson',
			'cache-control': 'no-store',
		},
	});
}

/**
 * Whether a `Host` header names this computer or the tailnet: a loopback
 * name, an IP literal, or a `*.ts.net` name, whose DNS Tailscale controls.
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
 * Start the listener and its checkpoint clock, which checkpoints once now and every
 * 5 minutes after. The listener answers everything for a request from this
 * computer or the tailnet whose `Origin`, if any, is its own host. The caller
 * owns its lifetime and ends it with `stop`. Port 0 asks Bun for a free port.
 * `tick` runs one checkpoint now, after any already running, and answers what it
 * did for the root.
 */
export function startHttpServer(port: number) {
	/** Log an unchanged root checkpoint failure only once. */
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
	const runCheckpoint = async () => {
		const root = epicenterDir();
		const result = await checkpoint(root);
		report(
			root,
			[result.deferred, result.failed, result.pushFailed].filter(
				(problem) => problem !== undefined,
			),
		);
		return result;
	};
	let previous: Promise<unknown> = Promise.resolve();
	const tick = (): Promise<Checkpoint> => {
		const next = previous.then(runCheckpoint);
		previous = next.catch(() => undefined);
		return next;
	};
	const tickLogged = () =>
		tick().catch((error) => {
			writeErr(`Checkpoint failed: ${extractErrorMessage(error)}`);
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
			return pathname === '/' ? site.mcp(request) : call(request);
		if (pathname === '/') return site.launcher(request);
		return site.ui(request);
	};
	const server = Bun.serve({
		hostname: LOOPBACK,
		port,
		idleTimeout: 0,
		// Bun refuses a larger body itself; the slack is for the JSON around a 25 MiB input.
		maxRequestBodySize: MAX_INPUT_BYTES,
		fetch: answer,
	});
	const routines = createRoutines({
		folder: epicenterDir(),
		serviceUrl: `http://127.0.0.1:${server.port}/`,
	});
	const checkRoutines = () =>
		routines
			.check()
			.catch((error) =>
				writeErr(
					`Checking routines failed: ${error instanceof Error ? error.message : String(error)}`,
				),
			);
	void checkRoutines();
	// Only the check is periodic. Commands and network backups never block it.
	const routineClock = setInterval(() => {
		void checkRoutines();
	}, 60_000);
	routineClock.unref();
	return {
		port: server.port as number,
		tick,
		/**
		 * Stop listening and both clocks, then stop routines and run the last
		 * checkpoint, waiting at most 10 seconds; `false` when it gave up waiting.
		 */
		stop() {
			stopping = true;
			clearTimeout(clock);
			clearInterval(routineClock);
			void server.stop();
			return within(
				BACKUP_WAIT_MS,
				Promise.all([routines.stop(), tickLogged()]),
			);
		},
	};
}

/**
 * Serve until the process receives SIGINT or SIGTERM, then checkpoint once
 * more: a host stops `serve` with SIGTERM and allows it time for that
 * checkpoint (ADR-0883).
 */
export async function serveHttp(port: number): Promise<number> {
	// Every installed app's tools resolve the `@epicenter/app` of the `serve`
	// that answers it, even when the `epicenter` they linked to is gone.
	for (const { codePath: realPath, problem } of await homeEntries())
		if (!problem && (await exists(join(realPath, 'node_modules'))))
			await linkAppPackage(realPath);
	const server = startHttpServer(port);
	writeErr(`Serving your apps at http://${LOOPBACK}:${server.port}.`);
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
