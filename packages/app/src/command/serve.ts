/**
 * `epicenter serve` over HTTP (ADR-0864): one address for people and agents.
 *
 * ```txt
 * POST /                        MCP, stateless JSON
 * GET  /                        the launcher; 405 when asked for an event stream (MCP)
 * GET  /actions/                the listing as JSON
 * POST /actions/<app>/<action>  a call from a page or the command
 * ANY  /apps/<app>/...          the app: a file in code/ui/dist/, else its fetch, else 404
 * GET  /apps/<app>              308 to /apps/<app>/
 * ```
 *
 * Serve's own routes take their own first segment, and everything under
 * `/apps/<app>/` belongs to the app (ADR-0967). A `GET` or `HEAD` there is a
 * file from the app's own build when one matches. Any other request goes to
 * the `fetch` the app returned, if any, unchanged (ADR-0945).
 *
 * Serve alone loads app code and reads an action's input (ADR-0961). A page
 * and the `epicenter` command call an action the same way, and serve answers
 * "no such action" or "this input does not fit" itself. The listing at
 * `GET /actions/` feeds every view of the apps (`listing.ts`).
 *
 * Serve loads every app once, when it starts (ADR-0959): each entry in
 * `apps/` is either the app its code defines or its problems (`apps.ts`),
 * and every route, MCP and the launcher answer from that one object until
 * serve stops. To run changed code, restart serve. Serve runs every call
 * itself (`run.ts`) and stores nothing about it. When a
 * run ends, serve writes one JSON line to stderr naming the app, the action,
 * the outcome and how long it took, never the input or the result.
 *
 * A call's body is its input as JSON text. A call's answer is JSON lines:
 * `{"update": value}` for each update the action sends, then
 * `{"answer": {data, error}}` (ADR-0953). A call refused before it begins
 * answers a 200 with that one line, a `NotStarted`, and writes no line to
 * stderr; any other status means serve did not take the call (ADR-0967).
 * An action runs to its end whether or not its caller stays: a caller that
 * leaves stops reading, nothing stops the action from outside,
 * and its line on stderr is what remains of how it ended.
 *
 * An Epicenter has one `serve`, and its port is how it is found. A command names
 * its root on each request (`x-epicenter-root`, its real path, sent only to
 * 127.0.0.1), and serve refuses one naming another root with 409, a body that
 * does not name its own. Every answer carries `x-epicenter: 1` and no path,
 * so a command or a second `serve` can tell this Epicenter's serve from another
 * Epicenter's or another program (ADR-0961). No header carries a version;
 * the listing does, so bare `epicenter` prints the version serve runs. After
 * an upgrade, the owner restarts serve.
 *
 * `serve` has no sign-in: who reaches it is its host's decision (ADR-0883).
 * It listens only on 127.0.0.1 and trusts every request it answers: another
 * device reaches it only through a proxy the owner runs on this computer,
 * such as `tailscale serve`. A browser marks where a request came from
 * (`Sec-Fetch-Site`), and serve refuses one from another site unless it opens
 * a page: a top-level `GET` navigation, such as an OAuth redirect back. It
 * answers only a `Host` that is a loopback name, an IP literal, or a
 * `*.ts.net` name, which a DNS
 * rebinding name is not, and refuses a request a Tailscale Funnel or
 * Cloudflare Tunnel delivered. Both set their header on every request, and
 * Funnel removes a copy the client sent, so a tunnel aimed at this port by
 * mistake reaches only refusals.
 *
 * Calls leave their writes pending (`run.ts`). Serve reads `routines/` once,
 * when it starts, and keeps one clock: once a minute it runs each routine
 * whose schedule had an occurrence since its last check, as an action call
 * (`routines.ts`, ADR-0937). It commits nothing: Git stores the Epicenter,
 * and its owner commits it, by hand or with cron or launchd.
 */

