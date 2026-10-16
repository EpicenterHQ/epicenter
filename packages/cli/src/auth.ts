/**
 * The CLI's two sign-ins to the deployment's authorization server, and the
 * one refresh both serve every access token through (ADR-0549, ADR-0558).
 *
 * ```txt
 * grant    client            flow                                   used by
 * device   so.epicenter.cli  device authorization (RFC 8628)        a terminal, an agent
 * desktop  so.epicenter      authorization code, S256 PKCE, on a    only commands Rust runs
 *                            one-shot http://127.0.0.1:<port>/callback   with --desktop
 * ```
 *
 * Each grant is one keychain entry under `so.epicenter.auth`, named by the
 * grant and the deployment, holding its refresh token and the access tokens
 * cached for each audience. A grant asks for every audience the client may
 * reach, and each refresh names one, so that access token is bound to the
 * audience; every first-party audience allows every scope, so the grant keeps
 * them all (ADR-0565).
 *
 * An access token is reused until five minutes before it expires. A refresh
 * runs under a lock file beside the other machine state, and rereads the
 * entry inside it, so two processes never spend one refresh token. A refresh
 * whose answer was lost is sent again: inside the server's 60-second reuse
 * interval the same refresh token gets the same answer. A refresh answered
 * `invalid_grant` is retried once with what the entry then holds.
 *
 * A replay after the reuse interval ends every grant of the client for the
 * person, on every machine (ADR-0565). So a refresh this process has sent is
 * finished before the process exits: a stop signal waits for its keychain
 * write, at most {@link REFRESH_EXIT_GRACE_MS}.
 */

import { join } from 'node:path';
import type {
	AccountAccess,
	EpicenterAccess,
	SecretStore,
} from '@epicenter/ai/send';
import {
	EPICENTER_API_URL,
	resolveOAuthAudiences,
} from '@epicenter/constants/apps';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { resolveAppPaths } from './app-paths.ts';
import { withFileLock } from './file-lock.ts';
import { AUTH_KEYCHAIN_SERVICE, keychain } from './secrets.ts';

/** Which of the CLI's two sign-ins a command uses. */
export type GrantKind = 'device' | 'desktop';

/** Each grant's pre-registered public client. */
export const AUTH_CLIENTS = {
	device: 'so.epicenter.cli',
	desktop: 'so.epicenter',
} as const satisfies Record<GrantKind, string>;

/** Every scope both clients may hold; every first-party audience allows them all. */
const SCOPE = 'openid offline_access profile ai folders:read folders:write';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/** A cached access token is replaced this long before it expires. */
export const REUSE_MARGIN_MS = 5 * 60 * 1000;

/**
 * How long a stop signal waits for a refresh in flight before the process
 * exits anyway. The desktop shell waits longer before it kills (ADR-0565).
 */
export const REFRESH_EXIT_GRACE_MS = 2_000;

/** How long a loopback sign-in waits for the browser. */
const LOOPBACK_TIMEOUT_MS = 10 * 60 * 1000;

/** The deployment the CLI signs in to, and the audiences it requests tokens for. */
export type Deployment = {
	/** The API origin, which is the authorization server's (ADR-0326). */
	origin: string;
	audiences: { api: string; git: string };
};

/** The deployment named by `EPICENTER_API_URL`, or the hosted cloud (ADR-0326). */
export function resolveDeployment(origin = EPICENTER_API_URL): Deployment {
	const { api, git } = resolveOAuthAudiences(origin);
	return { origin: new URL(origin).origin, audiences: { api, git } };
}

/** What every function here reads and writes through. */
export type AuthContext = {
	deployment: Deployment;
	/** The `so.epicenter.auth` keychain service, or a test store. */
	secrets: SecretStore;
	/** Where the per-grant lock files live. */
	lockDir: string;
	fetch: (input: string, init: RequestInit) => Promise<Response>;
	now: () => number;
};

