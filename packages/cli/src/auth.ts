/**
 * The CLI's sign-in to the deployment's authorization server, and the one
 * refresh every access token comes through (ADR-0549): the device grant
 * (RFC 8628) as the CLI's own client, `so.epicenter.cli`, for a terminal or
 * an agent. The CLI is its own program with its own sign-in (ADR-0793); the
 * Epicenter app signs in as `so.epicenter` through its shell, and nothing
 * here serves it.
 *
 * The grant is one keychain entry under `so.epicenter.auth`, named `device`
 * and the deployment, holding its refresh token and the access tokens
 * cached for each audience. The grant asks for every audience the client may
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
 * write, at most `STOP_GRACE_MS` (`stop.ts`).
 */

import { join } from 'node:path';
import {
	EPICENTER_API_URL,
	resolveOAuthAudiences,
} from '@epicenter/definition/site';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { resolveAppPaths } from './app-paths.ts';
import { holdingFileLock } from './file-lock.ts';
import {
	AUTH_KEYCHAIN_SERVICE,
	keychain,
	type SecretStore,
} from './secrets.ts';
import { finishBeforeExit } from './stop.ts';

/** The CLI's pre-registered public client. */
export const AUTH_CLIENT = 'so.epicenter.cli';

/**
 * The name the grant's keychain entry and lock file start with: `device`,
 * the name it has always been filed under, so a sign-in survives an update.
 */
const ENTRY = 'device';

/** Every scope the client may hold; every first-party audience allows them all. */
const SCOPE =
	'openid offline_access profile ai folders:read folders:write folders:all';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/** A cached access token is replaced this long before it expires. */
export const REUSE_MARGIN_MS = 5 * 60 * 1000;

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
	/** Where the grant's lock file lives. */
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
	/** Nonsecret identity of this sign-in. Unchanged by token refresh. */
	generation: string;
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
	/** This machine holds no grant for the deployment. */
	NotSignedIn: ({ origin }: { origin: string }) => ({
		message: `This computer is not signed in to ${origin}. Run: epicenter auth login`,
		origin,
	}),
	/** The server refused the grant's refresh token: it was revoked or lapsed. */
	SignInEnded: ({ origin }: { origin: string }) => ({
		message: `This computer's sign-in to ${origin} has ended. Run: epicenter auth login`,
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
	GrantChanged: () => ({
		message: 'The sign-in changed. Open a new Account before sending.',
	}),
});
export type AuthError = InferErrors<typeof AuthError>;

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

// ---------------------------------------------------------------------------
// The keychain entry

const entryName = (ctx: AuthContext) => `${ENTRY} ${ctx.deployment.origin}`;

function readStored(text: string | null): StoredGrant | null {
	if (text === null) return null;
	try {
		const value = JSON.parse(text) as StoredGrant;
		return typeof value?.refreshToken === 'string' &&
			typeof value.client === 'string' &&
			typeof value.generation === 'string' &&
			typeof value.access === 'object' &&
			value.access !== null
			? value
			: null;
	} catch {
		return null;
	}
}

export async function readGrant(
	ctx: AuthContext,
): Promise<Result<StoredGrant | null, AuthError>> {
	try {
		return Ok(readStored(await ctx.secrets.get(entryName(ctx))));
	} catch (cause) {
		return AuthError.KeychainUnavailable({ reason: describe(cause) });
	}
}

async function writeGrant(
	ctx: AuthContext,
	stored: StoredGrant,
): Promise<Result<undefined, AuthError>> {
	try {
		await ctx.secrets.set(entryName(ctx), JSON.stringify(stored));
		return Ok(undefined);
	} catch (cause) {
		return AuthError.KeychainUnavailable({ reason: describe(cause) });
	}
}

/**
 * Run `work` holding the grant's lock, one process at a time on this machine
 * (`holdingFileLock`), so two processes never spend one refresh token
 * (ADR-0549). A cached token answers without it.
 */
async function holdingGrantLock<T>(
	ctx: AuthContext,
	work: () => Promise<T>,
): Promise<T> {
	const path = join(ctx.lockDir, `${ENTRY}.lock`);
	return holdingFileLock(
		path,
		{
			waitMs: 60_000,
			held: `another epicenter process has held ${path} for over 60 seconds`,
		},
		work,
	);
}

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

/** One refresh for `audience` with `stored`'s refresh token, written back on success. */
function refreshOnce(
	ctx: AuthContext,
	stored: StoredGrant,
	audience: string,
): Promise<Result<StoredGrant, AuthError | 'invalid_grant'>> {
	// The server rotates the refresh token when it answers, so exiting before
	// the keychain write keeps a spent token, and the next refresh would be
	// a replay: a stop signal waits for it.
	return finishBeforeExit(() => sendRefresh(ctx, stored, audience));
}

async function sendRefresh(
	ctx: AuthContext,
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
	const { error } = await writeGrant(ctx, next);
	if (error !== null) return Err(error);
	return Ok(next);
}

/**
 * An access token for `audience` from the grant: the cached one while it has
 * more than five minutes left, otherwise a refresh under the grant's lock.
 */
