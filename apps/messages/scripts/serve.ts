/**
 * Messages on this computer: serves the built app at
 * `http://127.0.0.1:5188` and answers its Beeper operations through the
 * Epicenter CLI's connection (`openBeeper` from `@epicenter/cli/messages`,
 * what `epicenter messages --json` runs), whose token stays in the device
 * keychain. Beeper Desktop listens only on this computer, so this is the
 * one way the page reaches it.
 *
 *   bun run --cwd apps/messages start    # build, then serve
 *
 * Only Messages' own page may ask: a Beeper request must name this server's
 * own host (so a DNS-rebound name cannot reach it), come from its own origin
 * (so another site open in the browser cannot), and be JSON.
 */
import { stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { BeeperAnswer } from '@epicenter/cli/messages-protocol';

/** The port Messages is served on, and so the origin its drafts are kept under. */
export const MESSAGES_PORT = 5188;

export function serveMessages({
	root,
	port = MESSAGES_PORT,
	answer,
}: {
	/** The built app (`build/`). */
	root: string;
	port?: number;
	/** Answers one Beeper operation; the operation is not yet validated. */
	answer: (input: unknown) => Promise<BeeperAnswer>;
}) {
	const base = resolve(root);
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port,
		async fetch(request) {
			const { pathname } = new URL(request.url);
			if (pathname === '/beeper') return beeper(request);
			if (request.method !== 'GET' && request.method !== 'HEAD')
				return new Response(null, { status: 405 });
			return page(pathname);
		},
	});
	const self = `127.0.0.1:${server.port}`;

	async function beeper(request: Request) {
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
	const { openBeeper } = await import('@epicenter/cli/messages');
	const server = serveMessages({
		root: resolve(import.meta.dir, '../build'),
		answer: openBeeper().answer,
	});
	console.log(`Messages: ${server.url}`);
}
