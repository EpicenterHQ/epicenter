/**
 * `epicenter serve`: one address for the command, agents and pages.
 *
 * ```txt
 * POST /                        MCP, one tool per action
 * GET  /actions/                every app, action, description and input schema
 * POST /actions/<app>/<action>  run one action; the body is its input as JSON
 * GET  /apps/<app>/<file>       the app's built page, from apps/<app>/ui/dist/
 * GET  /data/<path>             a file's bytes
 * PUT  /data/<path>             a file's bytes, keeping any previous version
 * ```
 *
 * Serve imports the home's `epicenter.ts` once, when it starts, and answers
 * every request from that one program until it stops (`program.ts`). A call's
 * answer is JSON lines: `{"update": value}` for each update the action
 * sends, then `{"answer": {data, error}}`. A call refused before it begins
 * is a 200 with that one line, a `NotStarted`; any other status means serve
 * did not take the call. An action runs to its end whether or not its
 * caller stays, and serve writes one line to stderr when it ends. Answers and
 * pages are gzipped for a caller that accepts it; a file under `data/` is sent
 * byte for byte.
 *
 * Serve has no sign-in: it listens only on 127.0.0.1, and another device
 * reaches it only through a proxy the owner runs on this computer, such as
 * `tailscale serve`. The tailnet is trusted; a website open in the owner's
 * browser is not, so every request passes three guards first:
 *
 * - A request Tailscale Funnel delivered is refused, since its `Host` is a
 *   `*.ts.net` name and would otherwise reach every action from the internet.
 * - Its `Host` must be a loopback name, an IP literal or a `*.ts.net` name,
 *   which a DNS rebinding name is not.
 * - An `Origin`, when there is one, must be that same host, so another site
 *   cannot run an action.
 *
 * A request from the command also names its home, and serve refuses one for
 * another home with 409.
 */

import { constants, realpathSync } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pipeline, Readable } from 'node:stream';
import { createGzip, constants as zlib } from 'node:zlib';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { Err, trySync } from 'wellcrafted/result';
import packageJson from '../../package.json' with { type: 'json' };
import type { Answer } from '../answer.ts';
import { ActionError } from '../answer.ts';
import { HOME_HEADER, type Listing, type ScheduleListing } from '../call.ts';
import { prepareEpicenter } from '../disk.ts';
import { parseJson } from '../json.ts';
import { isName } from '../name.ts';
import { timeId } from '../time.ts';
import type { Home } from './home.ts';
import { lockHome } from './home-lock.ts';
import { createMcp } from './mcp.ts';
import { stderrJsonLines, writeErr } from './output.ts';
import { loadProgram, type Program } from './program.ts';
import { answerCall } from './run.ts';
import { startSchedules } from './schedules.ts';

/** Serve listens only here. */
const LOOPBACK = '127.0.0.1';

/** Bun's limit covers every route, so it only stops what no disk would hold. */
const MAX_BODY_BYTES = 2 ** 50;

/** What serve could not do in the background. Nobody awaits it, so it is logged. */
const ServeError = defineErrors({
	DroppedLine: ({ cause }: { cause: unknown }) => ({
		message: `Dropped an update that is not JSON: ${extractErrorMessage(cause)}`,
	}),
	Unanswered: ({ cause }: { cause: unknown }) => ({
		message: `A request threw before its answer: ${extractErrorMessage(cause)}`,
	}),
	Unhandled: ({ cause }: { cause: unknown }) => ({
		message: `A promise nothing awaited rejected: ${extractErrorMessage(cause)}`,
	}),
	Uncaught: ({ cause }: { cause: unknown }) => ({
		message: `An error nothing caught was thrown: ${extractErrorMessage(cause)}`,
	}),
});

const serveLog = createLogger('epicenter/serve', stderrJsonLines);

const JSON_LINES = {
	'content-type': 'application/x-ndjson',
	'cache-control': 'no-store',
};

const forbidden = () => new Response('Forbidden', { status: 403 });
const notFound = () => new Response('Not found', { status: 404 });
const methodNotAllowed = (allow: string) =>
	new Response('Method not allowed', { status: 405, headers: { allow } });

/**
 * A call's response: each update `answering` sends, then its answer, as JSON
 * lines, and always the answer. A call refused before it began is the answer
 * line alone. Updates
 * wait in order for a slow caller, and are dropped once it is gone.
 */
