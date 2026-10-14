/**
 * Hosted Git: a folder syncs over plain Git smart HTTP with a token (ADR-0521).
 *
 * Two planes share one {@link GitRepositoryStore}:
 *
 *   - `POST /api/git/connect` `{ folder }` (session auth): find or create the
 *     signed-in principal's repository for `folder` and answer
 *     `{ remote, token, expiresAt, expiresIn }`. `expiresIn` is the token's
 *     remaining life in seconds by this server's clock, so a client times its
 *     renewal without trusting its own. It lives under `/api/` because the
 *     desktop host's account relay forwards only `/api/` and `/v1/`.
 *   - `/git/<name>.git/{info/refs,git-upload-pack,git-receive-pack}`: the Git
 *     data plane. The repository token in `Authorization` is the credential and
 *     the store's backend checks it, so this plane does no session auth. It sits
 *     outside `/api/` because the cookie-CSRF guard there would refuse a
 *     terminal `git push` that carries Basic auth and no `Origin`.
 *
 * CORS comes from `createServerApp`'s credentialed trusted-origin middleware,
 * which also decorates 401s and answers preflights without a token.
 *
 * Failures answer `{ name, message }`:
 *   - 400 `InvalidFolder`   the folder is not a managed folder name.
 *   - 401 `MissingToken`    a Git request carried no `Authorization`.
 *   - 503 `GitUnavailable`  the deployment has no repository store.
 *   - 502 `GitStoreFailed`  the store threw while connecting or forwarding.
 * An upstream Git response, 401 and 403 included, is forwarded with its status.
 *
 * Hosted Git is unmetered, like hosted blobs: Autumn denies by default without
 * a plan, so this mount takes no billing policy.
 */

