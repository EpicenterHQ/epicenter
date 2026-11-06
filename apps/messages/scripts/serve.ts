/**
 * Messages on this computer: serves the built app and answers its operations the way
 * `epicenter messages --json` does (`openMessages` from
 * `@epicenter/cli/messages`): reply notes in the Messages folder, the send
 * journal, and Beeper through the device keychain's token. Beeper Desktop
 * listens only on this computer, so this is the one way the page reaches
 * it, and the folder is on this computer, so this is how the page reads it.
 *
 * The first stdout line is `Messages: <URL>`, after the folder is open and
 * the server is listening. The desktop shell uses that line as its readiness
 * signal. Startup failures go to stderr and exit non-zero.
 *
 * Only Messages' own page may ask: a request must name this server's own
 * host (so a DNS-rebound name cannot reach it), come from its own origin
 * (so another site open in the browser cannot), and be JSON.
 */
import { stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import type { MessagesAnswer } from '@epicenter/cli/messages-protocol';

/** The port Messages is served on. */
export const MESSAGES_PORT = 5188;

export function serveMessages({
	root,
	port = MESSAGES_PORT,
	answer,
}: {
	/** The built app (`build/`). */
	root: string;
	port?: number;
	/** Answers one operation; the operation is not yet validated. */
	answer: (input: unknown) => Promise<MessagesAnswer>;
}) {
	const base = resolve(root);
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port,
		async fetch(request) {
			const { pathname } = new URL(request.url);
			if (pathname === '/messages') return operation(request);
			if (request.method !== 'GET' && request.method !== 'HEAD')
				return new Response(null, { status: 405 });
			return page(pathname);
		},
	});
	const self = `127.0.0.1:${server.port}`;

	async function operation(request: Request) {
		if (request.method !== 'POST') return new Response(null, { status: 405 });
		if (
			request.headers.get('host') !== self ||
			request.headers.get('origin') !== `http://${self}` ||
			request.headers.get('content-type') !== 'application/json'
		)
			return new Response(null, { status: 403 });
		let input: unknown;
		try {
			input = await request.json();
		} catch {
			input = null;
		}
		return Response.json(await answer(input));
	}

	/** A file of the build, or the app's page for any route that is not one. */
	async function page(pathname: string) {
		let path: string;
		try {
			path = resolve(base, `.${decodeURIComponent(pathname)}`);
		} catch {
			return new Response(null, { status: 400 });
		}
		const inside = path === base || path.startsWith(base + sep);
		const found =
			inside && (await stat(path).catch(() => null))?.isFile() === true;
		return new Response(Bun.file(found ? path : join(base, 'index.html')));
	}

	return server;
}

if (import.meta.main) {
	try {
		const { values } = parseArgs({
			options: {
				root: { type: 'string', default: resolve(import.meta.dir, '../build') },
				port: { type: 'string', default: String(MESSAGES_PORT) },
				lifeline: { type: 'boolean', default: false },
			},
		});
		const port = Number(values.port);
		if (!Number.isInteger(port) || port < 0 || port > 65535)
			throw new Error(`Invalid port: ${values.port}`);
		const { beeperConnection, messagesPaths, openMessages } = await import(
			'@epicenter/cli/messages'
		);
		const paths = messagesPaths();
		const messages = await openMessages({
			...paths,
			beeper: beeperConnection(),
		});
		const server = serveMessages({
			root: values.root,
			port,
			answer: messages.answer,
		});
		console.log(`Messages: ${server.url}`);
		console.log(`Replies: ${paths.folder}/replies`);
		if (values.lifeline) {
			await Bun.stdin.text();
			await server.stop(true);
			messages.close();
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
