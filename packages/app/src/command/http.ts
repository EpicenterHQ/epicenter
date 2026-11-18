/**
 * `epicenter serve` over HTTP (ADR-0864): one address for people and agents.
 *
 * ```txt
 * POST /                             MCP, stateless JSON
 * GET  /                             the launcher; 405 when asked for an event stream (MCP)
 * POST /actions/<app>/<word>/<word>  call an action; each of its words is one segment
 * ANY  /apps/<app>/...               the app: a file in code/ui/dist/, else its fetch, else 404
 * GET  /apps/<app>                   308 to /apps/<app>/
 * ```
 *
 * Serve's own routes take their own first segment, and everything under
 * `/apps/<app>/` belongs to the app (ADR-0966). A `GET` or `HEAD` there is a
 * file from the app's own build when one matches. Any other request goes to
 * the `fetch` the app returned, if any, with `/apps/<app>` removed from its
 * URL and `X-Forwarded-Prefix` set to it (ADR-0945).
 *
 * `serve` runs every call itself, from the app's code as it is on disk when
 * the call arrives (`home.ts`, `run.ts`), and stores nothing about it. When a
 * run ends, serve writes one JSON line to stderr naming the app, the action,
 * the outcome and how long it took, never the input or the result.
 *
 * A call's body is its input as JSON. Its answer is JSON lines:
 * `{"update": value}` for each update the action sends, then
 * `{"answer": {data, error}}` (ADR-0953). A call refused before it begins
 * answers that one answer, a `NotStarted`, as the body of a 400, and writes
 * no line. An action runs to its end whether or not its caller stays: a
 * caller that leaves stops reading, nothing stops the action from outside,
 * and its line on stderr is what remains of how it ended.
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
 * such as `tailscale serve`. A browser marks where a request came from
 * (`Sec-Fetch-Site`), and serve refuses one from another site unless it opens
 * a page: a top-level `GET` navigation, such as an OAuth redirect back. It
 * answers only a `Host` that is a loopback name, an IP literal, or a `*.ts.net` name, which a DNS
 * rebinding name is not, and refuses a request a Tailscale Funnel or
 * Cloudflare Tunnel delivered. Both set their header on every request, and
 * Funnel removes a copy the client sent, so a tunnel aimed at this port by
 * mistake reaches only refusals.
 *
 * Calls leave their writes pending (`run.ts`). Serve keeps one clock: once a
 * minute it starts each routine whose schedule had an occurrence since its
 * last check, a moment it keeps in memory (ADR-0908, ADR-0937). It commits
 * nothing: Git stores the home, and its owner commits it, by hand or from a
 * routine that runs their own script.
 */