function streamCall(
	answering: (
		onUpdate: (value: unknown) => void,
		signal: AbortSignal,
	) => Promise<Answer>,
	request?: Request,
) {
	const encoder = new TextEncoder();
	let listening = true;
	// Aborts when the caller is gone: its stream was canceled or its request aborted.
	const gone = new AbortController();
	const leave = () => {
		listening = false;
		gone.abort();
	};
	request?.signal.addEventListener('abort', leave, { once: true });
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const send = (line: object) => {
				if (!listening) return;
				// An update that is not JSON is dropped alone; the answer still comes.
				const { data: text, error } = trySync({
					try: () => JSON.stringify(line),
					catch: (cause) => ServeError.DroppedLine({ cause }),
				});
				if (error !== null) {
					serveLog.warn(error);
					return;
				}
				try {
					controller.enqueue(encoder.encode(`${text}\n`));
				} catch {
					leave();
				}
			};
			// Every stream ends with an answer: a throw anywhere before it is
			// Threw, since serve cannot say how far the call got.
			void Promise.resolve()
				.then(() =>
					answering((update) => send({ update: update ?? null }), gone.signal),
				)
				.catch((cause: unknown) => {
					serveLog.error(ServeError.Unanswered({ cause }).error);
					return ActionError.Threw({ message: extractErrorMessage(cause) });
				})
				.then((answer) => {
					send({ answer });
					if (listening) controller.close();
				});
		},
		cancel() {
			leave();
		},
	});
	return new Response(body, { headers: JSON_LINES });
}

/** Every app and action serve offers, as `GET /actions/` answers it. */
function listingOf({ apps, problem }: Program): Listing {
	return {
		version: packageJson.version,
		...(problem === undefined ? {} : { problem }),
		apps: Object.entries(apps).map(([name, app]) => ({
			name,
			description: app.description,
			actions: Object.entries(app.actions).map(([action, run]) => ({
				name: action,
				description: run.description,
				input: run.input,
			})),
		})),
	};
}

/** The program as MCP is given it: every action not marked `mcp: false`. */
function offeredToMcp(program: Program): Program {
	return {
		...program,
		apps: Object.fromEntries(
			Object.entries(program.apps).map(([name, app]) => [
				name,
				{
					...app,
					actions: Object.fromEntries(
						Object.entries(app.actions).filter(
							([, action]) => action.mcp !== false,
						),
					),
				},
			]),
		),
	};
}

/**
 * The file an encoded URL path names under `root`, or undefined when it is
 * malformed or leaves `root`. The URL parser removes a plain `..`, but
 * decoding turns `..%2F` into one, so this check is what keeps `.env` out of
 * reach. A link inside `root` is the owner's and is followed.
 */
function inside(root: string, encoded: string) {
	try {
		const path = resolve(root, decodeURIComponent(encoded));
		return path.startsWith(root + sep) ? path : undefined;
	} catch {
		return undefined;
	}
}

/** Another site may not frame a page and trick a click. */
const PAGE_HEADERS = { 'content-security-policy': "frame-ancestors 'self'" };

/**
 * What a file under `data/` is sent with. A saved HTML file must not run on
 * serve's origin, where it could call every action, and another site may not
 * load a file as its own script or image.
 */
const DATA_HEADERS = {
	'content-security-policy':
		"sandbox allow-same-origin; frame-ancestors 'self'",
	'cross-origin-resource-policy': 'same-origin',
};

/** The file at `path`, or 404 when there is none. */
async function sendFile(
	path: string | undefined,
	headers: Record<string, string>,
) {
	if (path === undefined) return notFound();
	const found = await stat(path).catch(() => undefined);
	if (!found?.isFile()) return notFound();
	return new Response(Bun.file(path), { headers });
}

/**
 * Store a request's body at `path` under `home`. It streams to a temporary
 * file, so a cut upload changes nothing. A file already there is first copied
 * to `.epicenter/replaced/<time>/<path>`, since some media exists only on this
 * disk and Git cannot bring it back. A clone makes that copy instant on APFS.
 */
async function putFile(
	home: string,
	path: string | undefined,
	request: Request,
) {
	if (path === undefined) return notFound();
	const part = `${path}.${crypto.randomUUID()}.part`;
	try {
		await Bun.write(part, new Response(request.body));
		const found = await stat(path).catch(() => undefined);
		if (found && !found.isFile())
			return new Response('A folder is already there', { status: 409 });
		if (found) {
			const saved = join(
				home,
				'.epicenter/replaced',
				timeId(),
				relative(home, path),
			);
			await mkdir(dirname(saved), { recursive: true });
			await copyFile(
				path,
				saved,
				constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
			);
		}
		await rename(part, path);
		return new Response(null, { status: found ? 204 : 201 });
	} finally {
		await rm(part, { force: true });
	}
}

/**
 * Every route for `program`, read from the path, with the listing and the
 * MCP tools made once. An app or action name is `[a-z0-9-]`, which no
 * percent-encoding spells, so only a file's path is decoded.
 */