import { realpath, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { basename, isAbsolute, join, sep } from 'node:path';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { Err } from 'wellcrafted/result';
import { ActionError, type Answer, isName, type NotStarted } from '../index.ts';
import { type Apps, loadApps } from './apps.ts';
import { listApps } from './listing.ts';
import { createMcpServer, type McpOffer } from './mcp.ts';
import { stderrJsonLines, writeErr } from './output.ts';
import {
	answeredBy,
	type Holder,
	type Listing,
	MAX_INPUT_BYTES,
	portHeld,
	ROOT_HEADER,
	rootHeaderValue,
	SERVE_HEADER,
} from './protocol.ts';
import { type EpicenterRoot, rootInstructions } from './root.ts';
import {
	type Routine,
	readRoutines,
	routineRows,
	startRoutines,
} from './routines.ts';
import { type Call, checkCall, findAction, runAction } from './run.ts';

/** `serve` listens only here; another device reaches it through a proxy on this computer. */
const LOOPBACK = '127.0.0.1';

/** Headers a tunnel adds: Tailscale Funnel's, and Cloudflare Tunnel's. */
const TUNNEL_HEADERS = ['tailscale-funnel-request', 'cf-connecting-ip'];

/** What serve could not do in the background. Nobody awaits it, so it is logged. */
const ServeError = defineErrors({
	DroppedLine: ({
		app,
		action,
		cause,
	}: {
		app: string;
		action: string;
		cause: unknown;
	}) => ({
		message: `${app} ${action}: dropped a line that is not JSON: ${extractErrorMessage(cause)}`,
		app,
		action,
	}),
	Unanswered: ({ cause }: { cause: unknown }) => ({
		message: `A request threw before its answer: ${extractErrorMessage(cause)}`,
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

const notFound = () => new Response('Not found', { status: 404 });

/** Where an app's built UI lives, relative to its code folder. Its own build writes it; `serve` never builds. */
const UI_DIST = join('ui', 'dist');

/** A file of the built UI of the app in `folder` at `path`, or 404. */
async function uiFile(folder: string, path: string) {
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
		const code = await realpath(join(folder, 'code'));
		const dist = await realpath(join(code, UI_DIST));
		if (!dist.startsWith(`${code}${sep}`)) return notFound();
		const candidate = join(dist, decoded || 'index.html');
		const file = await realpath(
			(await stat(candidate)).isDirectory()
				? join(candidate, 'index.html')
				: candidate,
		);
		if (!file.startsWith(`${dist}${sep}`) || !(await stat(file)).isFile())
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
}

/**
 * What serve loaded when it started and answers every request from until it
 * stops (ADR-0959): the apps, their listing, and what MCP offers.
 */
type Served = {
	root: EpicenterRoot;
	apps: Apps;
	routines: Routine[];
	listing: Omit<Listing, 'routines'>;
	mcp: McpOffer;
};

/** Load the apps, read the routines and `AGENTS.md`, once, for serve's lifetime. */
async function load(root: EpicenterRoot): Promise<Served> {
	const [apps, instructions] = await Promise.all([
		loadApps(root),
		rootInstructions(root),
	]);
	const routines = await readRoutines(root, apps);
	const listing = listApps(apps);
	const tools = listing.apps.flatMap(({ actions }) =>
		actions.filter((tool) => tool.mcp !== false),
	);
	return {
		root,
		apps,
		routines,
		listing,
		mcp: { apps, tools, instructions },
	};
}

/** `POST /`: one MCP request, answered by a server made for it alone. */
async function mcp({ mcp }: Served, request: Request) {
	const server = createMcpServer(mcp);
	const transport = new WebStandardStreamableHTTPServerTransport({
		enableJsonResponse: true,
	});
	try {
		await server.connect(transport);
		return await transport.handleRequest(request);
	} finally {
		await server.close();
	}
}

/** `GET /actions/`: the listing, each routine's next occurrence counted now. */
function listing({ listing, routines }: Served) {
	return Response.json(
		{ ...listing, routines: routineRows(routines) },
		{ headers: { 'cache-control': 'no-store' } },
	);
}

/** `GET /`: the launcher, a link to each app with a built page. */
async function launcher({ root, apps, listing }: Served) {
	const shown = await Promise.all(
		listing.apps.map(async ({ name, description }) => {
			const { folder } = apps.get(name) as { folder: string };
			if (!(await uiFile(folder, 'index.html')).ok) return undefined;
			return {
				name,
				description,
				icon: (await uiFile(folder, 'icon.png')).ok,
			};
		}),
	);
	return new Response(
		launcherPage(
			basename(root.folder),
			shown.filter((app) => app !== undefined),
		),
		{
			headers: {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-cache',
			},
		},
	);
}

/**
 * A request under `/apps/<app>/`: a file from the app's build for a `GET` or
 * `HEAD` that names one, else the app's `fetch`, else 404. An entry that
 * did not load answers 500 with its problems, whatever the path, so a name
 * the loader refused, such as `check`, serves nothing.
 */
async function appRequest(
	{ apps }: Served,
	request: Request,
	name: string,
	path: string,
): Promise<Response> {
	const entry = apps.get(name);
	if (!entry) return notFound();
	if (!entry.app)
		return new Response(`${name}: ${entry.problems.join('; ')}`, {
			status: 500,
		});
	if (request.method === 'GET' || request.method === 'HEAD') {
		const file = await uiFile(entry.folder, path);
		if (file.ok) return file;
	}
	// The app gets the request unchanged: it knows its address from its folder's name.
	const handler = entry.app.fetch;
	if (!handler) return notFound();
	try {
		const response = await handler(request);
		if (response instanceof Response) return response;
		throw new Error(
			`answered ${response === null ? 'null' : typeof response}, not a Response`,
		);
	} catch (cause) {
		serveLog.error(ServeError.FetchFailed({ app: name, cause }).error);
		return new Response('Internal server error', { status: 500 });
	}
}

const methodNotAllowed = (allow: string) =>
	new Response('Method not allowed', { status: 405, headers: { allow } });

const JSON_LINES = {
	'content-type': 'application/x-ndjson',
	'cache-control': 'no-store',
};

/** A call refused before it began: a 200 with its one answer line, its `NotStarted`. */
const refused = (error: NotStarted) =>
	new Response(`${JSON.stringify({ answer: Err(error) })}\n`, {
		headers: JSON_LINES,
	});

/**
 * Run `call`, and answer its updates and then its answer as JSON lines.
 * Updates wait in order for a slow caller, because one can be a piece of
 * text the next extends, and are dropped once it is gone.
 */
function stream(call: Call): Response {
	const { app, action } = call;
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
					serveLog.warn(ServeError.DroppedLine({ app, action, cause }).error);
					return;
				}
				try {
					controller.enqueue(encoder.encode(`${text}\n`));
				} catch {
					// The page went away; nothing more can reach it.
					listening = false;
				}
			};
			void runAction(call, {
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
	return new Response(body, { headers: JSON_LINES });
}

/** `POST /actions/<app>/<action>`: a call from a page or the command, its input the body. */
async function call(
	{ apps }: Served,
	request: Request,
	app: string,
	action: string,
) {
	const text = new TextDecoder().decode(await request.arrayBuffer());
	const { data: found, error } = findAction(apps, app, action);
	if (error) return refused(error);
	const { data: checked, error: misfit } = checkCall(found, { text });
	if (misfit) return refused(misfit);
	return stream(checked);
}

/**
 * Every route serve answers, read from the path once. A name in a path is
 * matched as it is sent: a name is `[a-z0-9-]`, which no percent-encoding
 * spells, so a segment is not decoded.
 */
function route(served: Served, request: Request) {
	const { method } = request;
	const { pathname } = new URL(request.url);
	const reads = method === 'GET' || method === 'HEAD';
	if (pathname === '/') {
		if (method === 'POST') return mcp(served, request);
		// MCP's GET for a server-sent stream: stateless, so there is none.
		const stream = (request.headers.get('accept') ?? '').includes(
			'text/event-stream',
		);
		return reads && !stream
			? launcher(served)
			: methodNotAllowed('GET, HEAD, POST');
	}
	if (pathname === ACTIONS)
		return reads ? listing(served) : methodNotAllowed('GET, HEAD');
	const [first, app, action, ...rest] = pathname.slice(1).split('/');
	if (first === 'actions' && app !== undefined) {
		if (method !== 'POST') return methodNotAllowed('POST');
		if (rest.length || !isName(app) || !isName(action))
			return refused(
				ActionError.NotStarted({
					cause: 'usage',
					message: `${pathname} is not an action's address: /actions/<app>/<action>`,
					next: 'epicenter',
				}).error,
			);
		return call(served, request, app, action);
	}
	if (first !== 'apps' || !isName(app)) return notFound();
	// Relative, so a proxy in front (tailscale serve) keeps its own host and scheme.
	if (action === undefined)
		return new Response(null, {
			status: 308,
			headers: { location: `/apps/${app}/` },
		});
	return appRequest(served, request, app, [action, ...rest].join('/'));
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

/** The listing's address. */
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

/**
 * Start the listener and the routine clock. The listener answers everything
 * for a request from this computer or the tailnet whose `Origin`, if any, is
 * its own host. The caller owns its lifetime and ends it with `stop`. A port
 * something else holds throws before the clock starts.
 */
function startHttpServer(served: Served) {
	const { root } = served;
	const ours = rootHeaderValue(root);
	const answer = async (request: Request): Promise<Response> => {
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
		return stamped(await meantHere(request));
	};
	// Every answer to a request serve accepts says it is an Epicenter's serve,
	// and no more, so a command or a second serve can tell who holds the port.
	// An app's fetch may answer `Response.redirect`, whose headers are frozen.
	const stamped = (response: Response) => {
		try {
			response.headers.set(SERVE_HEADER, '1');
			return response;
		} catch {
			const copy = new Response(response.body, response);
			copy.headers.set(SERVE_HEADER, '1');
			return copy;
		}
	};
	const meantHere = async (request: Request) => {
		// A request meant for another Epicenter is refused without naming this one,
		// so a command in a second Epicenter cannot read or write here (ADR-0936,
		// ADR-0961). A page or an MCP client names none and is not compared.
		const meant = request.headers.get(ROOT_HEADER);
		if (meant !== null && meant !== ours)
			return new Response('This call is for another Epicenter', {
				status: 409,
			});
		return route(served, request);
	};
	const server = Bun.serve({
		hostname: LOOPBACK,
		port: root.port,
		idleTimeout: 0,
		// Bun refuses a larger body itself, with a bare 413, for an action and an
		// app's fetch alike. The command refuses such an input before sending it.
		maxRequestBodySize: MAX_INPUT_BYTES,
		// Bun's development mode answers a throw with its stack; serve names no path.
		development: false,
		fetch: answer,
		// A throw is a request serve accepted, so its 500 says so too.
		error: (error) => {
			serveLog.error(ServeError.Unanswered({ cause: error }).error);
			return stamped(new Response('serve could not answer', { status: 500 }));
		},
	});
	const routines = startRoutines(served.routines);
	return {
		/** Stop listening and running routines. A call or routine still running is cut when serve exits. */
		stop() {
			routines.stop();
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
 * Who holds `root`'s port, asked as a command asks, with this root: its own
 * serve, another Epicenter's, or another program. `undefined` when nothing
 * there answers HTTP.
 */
async function whoAnswers(root: EpicenterRoot) {
	try {
		// This one reads no app: serve answers OPTIONS / with 405, or 409.
		const response = await fetch(`http://${LOOPBACK}:${root.port}/`, {
			method: 'OPTIONS',
			headers: { [ROOT_HEADER]: rootHeaderValue(root) },
			signal: AbortSignal.timeout(2_000),
		});
		await response.body?.cancel().catch(() => undefined);
		return answeredBy(response);
	} catch {
		return undefined;
	}
}

/**
 * Serve until the process receives SIGINT or SIGTERM, then answer nothing:
 * serve prints no answer. It never starts when a `.env` at the root would
 * reach Git, saying why, or when the port is taken, answering who holds it.
 * Once listening it prints each app whose `local/` has no `.gitignore`.
 */
export async function serveHttp(
	root: EpicenterRoot,
): Promise<Answer | undefined> {
	const { port } = root;
	const dotenv = await dotenvProblem(root.folder);
	if (dotenv)
		return ActionError.NotStarted({ cause: 'unavailable', message: dotenv });
	const portTaken = (holder: Holder) =>
		holder === 'its serve'
			? ActionError.NotStarted({
					cause: 'unavailable',
					message: `serve is already running for this Epicenter on port ${port}.`,
				})
			: portHeld(root, holder);
	const holder = await whoAnswers(root);
	if (holder) return portTaken(holder);
	const served = await load(root);
	let server: ReturnType<typeof startHttpServer>;
	try {
		server = startHttpServer(served);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
		// The port was taken since it was asked, or its holder does not speak HTTP.
		return portTaken((await whoAnswers(root)) ?? 'another program');
	}
	writeErr(`Serving your apps at http://${LOOPBACK}:${port}.`);
	for (const { entry, problems } of served.listing.problems)
		writeErr(`${entry}: ${problems.join('; ')}`);
	for (const routine of served.routines)
		if ('problem' in routine)
			writeErr(`routines/${routine.name}.md: ${routine.problem}`);
	await new Promise<void>((resolve) => {
		process.once('SIGINT', resolve);
		process.once('SIGTERM', resolve);
	});
	server.stop();
	return undefined;
}