/** The context a command runs in: this machine's keychain, paths, and network. */
export function authContext(): AuthContext {
	return {
		deployment: resolveDeployment(),
		secrets: keychain(AUTH_KEYCHAIN_SERVICE),
		lockDir: join(resolveAppPaths().dataDir, 'auth'),
		fetch: (input, init) => fetch(input, init),
		now: Date.now,
	};
}

/** Who approved a grant, as the server's userinfo answers. */
export type Account = { id: string; name?: string };

type CachedToken = { token: string; expiresAt: number };

/** One grant's keychain entry. */
export type StoredGrant = {
	client: string;
	/** The deployment origin the grant belongs to. */
	issuer: string;
	refreshToken: string;
	/** The scopes the grant holds. */
	scope: string;
	account: Account | null;
	signedInAt: string;
	/** Access tokens by audience. */
	access: Record<string, CachedToken>;
};

export const AuthError = defineErrors({
	/** This machine holds no grant of this kind for the deployment. */
	NotSignedIn: ({ grant, origin }: { grant: GrantKind; origin: string }) => ({
		message:
			grant === 'desktop'
				? `The Epicenter app is not signed in to ${origin}. Sign in from Epicenter's Settings.`
				: `This computer is not signed in to ${origin}. Run: epicenter auth login`,
		grant,
		origin,
	}),
	/** The server refused the grant's refresh token: it was revoked or lapsed. */
	SignInEnded: ({ grant, origin }: { grant: GrantKind; origin: string }) => ({
		message:
			grant === 'desktop'
				? `The Epicenter app's sign-in to ${origin} has ended. Sign in again from Epicenter's Settings.`
				: `This computer's sign-in to ${origin} has ended. Run: epicenter auth login`,
		grant,
		origin,
	}),
	/** The audience is not one this deployment issues tokens for. */
	UnknownResource: ({
		resource,
		known,
	}: {
		resource: string;
		known: string[];
	}) => ({
		message: `${resource} is not a resource of this deployment; use one of ${known.join(', ')}`,
		resource,
		known,
	}),
	/** The server answered a request with an OAuth error. */
	Refused: ({
		what,
		status,
		error,
		description,
	}: {
		what: string;
		status: number;
		error: string;
		description?: string;
	}) => ({
		message: `${what} was refused (${status} ${error})${description ? `: ${description}` : ''}`,
		what,
		status,
		error,
	}),
	/** The server could not be reached, or answered something unreadable. */
	Unreachable: ({ url, reason }: { url: string; reason: string }) => ({
		message: `${url} could not be reached: ${reason}`,
		url,
		reason,
	}),
	/** The keychain could not be read or written. */
	KeychainUnavailable: ({ reason }: { reason: string }) => ({
		message: `This computer's keychain could not be used: ${reason}`,
		reason,
	}),
	/** The person did not finish signing in. */
	SignInStopped: ({ reason }: { reason: string }) => ({
		message: `Signing in stopped: ${reason}`,
		reason,
	}),
});
export type AuthError = InferErrors<typeof AuthError>;

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

// ---------------------------------------------------------------------------
// The keychain entry

const entryName = (ctx: AuthContext, grant: GrantKind) =>
	`${grant} ${ctx.deployment.origin}`;

function readStored(text: string | null): StoredGrant | null {
	if (text === null) return null;
	try {
		const value = JSON.parse(text) as StoredGrant;
		return typeof value?.refreshToken === 'string' &&
			typeof value.client === 'string'
			? { ...value, access: value.access ?? {} }
			: null;
	} catch {
		return null;
	}
}

export async function readGrant(
	ctx: AuthContext,
	grant: GrantKind,
): Promise<Result<StoredGrant | null, AuthError>> {
	try {
		return Ok(readStored(await ctx.secrets.get(entryName(ctx, grant))));
	} catch (cause) {
		return AuthError.KeychainUnavailable({ reason: describe(cause) });
	}
}

