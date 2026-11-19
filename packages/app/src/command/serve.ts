/**
 * `epicenter serve` over HTTP (ADR-0864): one address for people and agents.
 *
 * ```txt
 * POST /                        MCP, stateless JSON
 * ANY  /                        405 for any method but POST
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
 * `GET /actions/` feeds every view of the apps (`listApps` in `apps.ts`).
 *
 * Serve loads every app once, when it starts (ADR-0959): each entry in
 * `apps/` is either the app its code defines or its problems (`apps.ts`),
 * and every route and MCP answer from that one object until
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
 * does not name its own (ADR-0961). That is the one way serve and the command
 * tell Epicenters apart. No header carries a version; the listing does, so
 * bare `epicenter` prints the version serve runs. After an upgrade, the owner
 * restarts serve.
 *
 * `serve` has no sign-in: who reaches it is its host's decision (ADR-0883).
 * It listens only on 127.0.0.1 and trusts every request it answers: another
 * device reaches it only through a proxy the owner runs on this computer,
 * such as `tailscale serve`. A browser marks where a request came from
 * (`Sec-Fetch-Site`), and serve refuses one from another origin, including
 * another port of this computer, unless it opens
 * a page: a top-level `GET` navigation, such as an OAuth redirect back. It
 * answers only a `Host` that is a loopback name, an IP literal, or a
 * `*.ts.net` name, which a DNS
 * rebinding name is not, and refuses a request a Tailscale Funnel or
 * Cloudflare Tunnel delivered. Both set their header on every request, and
 * Funnel removes a copy the client sent, so a tunnel aimed at this port by
 * mistake reaches only refusals.
 *
 * Serve reads `routines/` once,
 * when it starts, and keeps one clock: once a minute it runs each routine
 * whose schedule had an occurrence since its last check, as an action call
 * (`routines.ts`, ADR-0937). It commits nothing: Git stores the Epicenter,
 * and its owner commits it, by hand or with cron or launchd.
 */

import { realpath, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { isAbsolute, join, sep } from 'node:path';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { Err } from 'wellcrafted/result';
import { ActionError, type Answer, isName, type NotStarted } from '../index.ts';
import { type Apps, listApps, loadApps } from './apps.ts';
import { createMcpServer } from './mcp.ts';
import { stderrJsonLines, writeErr } from './output.ts';
import { type Listing, ROOT_HEADER, rootHeaderValue } from './protocol.ts';
import { type EpicenterRoot, MARKER, rootInstructions } from './root.ts';
import {
	type Routine,
	readRoutines,
	routineRows,
	startRoutines,
} from './routines.ts';
import { type Call, checkCall, findAction, runAction } from './run.ts';

/** `serve` listens only here; another device reaches it through a proxy on this computer. */
const LOOPBACK = '127.0.0.1';

/** The largest request body serve takes, in bytes. */
const MAX_BODY_BYTES = 25 * 1024 * 1024;

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
	Unhandled: ({ cause }: { cause: unknown }) => ({
		message: `A promise no app awaited rejected: ${extractErrorMessage(cause)}`,
	}),
	Uncaught: ({ cause }: { cause: unknown }) => ({
		message: `An error nothing caught was thrown: ${extractErrorMessage(cause)}`,
	}),
});

/** Serve's record of what it could not do, beside its run records. */
const serveLog = createLogger('cli/serve', stderrJsonLines);

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
 * stops (ADR-0959): the apps, their listing, the routines and `AGENTS.md`.
 */
type Served = {
	root: EpicenterRoot;
	apps: Apps;
	routines: Routine[];
	listing: Omit<Listing, 'routines'>;
	instructions: string | undefined;
};

/** Load the apps, read the routines and `AGENTS.md`, once, for serve's lifetime. */
async function load(root: EpicenterRoot): Promise<Served> {
	const [apps, instructions] = await Promise.all([
		loadApps(root),
		rootInstructions(root),
	]);
	const routines = await readRoutines(root, apps);
	return { root, apps, routines, listing: listApps(apps), instructions };
}