import { realpath, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { basename, isAbsolute, join, sep } from 'node:path';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { ActionError, type Answer, isName } from '../index.ts';
import { findEntry, homeEntries, loadHomeApp, localProblem } from './home.ts';
import { createMcpServer } from './mcp.ts';
import { stderrJsonLines, writeErr } from './output.ts';
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

/** What serve could not do in the background. Nobody awaits it, so it is logged. */
const ServeError = defineErrors({
	DroppedLine: ({
		app,
		key,
		cause,
	}: {
		app: string;
		key: string;
		cause: unknown;
	}) => ({
		message: `${app} ${key}: dropped a line that is not JSON: ${extractErrorMessage(cause)}`,
		app,
		key,
	}),
	RoutinesUnchecked: ({ cause }: { cause: unknown }) => ({
		message: `Checking routines failed: ${extractErrorMessage(cause)}`,
	}),
	FetchFailed: ({ app, cause }: { app: string; cause: unknown }) => ({
		message: `${app} fetch: ${extractErrorMessage(cause)}`,
		app,
	}),
});

/** Serve's record of what it could not do, beside its run records. */
const serveLog = createLogger('cli/serve', stderrJsonLines);

const escapeHtml = (text: string) =>
	text.replace(
		/[&<>"']/g,
		(char) =>
			({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
				char
			] as string,
	);

/** The page at `/`: each app with a page, its icon, name, and description, linking to `/apps/<app>/`. */
function launcherPage(
	name: string,
	apps: { name: string; description: string; icon: boolean }[],
) {
	const items = apps
		.map(({ name, description, icon }) => {
			const href = `/apps/${encodeURIComponent(name)}/`;
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
	/** A request under `/apps/<app>`: a built file, the app's `fetch`, or 404. */
	app(
		request: Request,
		app: string,
		path: string | undefined,
	): Promise<Response>;
};

const notFound = () => new Response('Not found', { status: 404 });

/** Where an app's built UI lives, relative to its code folder. Its own build writes it; `serve` never builds. */
const UI_DIST = join('ui', 'dist');

/** The private listener's site: MCP, the launcher, and each app's UI and actions. */
function createSite(): Site {
	const uiFile = async (app: string, path: string) => {
		if (!isName(app)) return notFound();
		const entry = (await findEntry(app)).data;
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
					const page = (await uiFile(entry.entry, 'index.html')).ok;
					const { data: located } = await loadHomeApp(entry.entry);
					// An app with no build step may answer its page from fetch.
					if (!page && !located?.app.fetch) return undefined;
					return {
						name: entry.entry,
						description: located?.app.description ?? '',
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
		async app(request, app, path) {
			if (!isName(app) || (await findEntry(app)).error) return notFound();
			if (path === undefined)
				// Relative, so a proxy in front (tailscale serve) keeps its own host and scheme.
				return new Response(null, {
					status: 308,
					headers: { location: `/apps/${encodeURIComponent(app)}/` },
				});
			if (request.method === 'GET' || request.method === 'HEAD') {
				const file = await uiFile(app, path);
				if (file.ok) return file;
			}
			return appFetch(request, app, path);
		},
	};
}

/**
 * Hand a request no file answered to the app's `fetch`, with `/apps/<app>`
 * removed from its URL and `X-Forwarded-Prefix` naming it. An app without
 * `fetch` answers 404; one that does not load answers 500 with its problems.
 */
async function appFetch(
	request: Request,
	app: string,
	path: string,
): Promise<Response> {
	const { data: located, error: notLoaded } = await loadHomeApp(app);
	if (notLoaded)
		return new Response(notLoaded.message, {
			status: notLoaded.cause === 'app-problems' ? 500 : 404,
		});
	const { fetch } = located.app;
	if (!fetch) return notFound();
	const url = new URL(request.url);
	url.pathname = `/${path}`;
	const headers = new Headers(request.headers);
	headers.set('x-forwarded-prefix', `/apps/${app}`);
	const given = new Request(url.href, {
		method: request.method,
		headers,
		body: request.body,
		redirect: 'manual',
		signal: request.signal,
	});
	try {
		const response = await fetch(given);
		if (response instanceof Response) return response;
		throw new Error(
			`answered ${response === null ? 'null' : typeof response}, not a Response`,
		);
	} catch (cause) {
		serveLog.error(ServeError.FetchFailed({ app, cause }).error);
		return new Response('Internal server error', { status: 500 });
	}
}

/**
 * `POST /actions/<app>/<word>/<word>`: run the action and answer its updates and then its
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
	const { pathname } = new URL(request.url);
	let segments: string[];
	try {
		segments = pathname
			.slice(ACTIONS.length)
			.split('/')
			.map((segment) => decodeURIComponent(segment));
	} catch {
		segments = [];
	}
	const [app = '', ...words] = segments;
	if (!isName(app) || !words.length || !words.every(isName))
		return Response.json(
			ActionError.NotStarted({
				cause: 'usage',
				message: `${pathname} is not an action's address: /actions/<app>/<word>/<word>`,
				next: 'epicenter',
			}),
			{ status: 400 },
		);
	const key = words.join(' ');
	const bytes = await request.arrayBuffer();
	let input: unknown;
	try {
		input = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return Response.json(
			ActionError.NotStarted({
				cause: 'usage',
				message: 'The input is not valid JSON',
			}),
			{ status: 400 },
		);
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
					serveLog.warn(ServeError.DroppedLine({ app, key, cause }).error);
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

/** The first segment of an action call's address. */
const ACTIONS = '/actions/';

/**
 * Whether a browser marked `request` as coming from another site, other than
 * to open a page (Fetch Metadata). A top-level `GET` navigation, such as a
 * link or an OAuth redirect back, is allowed; another site's `<img>`,
 * script, `fetch()` or frame is not. A request with no `Sec-Fetch-Site`
 * comes from a program, or a browser that sends none, and is allowed.
 */
function fromAnotherSite(request: Request) {
	const { headers } = request;
	if (headers.get('sec-fetch-site') !== 'cross-site') return false;
	const opensPage =
		request.method === 'GET' &&
		headers.get('sec-fetch-mode') === 'navigate' &&
		headers.get('sec-fetch-dest') === 'document';
	return !opensPage;
}

/** `response` with `name` set, copied first when its headers are immutable, as `Response.redirect`'s are. */
function withHeader(response: Response, name: string, value: string) {
	try {
		response.headers.set(name, value);
		return response;
	} catch {
		const copy = new Response(response.body, response);
		copy.headers.set(name, value);
		return copy;
	}
}

/** Send `request` to the route its first segment names. */
function route(site: Site, request: Request): Promise<Response> {
	const { pathname } = new URL(request.url);
	if (pathname === '/')
		return request.method === 'POST'
			? site.mcp(request)
			: site.launcher(request);
	if (pathname.startsWith(ACTIONS))
		return request.method === 'POST'
			? call(request)
			: Promise.resolve(
					new Response('Method not allowed', {
						status: 405,
						headers: { allow: 'POST' },
					}),
				);
	const app = /^\/apps\/([^/]+)(?:\/(.*))?$/.exec(pathname);
	if (!app) return Promise.resolve(notFound());
	let name: string;
	try {
		name = decodeURIComponent(app[1] as string);
	} catch {
		return Promise.resolve(notFound());
	}
	return site.app(request, name, app[2]);
}

/**
 * Start the listener and the routine clock. The listener answers everything
 * for a request from this computer or the tailnet whose `Origin`, if any, is
 * its own host. The caller owns its lifetime and ends it with `stop`. Port 0
 * asks Bun for a free port, which only a test that reads `port` back can use:
 * the marker refuses it. A port something else holds throws before the clock
 * starts.
 */
function startHttpServer(port: number) {
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
		if (fromAnotherSite(request)) return forbidden();
		const response = await route(site, request);
		// Every answer to a request serve accepts names its home, so a command
		// or a second serve can tell who holds the port.
		return withHeader(response, HOME_HEADER, await homeName());
	};
	const server = Bun.serve({
		hostname: LOOPBACK,
		port,
		idleTimeout: 0,
		// Bun refuses a larger body itself, with 413, for an action and an app's fetch alike.
		maxRequestBodySize: MAX_INPUT_BYTES,
		fetch: answer,
	});
	const routines = createRoutines({ folder: epicenterDir() });
	const checkRoutines = () =>
		routines
			.check()
			.catch((cause) =>
				serveLog.warn(ServeError.RoutinesUnchecked({ cause }).error),
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

/** The exit code of `git <args>` run in `cwd`, or undefined when there is no Git to run. */
function git(cwd: string, ...args: string[]) {
	try {
		return Bun.spawnSync(['git', ...args], {
			cwd,
			stdout: 'ignore',
			stderr: 'ignore',
		}).exitCode;
	} catch {
		return undefined;
	}
}

/**
 * Why the `.env` at the root of the Epicenter would reach Git, or undefined
 * when it would not (ADR-0963). Git exits 128 outside a repository, which
 * has nothing to commit to; no `.env` means nothing to check. These are the
 * only Git commands Epicenter runs.
 */
async function dotenvProblem(root: string) {
	if (!(await Bun.file(join(root, '.env')).exists())) return undefined;
	if (git(root, 'ls-files', '--error-unmatch', '.env') === 0)
		return '.env is tracked by Git; run git rm --cached .env';
	if (git(root, 'check-ignore', '-q', '.env') === 1)
		return '.env is not ignored by Git; add .env* to .gitignore';
	return undefined;
}

/**
 * Serve until the process receives SIGINT or SIGTERM, then answer nothing:
 * serve prints no answer. It never starts when a `.env` at the root would
 * reach Git, saying why, or when the port is taken, answering who holds it.
 * Once listening it prints each app whose `local/` has no `.gitignore`.
 */
export async function serveHttp(port: number): Promise<Answer | undefined> {
	const dotenv = await dotenvProblem(epicenterDir());
	if (dotenv)
		return ActionError.NotStarted({ cause: 'unavailable', message: dotenv });
	const portTaken = (holder: { home: boolean }) =>
		ActionError.NotStarted({
			cause: 'unavailable',
			message: holder.home
				? `Epicenter is already serving this home on port ${port}.`
				: `Port ${port} is in use by another program or another Epicenter. Set a different \`port\` in ${MARKER}.`,
		});
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
	for (const { entry, realPath } of await homeEntries()) {
		const local = await localProblem(entry, realPath);
		if (local) writeErr(local);
	}
	await new Promise<void>((resolve) => {
		process.once('SIGINT', resolve);
		process.once('SIGTERM', resolve);
	});
	server.stop();
	return undefined;
}