async function writeGrant(
	ctx: AuthContext,
	grant: GrantKind,
	stored: StoredGrant,
): Promise<Result<undefined, AuthError>> {
	try {
		await ctx.secrets.set(entryName(ctx, grant), JSON.stringify(stored));
		return Ok(undefined);
	} catch (cause) {
		return AuthError.KeychainUnavailable({ reason: describe(cause) });
	}
}

const lockPath = (ctx: AuthContext, grant: GrantKind) =>
	join(ctx.lockDir, `${grant}.lock`);

// ---------------------------------------------------------------------------
// Requests to the authorization server

type TokenAnswer = {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	scope?: string;
	error?: string;
	error_description?: string;
	interval?: number;
};

async function post(
	ctx: AuthContext,
	path: string,
	form: Record<string, string | string[]>,
): Promise<Result<{ status: number; body: TokenAnswer }, AuthError>> {
	const url = `${ctx.deployment.origin}/auth${path}`;
	const body = new URLSearchParams();
	for (const [key, value] of Object.entries(form))
		for (const item of [value].flat()) body.append(key, item);
	let response: Response;
	try {
		response = await ctx.fetch(url, {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				accept: 'application/json',
			},
			body: body.toString(),
			redirect: 'manual',
		});
	} catch (cause) {
		return AuthError.Unreachable({ url, reason: describe(cause) });
	}
	const text = await response.text();
	try {
		return Ok({
			status: response.status,
			body: (text ? JSON.parse(text) : {}) as TokenAnswer,
		});
	} catch {
		return AuthError.Unreachable({
			url,
			reason: `answered ${response.status} with a body that is not JSON`,
		});
	}
}

function refused(what: string, status: number, body: TokenAnswer) {
	return AuthError.Refused({
		what,
		status,
		error: body.error ?? 'unknown_error',
		description: body.error_description,
	});
}

/** Who approved the grant, from the server's userinfo, or null when it will not say. */
async function readAccount(
	ctx: AuthContext,
	accessToken: string,
): Promise<Account | null> {
	try {
		const response = await ctx.fetch(
			`${ctx.deployment.origin}/auth/oauth2/userinfo`,
			{ headers: { authorization: `Bearer ${accessToken}` } },
		);
		if (!response.ok) return null;
		const info = (await response.json()) as { sub?: unknown; name?: unknown };
		if (typeof info.sub !== 'string') return null;
		return typeof info.name === 'string' && info.name !== ''
			? { id: info.sub, name: info.name }
			: { id: info.sub };
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Access tokens

/** The audiences this deployment issues tokens for, in the order help names them. */
export function knownAudiences(ctx: AuthContext) {
	return [ctx.deployment.audiences.api, ctx.deployment.audiences.git];
}

const usable = (ctx: AuthContext, cached: CachedToken | undefined) =>
	cached !== undefined && cached.expiresAt - ctx.now() > REUSE_MARGIN_MS;

/** Refreshes this process has sent and not yet written to the keychain. */
const refreshesInFlight = new Set<Promise<void>>();
const STOP_SIGNALS = { SIGTERM: 15, SIGINT: 2, SIGHUP: 1 } as const;
const STOP_SIGNAL_NAMES = Object.keys(
	STOP_SIGNALS,
) as (keyof typeof STOP_SIGNALS)[];
let stopping = false;

function stopAfterRefreshes(signal: keyof typeof STOP_SIGNALS) {
	if (stopping) return;
	stopping = true;
	void refreshesSettled().then(() => process.exit(128 + STOP_SIGNALS[signal]));
}

/**
 * Resolves when no refresh is in flight in this process, or after
 * `graceMs`. A command with its own stop handler awaits it before exiting.
 */
export async function refreshesSettled(
	graceMs = REFRESH_EXIT_GRACE_MS,
): Promise<void> {
	if (refreshesInFlight.size === 0) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		Promise.allSettled([...refreshesInFlight]),
		new Promise((done) => {
			timer = setTimeout(done, graceMs);
		}),
	]);
	clearTimeout(timer);
}

