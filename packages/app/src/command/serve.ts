/**
 * `epicenter serve`: one address for the command, agents and pages.
 *
 * ```txt
 * POST /                        MCP, one tool per action
 * GET  /actions/                every app, action, description and input schema
 * POST /actions/<app>/<action>  run one action; the body is its input as JSON
 * ```
 *
 * Serve imports the home's `epicenter.ts` once, when it starts, and answers
 * every request from that one program until it stops (`program.ts`). A call's
 * answer is JSON lines: `{"update": value}` for each update the action
 * sends, then `{"answer": {data, error}}`. A call refused before it begins
 * is a 200 with that one line, a `NotStarted`; any other status means serve
 * did not take the call. An action runs to its end whether or not its
 * caller stays, and serve writes one line to stderr when it ends.
 *
 * Serve has no sign-in: it listens only on 127.0.0.1, and another device
 * reaches it only through a proxy the owner runs on this computer, such as
 * `tailscale serve`. Every request passes four guards first:
 *
 * - A request a Tailscale Funnel or Cloudflare Tunnel delivered is refused.
 *   Both set their header on every request, and Funnel removes a copy the
 *   client sent, so a tunnel aimed at this port by mistake reaches nothing.
 * - Its `Host` must be a loopback name, an IP literal or a `*.ts.net` name,
 *   which a DNS rebinding name is not.
 * - An `Origin`, when there is one, must be that same host.
 * - A browser's `Sec-Fetch-Site` must not say another origin made it.
 *
 * A request from the command also names its home, and serve refuses one for
 * another home with 409.
 */

import { realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import packageJson from '../../package.json' with { type: 'json' };
import type { Answer } from '../answer.ts';
import { ActionError } from '../answer.ts';
import { HOME_HEADER, type Listing } from '../call.ts';
import { parseJson } from '../json.ts';
import { isName } from '../name.ts';
import type { Home } from './home.ts';
import { createMcp } from './mcp.ts';
import { stderrJsonLines, writeErr } from './output.ts';
import { loadProgram, type Program } from './program.ts';
import { answerCall } from './run.ts';

/** Serve listens only here. */
const LOOPBACK = '127.0.0.1';

/** The largest request body serve takes, in bytes. */
const MAX_BODY_BYTES = 25 * 1024 * 1024;

/** Headers a tunnel adds: Tailscale Funnel's, and Cloudflare Tunnel's. */
const TUNNEL_HEADERS = ['tailscale-funnel-request', 'cf-connecting-ip'];

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
	answering: (onUpdate: (value: unknown) => void) => Promise<Answer>,
) {
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
					// An update that is not JSON is dropped alone; the answer still comes.
					serveLog.warn(ServeError.DroppedLine({ cause }).error);
					return;
				}
				try {
					controller.enqueue(encoder.encode(`${text}\n`));
				} catch {
					listening = false;
				}
			};
			// Every stream ends with an answer: a throw anywhere before it is
			// Threw, since serve cannot say how far the call got.
			void Promise.resolve()
				.then(() => answering((update) => send({ update: update ?? null })))
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
			listening = false;
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

/**
 * Every route for `program`, read from the path, with the listing and the
 * MCP tools made once. A name is `[a-z0-9-]`, which no percent-encoding
 * spells, so a segment is not decoded.
 */
function createRoute(program: Program) {
	const listing = listingOf(program);
	const mcp = createMcp(program, listing);
	return async (request: Request) => {
		const { method } = request;
		const { pathname } = new URL(request.url);
		if (pathname === '/')
			return method === 'POST' ? mcp(request) : methodNotAllowed('POST');
		if (pathname === '/actions/')
			return method === 'GET' || method === 'HEAD'
				? Response.json(listing, {
						headers: { 'cache-control': 'no-store' },
					})
				: methodNotAllowed('GET, HEAD');
		const [first, app, action, ...rest] = pathname.slice(1).split('/');
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
		return streamCall((onUpdate) =>
			answerCall(program, app, action, input, onUpdate),
		);
	};
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

/**
 * Whether a browser marked `request` as made by another origin (Fetch
 * Metadata). `same-site` is another origin too: a site ignores the port, so
 * a page on `127.0.0.1:3000` is same-site with serve. A request with no
 * `Sec-Fetch-Site` comes from a program and is allowed, as is `none`, a
 * typed address.
 */
function fromAnotherOrigin(request: Request) {
	const site = request.headers.get('sec-fetch-site');
	return site !== null && site !== 'same-origin' && site !== 'none';
}

/** The guards' refusal of `request`, or undefined when it may pass. */
function guard(request: Request, home: Home) {
	const { headers } = request;
	if (TUNNEL_HEADERS.some((name) => headers.has(name))) return forbidden();
	const host = headers.get('host');
	if (!isAllowedHost(host)) return forbidden();
	const origin = headers.get('origin');
	if (
		origin !== null &&
		URL.parse(origin)?.host.toLowerCase() !== host?.toLowerCase()
	)
		return forbidden();
	if (fromAnotherOrigin(request)) return forbidden();
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
export function createHandler(home: Home, program: Promise<Program> | Program) {
	const route = Promise.resolve(program).then(createRoute);
	return async (request: Request) =>
		guard(request, home) ?? (await route)(request);
}

/**
 * Serve the home until the process receives SIGINT or SIGTERM, then exit
 * with 0; the answer is only ever why serve did not start.
 * It refuses to start outside the home's folder, since Bun reads `.env` from
 * the folder a process starts in, and when the port is taken.
 */
export async function serveHome(home: Home): Promise<Answer> {
	if (realpathSync(process.cwd()) !== home.folder)
		return ActionError.NotStarted({
			message: `serve starts in your home's folder, ${home.folder}, so Bun reads its .env`,
			next: `cd ${home.folder} && epicenter serve`,
		});
	const loading = Promise.withResolvers<Program>();
	let server: ReturnType<typeof Bun.serve>;
	try {
		// Listen before loading, so a second serve fails here and runs no app code.
		server = Bun.serve({
			hostname: LOOPBACK,
			port: home.port,
			idleTimeout: 0,
			maxRequestBodySize: MAX_BODY_BYTES,
			// Bun's development mode answers a throw with its stack.
			development: false,
			// The port is serve's lock, so a second serve must not share it.
			reusePort: false,
			fetch: createHandler(home, loading.promise),
			error: (error) => {
				serveLog.error(ServeError.Unanswered({ cause: error }).error);
				return new Response('serve could not answer', { status: 500 });
			},
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
		return ActionError.NotStarted({
			message: `Port ${home.port} is in use. If that is not this home's serve, set another port in ${home.folder}/package.json.`,
		});
	}
	// One app's stray timer or late rejection must not stop every app.
	process.on('unhandledRejection', (cause) =>
		serveLog.error(ServeError.Unhandled({ cause }).error),
	);
	process.on('uncaughtException', (cause) =>
		serveLog.error(ServeError.Uncaught({ cause }).error),
	);
	const program = await loadProgram(home.folder);
	loading.resolve(program);
	const base = `http://${LOOPBACK}:${home.port}`;
	writeErr(`Listening on ${base}. The listing: ${base}/actions/`);
	if (program.problem) writeErr(program.problem);
	await new Promise<void>((resolve) => {
		process.once('SIGINT', resolve);
		process.once('SIGTERM', resolve);
	});
	// A call still running is cut; every write renamed a whole file into place.
	await server.stop(true);
	return process.exit(0);
}
