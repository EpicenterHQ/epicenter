/**
 * Messages on this computer: serves the built app at
 * `http://127.0.0.1:5188`, keeps its drafts in a directory it owns
 * (`messagesFolder()`), and answers its Beeper operations through the
 * Epicenter CLI's connection (`openBeeper` from `@epicenter/cli/messages`,
 * what `epicenter messages --json` runs), whose token stays in the device
 * keychain. Beeper Desktop listens only on this computer, so this is the
 * one way the page reaches it, and the page reaches its drafts only
 * through this program (ADR-0784).
 *
 *   bun run --cwd apps/messages start    # build, then serve
 *
 * Only Messages' own page may ask: a Beeper request or a request of its
 * folder (`/folder/<verb>`, `serveDirectory` from `@epicenter/folder/serve`)
 * must name this server's own host (so a DNS-rebound name cannot reach
 * it), come from its own origin (so another site open in the browser
 * cannot), and be JSON.
 */
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { BeeperAnswer } from '@epicenter/cli/messages-protocol';
import {
	appDataDir,
	EPICENTER_BUNDLE_IDENTIFIER,
	epicenterDataRoot,
} from '@epicenter/definition/site/app-data';
import { serveDirectory } from '@epicenter/folder/serve';

/** The port Messages is served on. */
export const MESSAGES_PORT = 5188;

/** Messages' app id, which names its directory under Epicenter's application data. */
export const MESSAGES_APP_ID = 'so.epicenter.messages';

/**
 * Where Messages keeps its drafts and send attempts on this computer:
 * `<Epicenter's application data>/apps/so.epicenter.messages`, as Local
 * Books keeps its books (`~/Library/Application Support/so.epicenter/...`
 * on macOS; `EPICENTER_DATA_DIR` names the root instead). Not under
 * `~/Epicenter`: a draft and its send attempt belong to the Beeper
 * installation on this computer, and nothing syncs them. `development`
 * (`bun dev:messages`) keeps its own, under the development root.
 */
export function messagesFolder(
	environment: 'production' | 'development' = 'production',
) {
	const root = epicenterDataRoot(
		{ env: process.env, platform: process.platform, homeDir: homedir() },
		environment === 'development'
			? `${EPICENTER_BUNDLE_IDENTIFIER}.dev`
			: EPICENTER_BUNDLE_IDENTIFIER,
	);
	return appDataDir(root, MESSAGES_APP_ID);
}

/**
 * Whether `request` is Messages' own page asking, at `self` (its
 * `host:port`): it names that host, comes from that origin, and is JSON,
 * which no other site can send without a preflight this program never
 * answers.
 */
export function fromOwnPage(request: Request, self: string) {
	return (
		request.headers.get('host') === self &&
		request.headers.get('origin') === `http://${self}` &&
		request.headers.get('content-type') === 'application/json'
	);
}

export function serveMessages({
	root,
	folder,
	port = MESSAGES_PORT,
	answer,
}: {
	/** The built app (`build/`). */
	root: string;
	/** The directory Messages keeps its drafts in (`messagesFolder()`). */
	folder: string;
	port?: number;
	/** Answers one Beeper operation; the operation is not yet validated. */
	answer: (input: unknown) => Promise<BeeperAnswer>;
}) {
	const base = resolve(root);
	const drafts = serveDirectory(folder);
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port,
		async fetch(request) {
			const { pathname } = new URL(request.url);
			if (pathname === '/beeper') return beeper(request);
			if (pathname.startsWith('/folder/')) {
				if (request.method !== 'POST')
					return new Response(null, { status: 405 });
				if (!fromOwnPage(request, self))
					return new Response(null, { status: 403 });
				return drafts.fetch(request);
			}
			if (request.method !== 'GET' && request.method !== 'HEAD')
				return new Response(null, { status: 405 });
			return page(pathname);
		},
	});
	const self = `127.0.0.1:${server.port}`;

	async function beeper(request: Request) {
		if (request.method !== 'POST') return new Response(null, { status: 405 });
		if (!fromOwnPage(request, self)) return new Response(null, { status: 403 });
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

	return {
		url: server.url,
		port: server.port,
		/** Stop serving, and stop watching the drafts' directory. */
		async stop() {
			drafts.close();
			await server.stop(true);
		},
	};
}

if (import.meta.main) {
	const { openBeeper } = await import('@epicenter/cli/messages');
	const folder = messagesFolder();
	const server = serveMessages({
		root: resolve(import.meta.dir, '../build'),
		folder,
		answer: openBeeper().answer,
	});
	console.log(`Messages: ${server.url}`);
	console.log(`Drafts: ${folder}`);
}