/**
 * Run a refresh so that a stop signal waits for it. The server rotates the
 * refresh token when it answers, so exiting before the keychain write keeps a
 * spent token, and the next refresh would be a replay.
 */
async function finishBeforeExit<T>(work: () => Promise<T>): Promise<T> {
	const done = Promise.withResolvers<void>();
	refreshesInFlight.add(done.promise);
	if (refreshesInFlight.size === 1)
		for (const signal of STOP_SIGNAL_NAMES)
			process.on(signal, stopAfterRefreshes);
	try {
		return await work();
	} finally {
		done.resolve();
		refreshesInFlight.delete(done.promise);
		if (refreshesInFlight.size === 0 && !stopping)
			for (const signal of STOP_SIGNAL_NAMES)
				process.off(signal, stopAfterRefreshes);
	}
}

/** One refresh for `audience` with `stored`'s refresh token, written back on success. */
function refreshOnce(
	ctx: AuthContext,
	grant: GrantKind,
	stored: StoredGrant,
	audience: string,
): Promise<Result<StoredGrant, AuthError | 'invalid_grant'>> {
	return finishBeforeExit(() => sendRefresh(ctx, grant, stored, audience));
}

async function sendRefresh(
	ctx: AuthContext,
	grant: GrantKind,
	stored: StoredGrant,
	audience: string,
): Promise<Result<StoredGrant, AuthError | 'invalid_grant'>> {
	const form = {
		grant_type: 'refresh_token',
		client_id: stored.client,
		refresh_token: stored.refreshToken,
		resource: audience,
	};
	let answer = await post(ctx, '/oauth2/token', form);
	// The answer may have been lost after the server rotated the token; the
	// same request inside the reuse interval gets the same answer.
	if (answer.error?.name === 'Unreachable')
		answer = await post(ctx, '/oauth2/token', form);
	if (answer.error !== null) return Err(answer.error);
	const { status, body } = answer.data;
	if (status === 400 && body.error === 'invalid_grant')
		return Err('invalid_grant');
	if (
		status !== 200 ||
		typeof body.access_token !== 'string' ||
		typeof body.refresh_token !== 'string'
	)
		return refused('Refreshing the sign-in', status, body);
	const next: StoredGrant = {
		...stored,
		refreshToken: body.refresh_token,
		access: {
			...stored.access,
			[audience]: {
				token: body.access_token,
				expiresAt: ctx.now() + (body.expires_in ?? 0) * 1000,
			},
		},
	};
	const { error } = await writeGrant(ctx, grant, next);
	if (error !== null) return Err(error);
	return Ok(next);
}

/**
 * An access token for `audience` from `grant`: the cached one while it has
 * more than five minutes left, otherwise a refresh under the grant's lock.
 */
export async function accessToken(
	ctx: AuthContext,
	grant: GrantKind,
	audience: string = ctx.deployment.audiences.api,
): Promise<Result<CachedToken, AuthError>> {
	if (!knownAudiences(ctx).includes(audience))
		return AuthError.UnknownResource({
			resource: audience,
			known: knownAudiences(ctx),
		});
	const outside = await readGrant(ctx, grant);
	if (outside.error !== null) return Err(outside.error);
	if (outside.data === null)
		return AuthError.NotSignedIn({ grant, origin: ctx.deployment.origin });
	const cached = outside.data.access[audience];
	if (cached && usable(ctx, cached)) return Ok(cached);

	return withFileLock(lockPath(ctx, grant), async () => {
		// Another process may have refreshed while this one waited.
		const inside = await readGrant(ctx, grant);
		if (inside.error !== null) return Err(inside.error);
		if (inside.data === null)
			return AuthError.NotSignedIn({ grant, origin: ctx.deployment.origin });
		const reread = inside.data.access[audience];
		if (reread && usable(ctx, reread)) return Ok(reread);
		let refreshed = await refreshOnce(ctx, grant, inside.data, audience);
		if (refreshed.error === 'invalid_grant') {
			// A writer outside this lock may have rotated it; try what the entry
			// holds now, once.
			const again = await readGrant(ctx, grant);
			if (again.error !== null) return Err(again.error);
			if (again.data === null)
				return AuthError.NotSignedIn({ grant, origin: ctx.deployment.origin });
			refreshed = await refreshOnce(ctx, grant, again.data, audience);
		}
		if (refreshed.error === 'invalid_grant')
			return AuthError.SignInEnded({ grant, origin: ctx.deployment.origin });
		if (refreshed.error !== null) return Err(refreshed.error);
		const token = refreshed.data.access[audience];
		return token
			? Ok(token)
			: AuthError.Unreachable({
					url: ctx.deployment.origin,
					reason: 'the refresh answered no access token',
				});
	});
}