function createRoute(
	program: Program,
	folder: string,
	listSchedules?: () => ScheduleListing[] | undefined,
) {
	const listing = listingOf(program);
	const offered = offeredToMcp(program);
	const mcp = createMcp(offered, listingOf(offered));
	return async (request: Request) => {
		const { method } = request;
		const { pathname } = new URL(request.url);
		if (pathname === '/')
			return method === 'POST' ? mcp(request) : methodNotAllowed('POST');
		if (pathname === '/actions/') {
			if (method !== 'GET' && method !== 'HEAD')
				return methodNotAllowed('GET, HEAD');
			const schedules = listSchedules?.();
			return Response.json(
				schedules?.length ? { ...listing, schedules } : listing,
				{
					headers: { 'cache-control': 'no-store' },
				},
			);
		}
		const [first, app, action, ...rest] = pathname.slice(1).split('/');
		if (first === 'apps' && app !== undefined) {
			if (method !== 'GET' && method !== 'HEAD')
				return methodNotAllowed('GET, HEAD');
			if (!isName(app) || !Object.hasOwn(program.apps, app)) return notFound();
			// A page's URLs are relative, so they resolve only under the slash.
			if (action === undefined)
				return new Response(null, {
					status: 308,
					headers: { location: `/apps/${app}/` },
				});
			const dist = join(folder, 'apps', app, 'ui', 'dist');
			const file = pathname.slice(`/apps/${app}/`.length) || 'index.html';
			return sendFile(inside(dist, file), PAGE_HEADERS);
		}
		if (first === 'data') {
			const path = inside(
				join(folder, 'data'),
				pathname.slice('/data/'.length),
			);
			if (method === 'GET' || method === 'HEAD')
				return sendFile(path, DATA_HEADERS);
			if (method === 'PUT') return putFile(folder, path, request);
			return methodNotAllowed('GET, HEAD, PUT');
		}
		if (first !== 'actions' || app === undefined) return notFound();
		if (method !== 'POST') return methodNotAllowed('POST');
		if (rest.length || !isName(app) || !isName(action))
			return streamCall(async () =>
				ActionError.NotStarted({
					message: `${pathname} is not an action's address: /actions/<app>/<action>`,
					next: 'epicenter',
				}),
			);
		const input = parseJson(await request.text());
		return streamCall(
			(onUpdate, signal) =>
				answerCall(program, app, action, input, onUpdate, signal),
			request,
		);
	};
}

const COMPRESSIBLE =
	/^(?:text\/|image\/svg|application\/(?:json|javascript|manifest\+json|x-ndjson))/;

/**
 * `response` gzipped when the caller accepts it. Each write is flushed, so an
 * action's update reaches its caller as it is sent rather than with the answer.
 * Files under `data/` stay exact, since a media player asks for byte ranges.
 */
function gzipped(request: Request, response: Response) {
	if (
		!/^\/(?:actions|apps)\//.test(new URL(request.url).pathname) ||
		!response.ok ||
		response.body === null ||
		!COMPRESSIBLE.test(response.headers.get('content-type') ?? '')
	)
		return response;
	response.headers.append('vary', 'accept-encoding');
	if (
		request.method === 'HEAD' ||
		request.headers.has('range') ||
		!/\bgzip\b(?!\s*;\s*q=0(?:\.0*)?\s*(?:,|$))/i.test(
			request.headers.get('accept-encoding') ?? '',
		)
	)
		return response;
	const compressor = createGzip({ flush: zlib.Z_SYNC_FLUSH });
	// Ending the pipe either way tells the action's stream its caller is gone.
	pipeline(Readable.fromWeb(response.body as never), compressor, () => {});
	const headers = new Headers(response.headers);
	headers.set('content-encoding', 'gzip');
	headers.delete('content-length');
	return new Response(Readable.toWeb(compressor) as ReadableStream, {
		status: response.status,
		headers,
	});
}

/** Whether a `Host` header names this computer or the tailnet. */
function isAllowedHost(host: string | null) {
	const hostname = URL.parse(`http://${host}`)?.hostname.toLowerCase();
	if (!hostname) return false;
	return (
		hostname === 'localhost' ||
		hostname.endsWith('.localhost') ||
		hostname.endsWith('.ts.net') ||
		isIP(hostname.replace(/^\[|\]$/g, '')) !== 0
	);
}