export async function accessToken(
	ctx: AuthContext,
	audience: string = ctx.deployment.audiences.api,
	expectedGeneration?: string,
): Promise<Result<CachedToken, AuthError>> {
	if (!knownAudiences(ctx).includes(audience))
		return AuthError.UnknownResource({
			resource: audience,
			known: knownAudiences(ctx),
		});
	const outside = await readGrant(ctx);
	if (outside.error !== null) return Err(outside.error);
	if (outside.data === null)
		return AuthError.NotSignedIn({ origin: ctx.deployment.origin });
	if (
		expectedGeneration !== undefined &&
		outside.data.generation !== expectedGeneration
	)
		return AuthError.GrantChanged();
	const cached = outside.data.access[audience];
	if (cached && usable(ctx, cached)) return Ok(cached);

	return holdingGrantLock(ctx, async () => {
		// Another process may have refreshed while this one waited.
		const inside = await readGrant(ctx);
		if (inside.error !== null) return Err(inside.error);
		if (inside.data === null)
			return AuthError.NotSignedIn({ origin: ctx.deployment.origin });
		if (
			expectedGeneration !== undefined &&
			inside.data.generation !== expectedGeneration
		)
			return AuthError.GrantChanged();
		const reread = inside.data.access[audience];
		if (reread && usable(ctx, reread)) return Ok(reread);
		let refreshed = await refreshOnce(ctx, inside.data, audience);
		if (refreshed.error === 'invalid_grant') {
			// A writer outside this lock may have rotated it; try what the entry
			// holds now, once.
			const again = await readGrant(ctx);
			if (again.error !== null) return Err(again.error);
			if (again.data === null)
				return AuthError.NotSignedIn({ origin: ctx.deployment.origin });
			if (
				expectedGeneration !== undefined &&
				again.data.generation !== expectedGeneration
			)
				return AuthError.GrantChanged();
			refreshed = await refreshOnce(ctx, again.data, audience);
		}
		if (refreshed.error === 'invalid_grant')
			return AuthError.SignInEnded({ origin: ctx.deployment.origin });
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

// ---------------------------------------------------------------------------
// Signing in

/** Store a new grant, cache an API token, and learn who approved it. */
async function keepGrant(
	ctx: AuthContext,
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
		client: AUTH_CLIENT,
		generation: crypto.randomUUID(),
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
	const written = await holdingGrantLock(ctx, () => writeGrant(ctx, stored));
	if (written.error !== null) return Err(written.error);
	const api = await accessToken(
		ctx,
		ctx.deployment.audiences.api,
		stored.generation,
	);
	if (api.error !== null) return Err(api.error);
	const account = await readAccount(ctx, api.data.token);
	return holdingGrantLock(ctx, async () => {
		const current = await readGrant(ctx);
		if (current.error !== null) return Err(current.error);
		const active = current.data;
		if (!active || active.generation !== stored.generation)
			return AuthError.GrantChanged();
		const next = { ...active, account };
		const { error } = await writeGrant(ctx, next);
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
		client_id: AUTH_CLIENT,
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
			client_id: AUTH_CLIENT,
			device_code: device.device_code,
			resource: audiences.api,
		});
		if (polled.error !== null) {
			if (polled.error.name === 'Unreachable') continue;
			return Err(polled.error);
		}
		const { status, body } = polled.data;
		if (status === 200) return keepGrant(ctx, body, audiences.api);
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

// ---------------------------------------------------------------------------
// Status and signing out

/** The grant as `auth status` reports it. */
export type GrantStatus =
	| { client: string; signedIn: false }
	| {
			client: string;
			signedIn: true;
			generation: string;
			account: Account | null;
			scope: string;
			signedInAt: string;
	  };

/** The grant for this deployment, from the keychain alone. */
export async function authStatus(
	ctx: AuthContext,
): Promise<Result<GrantStatus, AuthError>> {
	const { data, error } = await readGrant(ctx);
	if (error !== null) return Err(error);
	return Ok(
		data === null
			? { client: AUTH_CLIENT, signedIn: false }
			: {
					client: data.client,
					signedIn: true,
					generation: data.generation,
					account: data.account,
					scope: data.scope,
					signedInAt: data.signedInAt,
				},
	);
}

/**
 * Sign out: revoke the grant's refresh token and every access token it has
 * cached at the server, then delete its keychain entry. Revoking the refresh
 * token ends only the access tokens of its latest rotation, and each audience's
 * token usually comes from a different one, so each is revoked by name. The
 * entry is deleted even when the server cannot be reached; `revoked` says
 * whether it heard every revocation.
 */
export async function logout(
	ctx: AuthContext,
): Promise<Result<{ signedOut: boolean; revoked: boolean }, AuthError>> {
	return holdingGrantLock(ctx, async () => {
		const { data: stored, error } = await readGrant(ctx);
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
			await ctx.secrets.delete(entryName(ctx));
		} catch (cause) {
			return AuthError.KeychainUnavailable({ reason: describe(cause) });
		}
		return Ok({ signedOut: true, revoked });
	});
}