/**
 * What an Epicenter connection's `send` sends with: the deployment's `/v1`
 * and an API access token from `grant`, or why there is none.
 */
export function epicenterAccess(
	ctx: AuthContext,
	grant: GrantKind,
): EpicenterAccess {
	return async () => {
		const { data, error } = await accessToken(
			ctx,
			grant,
			ctx.deployment.audiences.api,
		);
		return error === null
			? Ok({ endpoint: `${ctx.deployment.origin}/v1`, key: data.token })
			: Err(error.message);
	};
}

/**
 * What an account request's `send` sends with: the deployment's origin and
 * an access token from `grant` for the resource the request names, or why
 * there is none. The resource is one of the deployment's by role, never an
 * audience the request spells out (ADR-0549).
 */
export function accountAccess(
	ctx: AuthContext,
	grant: GrantKind,
): AccountAccess {
	return async (audience) => {
		const { data, error } = await accessToken(
			ctx,
			grant,
			ctx.deployment.audiences[audience],
		);
		return error === null
			? Ok({ endpoint: ctx.deployment.origin, key: data.token })
			: Err(error.message);
	};
}

// ---------------------------------------------------------------------------
// Signing in

/** Store a new grant, cache an API token, and learn who approved it. */
async function keepGrant(
	ctx: AuthContext,
	grant: GrantKind,
	issued: TokenAnswer,
	/** The audience `issued.access_token` is bound to. */
	issuedFor: string,
): Promise<Result<StoredGrant, AuthError>> {
	if (typeof issued.refresh_token !== 'string')
		return AuthError.Refused({
			what: 'Signing in',
			status: 200,
			error: 'no_refresh_token',
			description: 'the server issued no refresh token',
		});
	const stored: StoredGrant = {
		client: AUTH_CLIENTS[grant],
		issuer: ctx.deployment.origin,
		refreshToken: issued.refresh_token,
		scope: SCOPE,
		account: null,
		signedInAt: new Date(ctx.now()).toISOString(),
		access:
			typeof issued.access_token === 'string'
				? {
						[issuedFor]: {
							token: issued.access_token,
							expiresAt: ctx.now() + (issued.expires_in ?? 0) * 1000,
						},
					}
				: {},
	};
	const written = await withFileLock(lockPath(ctx, grant), () =>
		writeGrant(ctx, grant, stored),
	);
	if (written.error !== null) return Err(written.error);
	const api = await accessToken(ctx, grant, ctx.deployment.audiences.api);
	if (api.error !== null) return Err(api.error);
	const account = await readAccount(ctx, api.data.token);
	return withFileLock(lockPath(ctx, grant), async () => {
		const current = await readGrant(ctx, grant);
		if (current.error !== null) return Err(current.error);
		const next = { ...(current.data ?? stored), account };
		const { error } = await writeGrant(ctx, grant, next);
		return error === null ? Ok(next) : Err(error);
	});
}

/** What the device grant shows the person: the code and where to enter it. */
export type DeviceCode = {
	userCode: string;
	verificationUri: string;
	verificationUriComplete?: string;
	expiresIn: number;
};

/**
 * `epicenter auth login`: the device grant as `so.epicenter.cli`. Hands the
 * code to `onCode`, then polls at the server's interval until the person
 * approves or denies it, or it expires.
 */