import { isAppId } from '@epicenter/constants/app-id';
import type { PrincipalId } from '@epicenter/principal';
import type { Context, Handler, Hono, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import type { Env } from '../types.js';

export type GitService = 'git-upload-pack' | 'git-receive-pack';

/** The replaceable part of hosted Git: Artifacts on the cloud, none on self-host yet. */
export type GitRepositoryStore = {
	/**
	 * Find or create `principal`'s repository for `folder`, and mint a write
	 * token for it alone. Throws when the backend fails; a missing repository
	 * is created, never reported.
	 */
	connect(
		principal: PrincipalId,
		folder: string,
	): Promise<{ name: string; token: string; expiresAt: string }>;
	/**
	 * Forward one validated smart-HTTP request for repository `name`. The
	 * backend checks the token in `headers`. Throws only when the backend
	 * cannot be reached.
	 */
	serve(
		name: string,
		request: {
			service: GitService;
			/** `GET info/refs?service=...` rather than `POST <service>`. */
			advertisement: boolean;
			headers: Headers;
			body: ReadableStream<Uint8Array> | null;
			signal: AbortSignal;
		},
	): Promise<Response>;
};

/** The bytes a managed folder name may take. */
const MAX_FOLDER_BYTES = 64;
const REPOSITORY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GIT_PATH =
	/^\/git\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const FORWARDED_HEADERS = [
	'authorization',
	'content-type',
	'content-encoding',
	'accept',
	'git-protocol',
];

/** Refusals a client branches on. The wire carries `{ name, message }`. */
const GitRefusal = defineErrors({
	InvalidFolder: () => ({
		message:
			'The folder must be two or more lowercase dot-separated labels of letters, digits, and hyphens, at most 64 bytes.',
		status: 400 as const,
	}),
	MissingToken: () => ({
		message: 'Send the repository token in the Authorization header.',
		status: 401 as const,
	}),
	GitStoreFailed: () => ({
		message: 'The repository could not be reached.',
		status: 502 as const,
	}),
	GitUnavailable: () => ({
		message: 'This server does not host Git repositories.',
		status: 503 as const,
	}),
});

/** Operator diagnostics. Their causes stay in the log, off the wire. */
const GitError = defineErrors({
	ConnectFailed: ({ cause }: { cause: unknown }) => ({
		message: `Could not connect a folder's repository: ${extractErrorMessage(cause)}`,
		cause,
	}),
	ForwardFailed: ({ cause }: { cause: unknown }) => ({
		message: `Could not forward a Git request: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

const log = createLogger('git');

function refuse(
	c: Context<Env>,
	{
		error,
	}: {
		error: { name: string; message: string; status: ContentfulStatusCode };
	},
	headers?: Record<string, string>,
) {
	return c.json(
		{ name: error.name, message: error.message },
		error.status,
		headers,
	);
}

/** Whether `folder` is a managed folder name: a reverse-domain id of at most 64 bytes. */
function isManagedFolder(folder: unknown): folder is string {
	return (
		typeof folder === 'string' &&
		folder.length <= MAX_FOLDER_BYTES &&
		isAppId(folder)
	);
}

/** Mount hosted Git's connect route and data plane on a deployment's server app. */
export function mountGitApp<E extends Env>(
	app: Hono<E>,
	{
		auth,
		resolveStore,
	}: {
		auth: MiddlewareHandler<E>;
		/** `null` answers 503 `GitUnavailable` on both planes. */
		resolveStore: (env: E['Bindings']) => GitRepositoryStore | null;
	},
): void {
	const connect: Handler<Env> = async (c) => {
		const store = resolveStore(c.env);
		if (!store) return refuse(c, GitRefusal.GitUnavailable());
		const body: unknown = await c.req.json().catch(() => null);
		const folder =
			typeof body === 'object' && body !== null && 'folder' in body
				? body.folder
				: undefined;
		if (!isManagedFolder(folder)) return refuse(c, GitRefusal.InvalidFolder());
		let repository: Awaited<ReturnType<GitRepositoryStore['connect']>>;
		try {
			repository = await store.connect(c.var.principal.id, folder);
		} catch (cause) {
			log.error(GitError.ConnectFailed({ cause }).error);
			return refuse(c, GitRefusal.GitStoreFailed());
		}
		return c.json(
			{
				remote: `${c.var.authBaseURL}/git/${repository.name}.git`,
				token: repository.token,
				expiresAt: repository.expiresAt,
				expiresIn: Math.max(
					0,
					Math.floor((Date.parse(repository.expiresAt) - Date.now()) / 1000),
				),
			},
			200,
			{ 'cache-control': 'no-store' },
		);
	};
	app.post('/api/git/connect', auth, connect);

	const serve: Handler<Env> = async (c) => {
		const url = new URL(c.req.url);
		const match = GIT_PATH.exec(url.pathname);
		const name = match?.[1];
		const endpoint = match?.[2];
		if (!name || !endpoint || !REPOSITORY_NAME.test(name)) return c.notFound();
		const advertisement = endpoint === 'info/refs';
		let service: GitService;
		if (advertisement) {
			const params = [...url.searchParams];
			const requested = params[0]?.[0] === 'service' ? params[0][1] : null;
			if (
				c.req.method !== 'GET' ||
				params.length !== 1 ||
				(requested !== 'git-upload-pack' && requested !== 'git-receive-pack')
			)
				return c.notFound();
			service = requested;
		} else {
			if (c.req.method !== 'POST' || url.search) return c.notFound();
			service = endpoint as GitService;
		}

		const store = resolveStore(c.env);
		if (!store) return refuse(c, GitRefusal.GitUnavailable());
		// A browser must see a readable 401, not a login prompt; terminal Git
		// sends no Origin and may need the challenge to ask for credentials.
		const fromBrowser = c.req.header('origin') !== undefined;
		if (!c.req.header('authorization'))
			return refuse(
				c,
				GitRefusal.MissingToken(),
				fromBrowser ? undefined : { 'www-authenticate': 'Basic realm="Git"' },
			);

		const headers = new Headers();
		for (const header of FORWARDED_HEADERS) {
			const value = c.req.header(header);
			if (value !== undefined) headers.set(header, value);
		}
		let upstream: Response;
		try {
			upstream = await store.serve(name, {
				service,
				advertisement,
				headers,
				body: advertisement ? null : c.req.raw.body,
				signal: c.req.raw.signal,
			});
		} catch (cause) {
			if (!c.req.raw.signal.aborted)
				log.error(GitError.ForwardFailed({ cause }).error);
			return refuse(c, GitRefusal.GitStoreFailed());
		}
		const responseHeaders = new Headers(upstream.headers);
		responseHeaders.delete('set-cookie');
		if (fromBrowser) responseHeaders.delete('www-authenticate');
		return new Response(upstream.body, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers: responseHeaders,
		});
	};
	app.all('/git/*', serve);
}
