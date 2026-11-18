/**
 * `epicenter serve` over HTTP (ADR-0864): one address for people and agents.
 *
 * ```txt
 * POST /                MCP, stateless JSON
 * GET  /                the listing as JSON (accept: application/json), else the
 *                       launcher; 405 when asked for an event stream (MCP)
 * GET  /<app>/...       the app's UI: ui/dist/ as static files, as the app's build left it
 * GET  /<app>           308 to /<app>/
 * POST /<app>           the command: {"words": [...]} as typed after the app's name
 * POST /<app>/<action>  a page's call; its words are joined by `.`
 * ```
 *
 * Serve alone loads app code (ADR-0961). The `epicenter` command sends the
 * words it was given, and serve finds the action, reads and checks the input,
 * and answers "no such action" or "this input does not fit" itself; with
 * `"help": true` it answers the action's tool instead. The listing at `GET /`
 * feeds every view of the apps (`listing.ts`).
 *
 * `serve` runs every call itself, from the app's code as it is on disk when
 * the call arrives (`apps.ts`, `run.ts`), and stores nothing about it. When a
 * run ends, serve writes one JSON line to stderr naming the app, the action,
 * the outcome and how long it took, never the input or the result.
 *
 * A page's call's body is its input as JSON. A call's answer is JSON lines:
 * `{"update": value}` for each update the action sends, then
 * `{"answer": {data, error}}` (ADR-0953). A call refused before it begins
 * answers that one answer, a `NotStarted`, as the body of a 400, and writes
 * no line. An action runs to its end whether or not its caller stays: a
 * caller that leaves stops reading, nothing stops the action from outside,
 * and its line on stderr is what remains of how it ended.
 *
 * An Epicenter has one `serve`, and its port is how it is found. A command names
 * its root on each request (`x-epicenter-root`, its real path, sent only to
 * 127.0.0.1), and serve refuses one naming another root with 409, a body that
 * does not name its own. Every answer carries `x-epicenter: 1` and no path,
 * so a command or a second `serve` can tell this Epicenter's serve from another
 * Epicenter's or another program (ADR-0961). Serve does not say its version: after an upgrade, the owner restarts
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
 * nothing: Git stores the Epicenter, and its owner commits it, by hand or from a
 * routine that runs their own script.
 */