export async function loginWithDevice(
	ctx: AuthContext,
	{
		onCode,
		sleep = (ms) => Bun.sleep(ms),
	}: {
		onCode: (code: DeviceCode) => void;
		sleep?: (ms: number) => Promise<void>;
	},
): Promise<Result<StoredGrant, AuthError>> {
	const { audiences } = ctx.deployment;
	const started = await post(ctx, '/device/code', {
		client_id: AUTH_CLIENTS.device,
		scope: SCOPE,
		resource: [audiences.api, audiences.git],
	});
	if (started.error !== null) return Err(started.error);
	const device = started.data.body as TokenAnswer & {
		device_code?: string;
		user_code?: string;
		verification_uri?: string;
		verification_uri_complete?: string;
		expires_in?: number;
	};
	if (
		started.data.status !== 200 ||
		!device.device_code ||
		!device.user_code ||
		!device.verification_uri
	)
		return refused('Starting the device sign-in', started.data.status, device);
	const absolute = (uri: string) => new URL(uri, ctx.deployment.origin).href;
	onCode({
		userCode: device.user_code,
		verificationUri: absolute(device.verification_uri),
		...(device.verification_uri_complete && {
			verificationUriComplete: absolute(device.verification_uri_complete),
		}),
		expiresIn: device.expires_in ?? 600,
	});
	let interval = (device.interval ?? 5) * 1000;
	const deadline = ctx.now() + (device.expires_in ?? 600) * 1000;
	while (ctx.now() < deadline) {
		await sleep(interval);
		const polled = await post(ctx, '/oauth2/token', {
			grant_type: DEVICE_GRANT,
			client_id: AUTH_CLIENTS.device,
			device_code: device.device_code,
			resource: audiences.api,
		});
		if (polled.error !== null) {
			if (polled.error.name === 'Unreachable') continue;
			return Err(polled.error);
		}
		const { status, body } = polled.data;
		if (status === 200) return keepGrant(ctx, 'device', body, audiences.api);
		if (body.error === 'authorization_pending') continue;
		if (body.error === 'slow_down') {
			interval += 5000;
			continue;
		}
		if (body.error === 'access_denied')
			return AuthError.SignInStopped({ reason: 'the code was denied' });
		if (body.error === 'expired_token') break;
		return refused('Signing in', status, body);
	}
	return AuthError.SignInStopped({
		reason: 'the code expired before it was approved',
	});
}

function base64url(bytes: Uint8Array) {
	return Buffer.from(bytes).toString('base64url');
}

const CALLBACK_PAGE = (heading: string, text: string) =>
	new Response(
		`<!doctype html><meta charset="utf-8"><title>Epicenter</title><h1>${heading}</h1><p>${text}</p>`,
		{ headers: { 'content-type': 'text/html; charset=utf-8' } },
	);

/**
 * `epicenter auth login --loopback`: the desktop app's sign-in as
 * `so.epicenter`, authorization code with S256 PKCE. A one-shot listener on
 * `http://127.0.0.1:<random port>/callback` receives the code; `onUrl` gets
 * the page to open in the browser.
 */