/** The guards' refusal of `request`, or undefined when it may pass. */
function guard(request: Request, home: Home) {
	const { headers } = request;
	if (headers.has('tailscale-funnel-request')) return forbidden();
	const host = headers.get('host');
	if (!isAllowedHost(host)) return forbidden();
	const origin = headers.get('origin');
	if (
		origin !== null &&
		URL.parse(origin)?.host.toLowerCase() !== host?.toLowerCase()
	)
		return forbidden();
	const meant = headers.get(HOME_HEADER);
	if (meant !== null && meant !== encodeURIComponent(home.folder))
		return new Response('This call is for another home', { status: 409 });
	return undefined;
}

/**
 * Serve's answer to every request: the guards, then the routes for
 * `program` once it has loaded. A request that arrives while serve loads
 * waits for it.
 */
export function createHandler(
	home: Home,
	program: Promise<Program> | Program,
	listSchedules?: () => ScheduleListing[] | undefined,
) {
	const route = Promise.resolve(program).then((loaded) =>
		createRoute(loaded, home.folder, listSchedules),
	);
	return async (request: Request) =>
		guard(request, home) ?? gzipped(request, await (await route)(request));
}

/**
 * Serve the home until the process receives SIGINT or SIGTERM, then exit
 * with 0; the answer is only ever why serve did not start, a `NotStarted`.
 * It refuses to start outside the home's folder, since Bun reads `.env` from
 * the folder a process starts in, and when it cannot listen, such as when
 * the port is taken.
 */
export async function serveHome(home: Home): Promise<Answer> {
	const { data: folder, error: unread } = trySync({
		try: () => realpathSync(process.cwd()),
		catch: (cause) =>
			ActionError.NotStarted({
				message: `serve cannot read the folder it started in: ${extractErrorMessage(cause)}`,
			}),
	});
	if (unread !== null) return Err(unread);
	if (folder !== home.folder)
		return ActionError.NotStarted({
			message: `serve starts in your home's folder, ${home.folder}, so Bun reads its .env`,
			next: `cd ${home.folder} && epicenter serve`,
		});
	// Before any app runs, so its private files land in a private folder.
	const { data: state, error: unprepared } = trySync({
		try: () => prepareEpicenter(home.folder),
		catch: (cause) =>
			ActionError.NotStarted({
				message: `serve could not prepare .epicenter/: ${extractErrorMessage(cause)}`,
			}),
	});
	if (unprepared !== null) return Err(unprepared);
	const { data: lock, error: locked } = lockHome(state);
	if (locked !== null) return Err(locked);
	const loading = Promise.withResolvers<Program>();
	let schedules: ReturnType<typeof startSchedules>;
	// Fail on an unavailable address before any app loads.
	const { data: server, error: unheard } = trySync({
		try: () =>
			Bun.serve({
				hostname: LOOPBACK,
				port: home.port,
				idleTimeout: 0,
				maxRequestBodySize: MAX_BODY_BYTES,
				// Bun's development mode answers a throw with its stack.
				development: false,
				// An address still belongs to one listener, even across different homes.
				reusePort: false,
				fetch: createHandler(home, loading.promise, () => schedules?.list()),
				error: (error) => {
					serveLog.error(ServeError.Unanswered({ cause: error }).error);
					return new Response('serve could not answer', { status: 500 });
				},
			}),
		catch: (cause) =>
			ActionError.NotStarted({
				message:
					(cause as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE'
						? `Port ${home.port} is in use. If that is not this home's serve, set another port in ${home.folder}/package.json.`
						: `serve could not listen on ${LOOPBACK}:${home.port}: ${extractErrorMessage(cause)}`,
			}),
	});
	if (unheard !== null) {
		lock.close();
		return Err(unheard);
	}
	// One app's stray timer or late rejection must not stop every app.
	process.on('unhandledRejection', (cause) =>
		serveLog.error(ServeError.Unhandled({ cause }).error),
	);
	process.on('uncaughtException', (cause) =>
		serveLog.error(ServeError.Uncaught({ cause }).error),
	);
	const stopping = Promise.withResolvers<void>();
	const stop = () => {
		schedules?.stop();
		stopping.resolve();
	};
	process.once('SIGINT', stop);
	process.once('SIGTERM', stop);
	try {
		const program = await Promise.race([
			loadProgram(home.folder),
			stopping.promise,
		]);
		if (program) {
			schedules = startSchedules(program, state);
			loading.resolve(program);
			const base = `http://${LOOPBACK}:${home.port}`;
			writeErr(`Listening on ${base}. The listing: ${base}/actions/`);
			if (program.problem) writeErr(program.problem);
			await stopping.promise;
		}
		// Keep the lock while any app code can still run. Exit cuts pending calls.
		await server.stop(true);
		return process.exit(0);
	} catch (cause) {
		serveLog.error(ServeError.Uncaught({ cause }).error);
		return process.exit(1);
	} finally {
		lock.close();
	}
}