import { realpath, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { basename, isAbsolute, join, sep } from 'node:path';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { Err, Ok } from 'wellcrafted/result';
import { ActionError, type Answer, isName, type NotStarted } from '../index.ts';
import { findEntry, localProblem, rootEntries } from './apps.ts';
import { actionTool, listApps } from './listing.ts';
import { createMcpServer } from './mcp.ts';
import { stderrJsonLines, writeErr } from './output.ts';
import { type EpicenterRoot, MARKER } from './root.ts';
import { createRoutines } from './routines.ts';
import {
	type Call,
	checkCall,
	findAction,
	findWords,
	readCall,
	runAction,
} from './run.ts';
import { answeredBy, ROOT_HEADER, rootName, SERVE_HEADER } from './send.ts';

/** `serve` listens only here; another device reaches it through a proxy on this computer. */
const LOOPBACK = '127.0.0.1';

/** Headers a tunnel adds: Tailscale Funnel's, and Cloudflare Tunnel's. */
const TUNNEL_HEADERS = ['tailscale-funnel-request', 'cf-connecting-ip'];

/** The largest body a call takes; serve refuses a larger one by its length. */
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
	Unanswered: ({ cause }: { cause: unknown }) => ({
		message: `A request threw before its answer: ${extractErrorMessage(cause)}`,
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

const notFound = () => new Response('Not found', { status: 404 });

/** Where an app's built UI lives, relative to its code folder. Its own build writes it; `serve` never builds. */
const UI_DIST = join('ui', 'dist');

/** A file of the app's built UI at `path`, or 404. */
async function uiFile(root: EpicenterRoot, app: string, path: string) {
	const entry = await findEntry(root, app);
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
		const dist = await realpath(join(entry.codePath, UI_DIST));
		if (!dist.startsWith(`${entry.codePath}${sep}`)) return notFound();
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

/** `POST /`: one MCP request, answered by a server made for it alone. */
async function mcp(root: EpicenterRoot, request: Request) {
	const server = await createMcpServer(root);
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

/**
 * `GET /`: the listing as JSON to a caller that accepts it, else the
 * launcher page of each app in it with a UI; 405 when MCP asks for an event
 * stream.
 */
async function listing(root: EpicenterRoot, request: Request) {
	const accept = request.headers.get('accept') ?? '';
	// MCP's GET for a server-sent stream: stateless, so there is none.
	if (
		(request.method !== 'GET' && request.method !== 'HEAD') ||
		accept.includes('text/event-stream')
	)
		return new Response('Method not allowed', {
			status: 405,
			headers: { allow: 'GET, HEAD, POST' },
		});
	const listed = await listApps(root);
	if (accept.includes('application/json'))
		return Response.json(listed, { headers: { 'cache-control': 'no-store' } });
	const apps = await Promise.all(
		listed.apps.map(async ({ name, description }) =>
			(await uiFile(root, name, 'index.html')).ok
				? {
						name,
						description,
						icon: (await uiFile(root, name, 'icon.png')).ok,
					}
				: undefined,
		),
	);
	return new Response(
		launcherPage(
			basename(root.folder),
			apps.filter((app) => app !== undefined),
		),
		{
			headers: {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-cache',
			},
		},
	);
}

/** `GET /<app>` and `/<app>/<path>`: the app's UI, or 404. */
async function ui(root: EpicenterRoot, request: Request) {
	if (request.method !== 'GET' && request.method !== 'HEAD') return notFound();
	const match = /^\/([^/]+)(?:\/(.*))?$/.exec(new URL(request.url).pathname);
	if (!match) return notFound();
	const app = match[1];
	if (!isName(app)) return notFound();
	if (match[2] === undefined) {
		if (!(await findEntry(root, app))) return notFound();
		// Relative, so a proxy in front (tailscale serve) keeps its own host and scheme.
		return new Response(null, {
			status: 308,
			headers: { location: `/${encodeURIComponent(app)}/` },
		});
	}
	return uiFile(root, app, match[2]);
}

const JSON_LINES = {
	'content-type': 'application/x-ndjson',
	'cache-control': 'no-store',
};

/** A call refused before it began: its `NotStarted` alone, as the body of a 400. */
const refused = (error: NotStarted, status = 400) =>
	Response.json(Err(error), { status });

/** An answer that needs no run, as the one line a call's response ends with. */
const answered = (answer: Answer) =>
	new Response(`${JSON.stringify({ answer })}\n`, { headers: JSON_LINES });

/** The body as JSON, or `undefined` when it is not JSON. */
async function bodyJson(
	request: Request,
): Promise<{ value: unknown } | undefined> {
	const text = new TextDecoder().decode(await request.arrayBuffer());
	try {
		return { value: JSON.parse(text) };
	} catch {
		return undefined;
	}
}

/**
 * Run `call`, and answer its updates and then its answer as JSON lines.
 * Updates wait in order for a slow caller, because one can be a piece of
 * text the next extends, and are dropped once it is gone.
 */
function stream(call: Call): Response {
	const { app, key } = call;
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
					serveLog.warn(
						ServeError.DroppedLine({ app: app.name, key, cause }).error,
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

/** `POST /<app>/<action>`: a page's call, its action's words joined by `.` and its input the body. */
async function pageCall(
	root: EpicenterRoot,
	app: string,
	path: string,
	request: Request,
) {
	let words: string[];
	try {
		words = decodeURIComponent(path).split('.');
	} catch {
		return notFound();
	}
	if (!words.every(isName)) return notFound();
	const body = await bodyJson(request);
	if (!body)
		return refused(
			ActionError.NotStarted({
				cause: 'usage',
				message: 'The input is not valid JSON',
			}).error,
		);
	const { data: found, error } = await findAction(root, app, words.join(' '));
	if (error) return refused(error);
	const { data: call, error: misfit } = checkCall(found, body.value);
	if (misfit) return refused(misfit);
	return stream(call);
}

/**
 * `POST /<app>`: the command's words after the app's name as typed, as
 * `{"words": [...]}` (ADR-0961). Serve finds the action they name and reads
 * the word after it as the input. With `"help": true` it answers the
 * action's tool instead of running it.
 */
async function commandCall(root: EpicenterRoot, app: string, request: Request) {
	const body = await bodyJson(request);
	const { words, help } = (body?.value ?? {}) as {
		words?: unknown;
		help?: unknown;
	};
	if (
		!Array.isArray(words) ||
		!words.length ||
		!words.every((word) => typeof word === 'string')
	)
		return refused(
			ActionError.NotStarted({
				cause: 'usage',
				message: 'The command sends {"words": [...]}, the words after the app',
			}).error,
		);
	const { data: found, error } = await findWords(root, app, words);
	if (error) return refused(error);
	if (help === true)
		return answered(Ok(actionTool(app, found.key, found.action)));
	const { data: call, error: misfit } = readCall(found, found.rest);
	if (misfit) return refused(misfit);
	return stream(call);
}

/** `POST /<app>` from the command, or `POST /<app>/<action>` from a page. */
async function post(root: EpicenterRoot, request: Request) {
	const [, first = '', action, ...more] = new URL(request.url).pathname.split(
		'/',
	);
	let app: string;
	try {
		app = decodeURIComponent(first);
	} catch {
		return notFound();
	}
	if (more.length) return notFound();
	// The command's words name an app as typed, and serve says when none has that name.
	if (action === undefined) return commandCall(root, app, request);
	if (!isName(app)) return notFound();
	return pageCall(root, app, action, request);
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
 * its own host. The caller owns its lifetime and ends it with `stop`. A port
 * something else holds throws before the clock starts.
 */
function startHttpServer(root: EpicenterRoot) {
	const name = rootName(root);
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
		return stamped(await route(request));
	};
	// Every answer to a request serve accepts says it is an Epicenter's serve,
	// and no more, so a command or a second serve can tell who holds the port.
	const stamped = (response: Response) => {
		response.headers.set(SERVE_HEADER, '1');
		return response;
	};
	const route = async (request: Request) => {
		if (Number(request.headers.get('content-length')) > MAX_INPUT_BYTES)
			return refused(
				ActionError.NotStarted({
					cause: 'usage',
					message: 'The input is larger than 25 MiB',
				}).error,
				413,
			);
		// A request meant for another Epicenter is refused without naming this one,
		// so a command in a second Epicenter cannot read or write here (ADR-0936,
		// ADR-0961). A page or an MCP client names none and is not compared.
		const meant = request.headers.get(ROOT_HEADER);
		const { pathname } = new URL(request.url);
		if (meant !== null && meant !== name)
			return new Response('This call is for another Epicenter', {
				status: 409,
			});
		if (pathname === '/')
			return request.method === 'POST'
				? mcp(root, request)
				: listing(root, request);
		return request.method === 'POST' ? post(root, request) : ui(root, request);
	};
	const server = Bun.serve({
		hostname: LOOPBACK,
		port: root.port,
		idleTimeout: 0,
		// A body with no length is cut off here instead, by Bun, which answers
		// 413 without the header; a command always sends the length.
		maxRequestBodySize: 2 * MAX_INPUT_BYTES,
		// Bun's development mode answers a throw with its stack; serve names no path.
		development: false,
		fetch: answer,
		// A throw is a request serve accepted, so its 500 says so too.
		error: (error) => {
			serveLog.error(ServeError.Unanswered({ cause: error }).error);
			return stamped(new Response('serve could not answer', { status: 500 }));
		},
	});
	const routines = createRoutines(root);
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
 * Who holds `root`'s port, asked as a command asks, with this root: its own
 * serve, another Epicenter's, or another program. `undefined` when nothing
 * there answers HTTP.
 */
async function whoAnswers(root: EpicenterRoot) {
	try {
		// This one reads no app: serve answers OPTIONS / with 405, or 409.
		const response = await fetch(`http://${LOOPBACK}:${root.port}/`, {
			method: 'OPTIONS',
			headers: { [ROOT_HEADER]: rootName(root) },
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
	const portTaken = (holder: ReturnType<typeof answeredBy>) =>
		ActionError.NotStarted({
			cause: 'unavailable',
			message:
				holder === 'its serve'
					? `serve is already running for this Epicenter on port ${port}.`
					: holder === 'an older serve'
						? `Port ${port} is in use by a serve started before Epicenter was upgraded; stop it, then run epicenter serve again.`
						: `Port ${port} is in use by ${holder === 'another Epicenter' ? "another Epicenter's serve" : 'another program'}. Set a different \`port\` in ${MARKER}.`,
		});
	const holder = await whoAnswers(root);
	if (holder) return portTaken(holder);
	let server: ReturnType<typeof startHttpServer>;
	try {
		server = startHttpServer(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
		// The port was taken since it was asked, or its holder does not speak HTTP.
		return portTaken((await whoAnswers(root)) ?? 'another program');
	}
	writeErr(`Serving your apps at http://${LOOPBACK}:${port}.`);
	for (const found of await rootEntries(root)) {
		const local = await localProblem(found);
		if (local) writeErr(local);
	}
	await new Promise<void>((resolve) => {
		process.once('SIGINT', resolve);
		process.once('SIGTERM', resolve);
	});
	server.stop();
	return undefined;
}