export async function loginWithLoopback(
	ctx: AuthContext,
	{
		onUrl,
		timeoutMs = LOOPBACK_TIMEOUT_MS,
	}: {
		onUrl: (url: string) => void | Promise<void>;
		timeoutMs?: number;
	},
): Promise<Result<StoredGrant, AuthError>> {
	const { audiences, origin } = ctx.deployment;
	const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
	const challenge = base64url(
		new Uint8Array(
			await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
		),
	);
	const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
	const received = Promise.withResolvers<Result<string, AuthError>>();
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			if (
				url.pathname !== '/callback' ||
				url.searchParams.get('state') !== state
			)
				return new Response('Not found', { status: 404 });
			const code = url.searchParams.get('code');
			if (code) {
				received.resolve(Ok(code));
				return CALLBACK_PAGE(
					'Signed in to Epicenter',
					'You can close this tab and return to Epicenter.',
				);
			}
			const error = url.searchParams.get('error') ?? 'no code';
			received.resolve(
				AuthError.SignInStopped({
					reason: url.searchParams.get('error_description') ?? error,
				}),
			);
			return CALLBACK_PAGE(
				'Not signed in',
				'Return to Epicenter and try again.',
			);
		},
	});
	const redirectUri = `http://127.0.0.1:${server.port}/callback`;
	const timer = setTimeout(
		() =>
			received.resolve(
				AuthError.SignInStopped({
					reason: 'the browser did not return within ten minutes',
				}),
			),
		timeoutMs,
	);
	try {
		const authorize = new URL(`${origin}/auth/oauth2/authorize`);
		for (const [key, value] of Object.entries({
			response_type: 'code',
			client_id: AUTH_CLIENTS.desktop,
			redirect_uri: redirectUri,
			scope: SCOPE,
			state,
			code_challenge: challenge,
			code_challenge_method: 'S256',
		}))
			authorize.searchParams.set(key, value);
		authorize.searchParams.append('resource', audiences.api);
		authorize.searchParams.append('resource', audiences.git);
		await onUrl(authorize.href);
		const code = await received.promise;
		if (code.error !== null) return Err(code.error);
		const exchanged = await post(ctx, '/oauth2/token', {
			grant_type: 'authorization_code',
			client_id: AUTH_CLIENTS.desktop,
			code: code.data,
			code_verifier: verifier,
			redirect_uri: redirectUri,
			resource: audiences.api,
		});
		if (exchanged.error !== null) return Err(exchanged.error);
		if (exchanged.data.status !== 200)
			return refused('Signing in', exchanged.data.status, exchanged.data.body);
		return keepGrant(ctx, 'desktop', exchanged.data.body, audiences.api);
	} finally {
		clearTimeout(timer);
		void server.stop();
	}
}

// ---------------------------------------------------------------------------
// Status and signing out

/** One grant as `auth status` reports it. */
export type GrantStatus =
	| { grant: GrantKind; client: string; signedIn: false }
	| {
			grant: GrantKind;
			client: string;
			signedIn: true;
			account: Account | null;
			scope: string;
			signedInAt: string;
	  };

/** Both grants for this deployment, from the keychain alone. */
export async function authStatus(
	ctx: AuthContext,
): Promise<Result<GrantStatus[], AuthError>> {
	const grants: GrantStatus[] = [];
	for (const grant of ['device', 'desktop'] as const) {
		const { data, error } = await readGrant(ctx, grant);
		if (error !== null) return Err(error);
		grants.push(
			data === null
				? { grant, client: AUTH_CLIENTS[grant], signedIn: false }
				: {
						grant,
						client: data.client,
						signedIn: true,
						account: data.account,
						scope: data.scope,
						signedInAt: data.signedInAt,
					},
		);
	}
	return Ok(grants);
}

/**
 * Sign `grant` out: revoke its refresh token and every access token it has
 * cached at the server, then delete its keychain entry. Revoking the refresh
 * token ends only the access tokens of its latest rotation, and each audience's
 * token usually comes from a different one, so each is revoked by name. The
 * entry is deleted even when the server cannot be reached; `revoked` says
 * whether it heard every revocation.
 */
export async function logout(
	ctx: AuthContext,
	grant: GrantKind,
): Promise<Result<{ signedOut: boolean; revoked: boolean }, AuthError>> {
	return withFileLock(lockPath(ctx, grant), async () => {
		const { data: stored, error } = await readGrant(ctx, grant);
		if (error !== null) return Err(error);
		if (stored === null) return Ok({ signedOut: false, revoked: false });
		const revocations = [
			{ token: stored.refreshToken, hint: 'refresh_token' },
			...Object.values(stored.access).map(({ token }) => ({
				token,
				hint: 'access_token',
			})),
		];
		let revoked = true;
		for (const { token, hint } of revocations) {
			const answer = await post(ctx, '/oauth2/revoke', {
				client_id: stored.client,
				token,
				token_type_hint: hint,
			});
			if (answer.error !== null || answer.data.status !== 200) revoked = false;
		}
		try {
			await ctx.secrets.delete(entryName(ctx, grant));
		} catch (cause) {
			return AuthError.KeychainUnavailable({ reason: describe(cause) });
		}
		return Ok({ signedOut: true, revoked });
	});
}

