/**
 * `epicenter serve` over HTTP (ADR-0864): one address for people and agents.
 *
 * ```txt
 * POST /                MCP, stateless JSON
 * GET  /                the launcher; 405 when asked for an event stream (MCP)
 * GET  /<app>/...       the app's UI: ui/dist/ as static files, as the app's build left it
 * GET  /<app>           308 to /<app>/
 * POST /<app>/<action>  call an action; its words are joined by `.`
 * ```
 *
 * `serve` runs every call itself, from the app's code as it is on disk when
 * the call arrives (`home.ts`, `run.ts`), and keeps nothing about it. A call's
 * body is its input as JSON. Its answer is JSON lines: `{"update": value}`
 * for each update the action sends, then `{"answer": {data, error}}`
 * (ADR-0953). A call refused before it begins answers that one answer, a
 * `NotStarted`, as the body of a 400. An action runs to its end whether or not its caller stays: a caller
 * that leaves stops reading, and nothing stops the action from outside.
 *
 * A home has one `serve`, and its port is how it is found. Every answer names
 * the home (`x-epicenter-home`), so a command can tell whose serve it reached,
 * and a second `serve` can say whether this home or something else has the
 * port. Serve does not say its version: after an upgrade, the owner restarts
 * it.
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
 * Calls leave their writes pending (`run.ts`). Serve keeps one clock: once a
 * minute it starts each routine whose schedule had an occurrence since its
 * last check, a moment it keeps in memory (ADR-0908, ADR-0937). It commits
 * nothing: Git stores the home, and a home commits itself with a routine
 * that runs its own script.
 */

import { realpath, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { basename, isAbsolute, join, sep } from 'node:path';
import { isName } from '@epicenter/app';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CliError } from './errors.ts';
import { chooseApps, homeEntries, loadHomeApp } from './home.ts';
import { createMcpServer } from './mcp.ts';
import { fail, notStarted, writeErr } from './output.ts';
import { epicenterDir, MARKER } from './root.ts';
import { createRoutines } from './routines.ts';
import { resolveAction, runAction } from './run.ts';
import { HOME_HEADER, homeName, whoAnswers } from './serve-call.ts';

/** `serve` listens only here; another device reaches it through a proxy on this computer. */
const LOOPBACK = '127.0.0.1';

/** Headers a tunnel adds: Tailscale Funnel's, and Cloudflare Tunnel's. */
const TUNNEL_HEADERS = ['tailscale-funnel-request', 'cf-connecting-ip'];

/** The largest input a call takes; Bun answers 413 past it. */
const MAX_INPUT_BYTES = 25 * 1024 * 1024;

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

/** Where an app's built UI lives, relative to its code folder. Its own build writes it; `serve` never builds. */
const UI_DIST = join('ui', 'dist');

/** The private listener's site: MCP, the launcher, and each app's UI and actions. */
function createSite(): Site {
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
			// `.`, `..`, and other dot names: never part of a UI.
			decoded.split('/').some((part) => part.startsWith('.'))
		)
			return notFound();
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
	// A call meant for another home is refused, so a command in a second home
	// cannot write into this one (ADR-0936).
	const meant = request.headers.get(HOME_HEADER);
	if (meant !== null && meant !== (await homeName()))
		return new Response('This call is for another Epicenter', { status: 409 });
	return callAnswer(request);
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
		Response.json(notStarted(CliError.Usage({ message }).error), { status });
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
				let text: string;
				try {
					text = JSON.stringify(line);
				} catch (cause) {
					// A line that is not JSON, such as a cyclic update, is dropped
					// alone: the call goes on and its answer still arrives.
					writeErr(
						`${app} ${key}: dropped a line that is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
					);
					return;
				}
				try {
					controller.enqueue(encoder.encode(`${text}\n`));
				} catch {
					// The page went away; nothing more can reach it.
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
 * Start the listener and the routine clock. The listener answers everything
 * for a request from this computer or the tailnet whose `Origin`, if any, is
 * its own host. The caller owns its lifetime and ends it with `stop`. Port 0
 * asks Bun for a free port, which only a test that reads `port` back can use:
 * the marker refuses it. A port something else holds throws before the clock
 * starts.
 */
export function startHttpServer(port: number) {
	const site = createSite();
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
		const response = await (request.method === 'POST'
			? pathname === '/'
				? site.mcp(request)
				: call(request)
			: pathname === '/'
				? site.launcher(request)
				: site.ui(request));
		// Every answer to a request serve accepts names its home, so a command
		// or a second serve can tell who holds the port.
		response.headers.set(HOME_HEADER, await homeName());
		return response;
	};
	const server = Bun.serve({
		hostname: LOOPBACK,
		port,
		idleTimeout: 0,
		// Bun refuses a larger body itself, with 413.
		maxRequestBodySize: MAX_INPUT_BYTES,
		fetch: answer,
	});
	const routines = createRoutines({ folder: epicenterDir() });
	const checkRoutines = () =>
		routines
			.check()
			.catch((error) =>
				writeErr(
					`Checking routines failed: ${error instanceof Error ? error.message : String(error)}`,
				),
			);
	// Routines start without being awaited, so a long one never delays a check.
	const routineClock = setInterval(() => {
		void checkRoutines();
	}, 60_000);
	routineClock.unref();
	return {
		port: server.port as number,
		/**
		 * Stop listening and checking routines. Routine commands share serve's
		 * process group, so whatever stops the group (Ctrl-C, systemd, launchd)
		 * stops them.
		 */
		stop() {
			clearInterval(routineClock);
			void server.stop();
		},
	};
}

/** Serve until the process receives SIGINT or SIGTERM, then exit. */
export async function serveHttp(port: number): Promise<number> {
	/** Say who holds the port, as the refusal that ends this command. */
	const portTaken = (holder: { home: boolean }) =>
		fail(
			CliError.Refused({
				message: holder.home
					? `Epicenter is already serving this home on port ${port}.`
					: `Port ${port} is in use by another program or another Epicenter. Set a different \`port\` in ${MARKER}.`,
			}).error,
			false,
		);
	const holder = await whoAnswers(port);
	if (holder) return portTaken(holder);
	let server: ReturnType<typeof startHttpServer>;
	try {
		server = startHttpServer(port);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
		// The port was taken since it was asked, or its holder does not speak HTTP.
		return portTaken((await whoAnswers(port)) ?? { home: false });
	}
	writeErr(`Serving your apps at http://${LOOPBACK}:${server.port}.`);
	await new Promise<void>((resolve) => {
		process.once('SIGINT', resolve);
		process.once('SIGTERM', resolve);
	});
	server.stop();
	return 0;
}