/** `POST /`: one MCP request, answered by a server made for it alone. */
async function mcp(served: Served, request: Request) {
	const server = createMcpServer(served);
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

/**
 * A request under `/apps/<app>/`: a file from the app's build for a `GET` or
 * `HEAD` that names one, else the app's `fetch`, else 404. An entry that
 * did not load answers 500 with its problems, whatever the path, so a name
 * the loader refused, such as `serve`, serves nothing.
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
	// MCP is stateless, so its GET for a server-sent stream has nothing to open.
	if (pathname === '/')
		return method === 'POST' ? mcp(served, request) : methodNotAllowed('POST');
	if (pathname === ACTIONS)
		return reads ? listing(served) : methodNotAllowed('GET, HEAD');
	const [first, app, action, ...rest] = pathname.slice(1).split('/');
	if (first === 'actions' && app !== undefined) {
		if (method !== 'POST') return methodNotAllowed('POST');
		if (rest.length || !isName(app) || !isName(action))
			return refused(
				ActionError.NotStarted({
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
 * Whether a browser marked `request` as coming from another origin, other
 * than to open a page (Fetch Metadata). A top-level `GET` navigation, such as
 * a link or an OAuth redirect back, is allowed; another origin's `<img>`,
 * script, `fetch()` or frame is not. `same-site` is another origin too: a
 * site ignores the port, so a page on `127.0.0.1:3000` is same-site with
 * serve. A request with no `Sec-Fetch-Site` comes from a program, or a
 * browser that sends none, and is allowed, as is `none`: a typed address or
 * a bookmark.
 */
function fromAnotherOrigin(request: Request) {
	const { headers } = request;
	const site = headers.get('sec-fetch-site');
	if (site === null || site === 'same-origin' || site === 'none') return false;
	const opensPage =
		request.method === 'GET' &&
		headers.get('sec-fetch-mode') === 'navigate' &&
		headers.get('sec-fetch-dest') === 'document';
	return !opensPage;
}

/**
 * Start the listener. It answers everything for a request from this
 * computer or the tailnet whose `Origin`, if any, is its own host, from
 * `served` once it has loaded: a request that arrives while serve loads its
 * apps waits. A port something else holds throws before anything loads,
 * so a second serve runs no app's code.
 */
function listen(root: EpicenterRoot, served: Promise<Served>) {
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
		if (fromAnotherOrigin(request)) return forbidden();
		// A request meant for another Epicenter is refused without naming this one,
		// so a command in a second Epicenter cannot read or write here (ADR-0936,
		// ADR-0961). A page or an MCP client names none and is not compared.
		const meant = request.headers.get(ROOT_HEADER);
		if (meant !== null && meant !== ours)
			return new Response('This call is for another Epicenter', {
				status: 409,
			});
		return route(await served, request);
	};
	return Bun.serve({
		hostname: LOOPBACK,
		port: root.port,
		idleTimeout: 0,
		// Bun refuses a larger body itself, with a bare 413, for an action and an
		// app's fetch alike.
		maxRequestBodySize: MAX_BODY_BYTES,
		// Bun's development mode answers a throw with its stack; serve names no path.
		development: false,
		// Said outright: with development off, Bun 1.4.3 lets a second serve bind
		// the same port unless reusePort is false, and the port is serve's lock.
		reusePort: false,
		fetch: answer,
		// A throw answers a plain 500, never Bun's page with a stack.
		error: (error) => {
			serveLog.error(ServeError.Unanswered({ cause: error }).error);
			return new Response('serve could not answer', { status: 500 });
		},
	});
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
 * Serve until the process receives SIGINT or SIGTERM, then cut what is
 * running and exit the process: serve prints no answer. It never starts when a `.env` at the root would
 * reach Git, saying why, or when the port is in use. Once listening it
 * prints each app and routine with a problem.
 */
export async function serveHttp(
	root: EpicenterRoot,
): Promise<Answer | undefined> {
	const { port } = root;
	const dotenv = await dotenvProblem(root.folder);
	if (dotenv) return ActionError.NotStarted({ message: dotenv });
	const loaded = Promise.withResolvers<Served>();
	let server: ReturnType<typeof listen>;
	try {
		server = listen(root, loaded.promise);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
		return ActionError.NotStarted({
			message: `Port ${port} is in use. If that is not this Epicenter's serve, set another \`port\` in ${join(root.folder, MARKER)}.`,
		});
	}
	// Bun ends the process on a rejection or a throw nothing handles, such as
	// an app's timer callback that throws or an action that throws after it
	// answered. One app would then stop every app, so serve logs it and keeps
	// serving. Node warns that state is unknown after an uncaught throw; here
	// the throw unwinds one app's callback, which shares no objects with the
	// other apps, and every write goes through a temporary file and a rename,
	// so a cut write leaves its target whole. Serve's own state survives too:
	// Bun.serve catches what a request handler throws, and the routine clock
	// is a setInterval that keeps ticking after a tick throws.
	process.on('unhandledRejection', (cause) =>
		serveLog.error(ServeError.Unhandled({ cause }).error),
	);
	process.on('uncaughtException', (cause) =>
		serveLog.error(ServeError.Uncaught({ cause }).error),
	);
	let served: Served;
	try {
		served = await load(root);
	} catch (error) {
		void server.stop(true);
		throw error;
	}
	loaded.resolve(served);
	const routines = startRoutines(served.routines);
	// Serve has no page at `/`, so the start message is where a person learns
	// the addresses. Which apps have a built page is read once, here.
	const base = `http://${LOOPBACK}:${port}`;
	const pages: string[] = [];
	for (const { name, folder, app } of served.apps.values())
		if (app && (await uiFile(folder, 'index.html')).ok) pages.push(name);
	writeErr(`Listening on ${base}.`);
	writeErr(`  the listing: ${base}${ACTIONS}`);
	for (const name of pages) writeErr(`  ${name}: ${base}/apps/${name}/`);
	for (const { entry, problems } of served.listing.problems)
		writeErr(`${entry}: ${problems.join('; ')}`);
	for (const routine of served.routines)
		if ('problem' in routine)
			writeErr(`routines/${routine.name}.md: ${routine.problem}`);
	await new Promise<void>((resolve) => {
		process.once('SIGINT', resolve);
		process.once('SIGTERM', resolve);
	});
	// A call or routine still running is cut: its connection closes, and the
	// process exits even while an app's timer or a running action would hold it,
	// so a restarted serve never runs beside this one. A write cut off leaves
	// its target whole, since the folder writes a temporary file and renames it.
	routines.stop();
	await server.stop(true);
	process.exit(0);
}