// ---------------------------------------------------------------------------
// Git's credential helper

/** Git's credential protocol: `key=value` lines up to a blank line. */
export function parseCredentialRequest(text: string): Map<string, string> {
	const fields = new Map<string, string>();
	for (const line of text.split('\n')) {
		const trimmed = line.replace(/\r$/, '');
		if (trimmed === '') break;
		const equals = trimmed.indexOf('=');
		if (equals > 0)
			fields.set(trimmed.slice(0, equals), trimmed.slice(equals + 1));
	}
	return fields;
}

/** Whether Git is asking about the deployment's Git audience. */
export function isGitAudience(
	ctx: AuthContext,
	fields: Map<string, string>,
): boolean {
	const audience = new URL(ctx.deployment.audiences.git);
	if (fields.get('protocol') !== audience.protocol.slice(0, -1)) return false;
	if (fields.get('host') !== audience.host) return false;
	const path = fields.get('path');
	const prefix = audience.pathname.replace(/^\/+|\/+$/g, '');
	return (
		path === undefined ||
		prefix === '' ||
		path === prefix ||
		path.startsWith(`${prefix}/`)
	);
}

/**
 * Git's `get`: a username, the Git audience's access token as the password,
 * and when it expires. Undefined when Git asks about another host, so Git
 * moves on to its next helper.
 */
export async function gitCredential(
	ctx: AuthContext,
	grant: GrantKind,
	request: string,
): Promise<Result<string | undefined, AuthError>> {
	const fields = parseCredentialRequest(request);
	if (!isGitAudience(ctx, fields)) return Ok(undefined);
	const { data, error } = await accessToken(
		ctx,
		grant,
		ctx.deployment.audiences.git,
	);
	if (error !== null) return Err(error);
	return Ok(
		[
			'username=epicenter',
			`password=${data.token}`,
			`password_expiry_utc=${Math.floor(data.expiresAt / 1000)}`,
			'',
		].join('\n'),
	);
}

/** One argument for `sh`, single-quoted. */
export const shellQuote = (value: string) =>
	`'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Make this CLI Git's credential helper for the deployment's Git audience in
 * the person's global configuration (ADR-0558). An empty helper first clears
 * the helpers a broader configuration set, so no other helper is asked to
 * store the token.
 */
export async function configureGitHelper(
	ctx: AuthContext,
	command: readonly string[],
	env: Record<string, string | undefined> = process.env,
): Promise<Result<string, string>> {
	const key = `credential.${ctx.deployment.audiences.git}.helper`;
	const helper = `!${command.map(shellQuote).join(' ')} auth git-credential`;
	const run = async (args: string[]) => {
		try {
			const child = Bun.spawn(['git', 'config', '--global', ...args], {
				env,
				stdout: 'ignore',
				stderr: 'pipe',
			});
			const [code, stderr] = await Promise.all([
				child.exited,
				new Response(child.stderr).text(),
			]);
			return code === 0 ? null : stderr.trim() || `git exited ${code}`;
		} catch (cause) {
			return describe(cause);
		}
	};
	const failed =
		(await run(['--replace-all', key, ''])) ??
		(await run(['--add', key, helper]));
	return failed === null ? Ok(helper) : Err(failed);
}

/**
 * How Git runs this CLI: the compiled binary by its own path, or `bun` and
 * the entry when run from source.
 */
export function selfCommand(): string[] {
	const compiled =
		Bun.main.startsWith('/$bunfs/') || /^[A-Z]:[\\/]~BUN[\\/]/i.test(Bun.main);
	return compiled ? [process.execPath] : [process.execPath, Bun.main];
}
