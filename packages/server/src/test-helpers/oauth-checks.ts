/**
 * Test-only: the authorization server checks the 2026-10-15 spike proved,
 * written once and run against every composition: the library in process,
 * the Bun entry, and the Worker entry under `wrangler dev --local`.
 *
 * Each check takes a {@link OAuthHarness}: an HTTP client for the
 * authorization server, the Postgres it writes, and the resource check run
 * against that database (ADR-0549's one query).
 */
import { expect } from 'bun:test';
import type { OAuthAudiences } from '../auth/oauth-policy.js';
import { hashPrefixedToken, TOKEN_PREFIX } from '../auth/oauth-policy.js';
import { type OAuthTestClient, type Person, pkce } from './oauth-client.js';

export type ResourceAnswer = {
	status: number;
	challenge: string | null;
	body: { error?: string; role?: string; accountId?: string };
};

export type OAuthHarness = {
	client: OAuthTestClient;
	audiences: OAuthAudiences;
	/** The resource check for one request on the person's account. */
	resource(
		token: string,
		o: { audience: string; scope: string; basic?: boolean },
	): Promise<ResourceAnswer>;
	desktop: { clientId: string; redirectUri: string };
	browser: { clientId: string; redirectUri: string };
	cli: { clientId: string };
	/** A registered client that does not skip consent. */
	untrusted: { clientId: string; redirectUri: string };
};

const sql = (h: OAuthHarness) => h.client.db;

async function tokenRow(h: OAuthHarness, accessToken: string) {
	const hash = await hashPrefixedToken(accessToken, TOKEN_PREFIX.access);
	const { rows } = await sql(h).query<{
		session_id: string | null;
		authorization_code_id: string | null;
		expires_at: Date;
	}>(
		'select session_id, authorization_code_id, expires_at from oauth_access_token where token = $1',
		[hash],
	);
	return rows[0];
}

async function refreshRow(h: OAuthHarness, refreshToken: string) {
	const hash = await hashPrefixedToken(refreshToken, TOKEN_PREFIX.refresh);
	const { rows } = await sql(h).query<{
		id: string;
		session_id: string | null;
		authorization_code_id: string | null;
		expires_at: Date;
	}>(
		'select id, session_id, authorization_code_id, expires_at from oauth_refresh_token where token = $1',
		[hash],
	);
	return rows[0];
}

/** Move a rotated refresh token past `refreshTokenReuseInterval`. */
async function closeReplayWindow(h: OAuthHarness, refreshToken: string) {
	const hash = await hashPrefixedToken(refreshToken, TOKEN_PREFIX.refresh);
	await sql(h).query(
		'update oauth_refresh_token set rotation_replay_expires_at = $2 where token = $1',
		[hash, new Date(Date.now() - 1000)],
	);
}

const read = (h: OAuthHarness) => ({
	audience: h.audiences.git,
	scope: 'folders:read',
});

/**
 * Check 1: a refresh family is every grant of one client for one person
 * (ADR-0565). A duplicate inside the reuse window gets the cached response; a
 * replay after it ends every grant of that client for that person, with the
 * access tokens they issued, and nothing of another client or person.
 */
export async function checkRefreshFamily(h: OAuthHarness) {
	const { client } = h;
	const person = await client.person('family');
	const other = await client.person('family-other');
	const resource = [h.audiences.git];
	const code = (who: Person) =>
		client.codeGrant({ ...h.desktop, cookie: who.cookie, resource });
	const device = async () => {
		const grant = await client.deviceGrant({
			clientId: h.cli.clientId,
			cookie: person.cookie,
			resource,
		});
		if (!grant.tokens) throw new Error(JSON.stringify(grant.approval));
		return grant.tokens;
	};
	// Two desktop installations and two CLI installations of one person, and
	// another person's desktop.
	const A = await code(person);
	const B = await code(person);
	const D1 = await device();
	const D2 = await device();
	const O = await code(other);

	const current: Record<
		'A' | 'B' | 'D1' | 'D2' | 'O',
		{ clientId: string; refresh: string }
	> = {
		A: { clientId: h.desktop.clientId, refresh: A.refresh_token! },
		B: { clientId: h.desktop.clientId, refresh: B.refresh_token! },
		D1: { clientId: h.cli.clientId, refresh: D1.refresh_token! },
		D2: { clientId: h.cli.clientId, refresh: D2.refresh_token! },
		O: { clientId: h.desktop.clientId, refresh: O.refresh_token! },
	};
	async function alive() {
		const state: Record<string, boolean> = {};
		for (const key of Object.keys(current) as (keyof typeof current)[]) {
			const rotated = await client.refresh(
				current[key].clientId,
				current[key].refresh,
			);
			state[key] = rotated.status === 200;
			if (rotated.status === 200)
				current[key].refresh = rotated.body.refresh_token!;
		}
		return state;
	}

	// A duplicate inside the window receives the same response, revoking nothing.
	const rotatedA = await client.refresh(h.desktop.clientId, A.refresh_token!);
	expect(rotatedA.status).toBe(200);
	const duplicate = await client.refresh(h.desktop.clientId, A.refresh_token!);
	expect(duplicate.status).toBe(200);
	expect(duplicate.body.refresh_token).toBe(rotatedA.body.refresh_token);
	expect(duplicate.body.access_token).toBe(rotatedA.body.access_token);
	current.A.refresh = rotatedA.body.refresh_token!;
	expect(await alive()).toEqual({
		A: true,
		B: true,
		D1: true,
		D2: true,
		O: true,
	});

	// After the window, A's replay ends both desktop grants of this person,
	// with their access tokens; the CLI and the other person keep theirs.
	await closeReplayWindow(h, A.refresh_token!);
	const replayA = await client.refresh(h.desktop.clientId, A.refresh_token!);
	expect(replayA.status).toBe(400);
	expect(replayA.body.error).toBe('invalid_grant');
	for (const token of [rotatedA.body.access_token, B.access_token])
		expect((await h.resource(token, read(h))).status).toBe(401);
	expect((await h.resource(D1.access_token, read(h))).status).toBe(200);
	expect((await h.resource(O.access_token, read(h))).status).toBe(200);
	expect(await alive()).toEqual({
		A: false,
		B: false,
		D1: true,
		D2: true,
		O: true,
	});

	// The CLI is its own family: one device grant's replay ends both.
	const oldD1 = current.D1.refresh;
	const rotatedD1 = await client.refresh(h.cli.clientId, oldD1);
	expect(rotatedD1.status).toBe(200);
	current.D1.refresh = rotatedD1.body.refresh_token!;
	await closeReplayWindow(h, oldD1);
	expect((await client.refresh(h.cli.clientId, oldD1)).status).toBe(400);
	expect((await h.resource(D2.access_token, read(h))).status).toBe(401);
	expect(await alive()).toEqual({
		A: false,
		B: false,
		D1: false,
		D2: false,
		O: true,
	});
}

/**
 * The end-to-end flows of checks 2 and 4: discovery, opaque prefixed tokens
 * with the ADR's lifetimes, code replay, Bearer and Basic at the resource,
 * audience and scope, rotation, revocation on the next request,
 * the device grant, client grant ceilings, offline grants outliving their
 * browser session, and browser grants dying with it.
 */
export async function checkFlows(h: OAuthHarness) {
	const { client } = h;
	const metadataResponse = await client.request(
		'/.well-known/oauth-authorization-server/auth',
	);
	expect(metadataResponse.status).toBe(200);
	const metadata = await client.json<Record<string, unknown>>(metadataResponse);
	expect(metadata.issuer).toBe(`${client.origin}/auth`);
	expect(metadata.device_authorization_endpoint).toBeString();
	expect(metadata.jwks_uri).toBeUndefined();
	expect(metadata.registration_endpoint).toBeUndefined();
	expect(metadata.grant_types_supported).not.toContain('client_credentials');

	const person = await client.person('flows');
	const resource = [h.audiences.git];
	const issued = await client.codeGrant({
		...h.desktop,
		cookie: person.cookie,
		resource,
	});
	expect(issued.access_token.startsWith(TOKEN_PREFIX.access)).toBe(true);
	expect(issued.refresh_token?.startsWith(TOKEN_PREFIX.refresh)).toBe(true);
	expect(issued.expires_in).toBe(8 * 60 * 60);
	const refreshExpiry = (await refreshRow(h, issued.refresh_token!))!
		.expires_at;
	expect(Math.round((refreshExpiry.getTime() - Date.now()) / 86_400_000)).toBe(
		30,
	);

	// An authorization code is single use; a replay revokes what it issued.
	{
		const { verifier, challenge } = await pkce();
		const authorized = await client.authorize({
			...h.desktop,
			cookie: person.cookie,
			challenge,
			resource,
		});
		const code = new URL(authorized.location).searchParams.get('code')!;
		const form = {
			grant_type: 'authorization_code',
			client_id: h.desktop.clientId,
			code,
			code_verifier: verifier,
			redirect_uri: h.desktop.redirectUri,
			resource,
		};
		const first = await client.token(form);
		expect(first.status).toBe(200);
		expect((await client.token(form)).status).toBe(400);
		expect((await h.resource(first.body.access_token, read(h))).status).toBe(
			401,
		);
	}

	// The resource: Bearer and Basic, audience, scope.
	const owner = await h.resource(issued.access_token, read(h));
	expect(owner.status).toBe(200);
	expect(owner.body).toMatchObject({ accountId: person.id });
	expect(
		(
			await h.resource(issued.access_token, {
				...read(h),
				scope: 'folders:write',
				basic: true,
			})
		).status,
	).toBe(200);
	const wrongAudience = await h.resource(issued.access_token, {
		...read(h),
		audience: h.audiences.api,
	});
	expect(wrongAudience.status).toBe(401);
	expect(wrongAudience.challenge).toContain('resource_metadata=');
	const readOnly = await client.codeGrant({
		...h.desktop,
		cookie: person.cookie,
		resource,
		scope: 'folders:read',
	});
	const noWrite = await h.resource(readOnly.access_token, {
		...read(h),
		scope: 'folders:write',
	});
	expect(noWrite.status).toBe(403);
	expect(noWrite.body.error).toBe('insufficient_scope');

	// Rotation, and revocation that the very next request sees.
	const rotated = await client.refresh(
		h.desktop.clientId,
		issued.refresh_token!,
	);
	expect(rotated.status).toBe(200);
	expect((await h.resource(rotated.body.access_token, read(h))).status).toBe(
		200,
	);
	expect(
		await client.revoke(
			h.desktop.clientId,
			rotated.body.access_token,
			'access_token',
		),
	).toBe(200);
	expect((await h.resource(rotated.body.access_token, read(h))).status).toBe(
		401,
	);
	const again = await client.refresh(
		h.desktop.clientId,
		rotated.body.refresh_token!,
	);
	expect(
		await client.revoke(
			h.desktop.clientId,
			again.body.refresh_token!,
			'refresh_token',
		),
	).toBe(200);
	expect((await h.resource(again.body.access_token, read(h))).status).toBe(401);
	expect(
		(await client.refresh(h.desktop.clientId, again.body.refresh_token!))
			.status,
	).toBe(400);

	// The device grant issues OAuth tokens and no browser session.
	const sessionsBefore = await sql(h).query(
		'select id from session where user_id = $1',
		[person.id],
	);
	const device = await client.deviceGrant({
		clientId: h.cli.clientId,
		cookie: person.cookie,
		resource,
	});
	expect(device.tokens?.access_token.startsWith(TOKEN_PREFIX.access)).toBe(
		true,
	);
	expect(
		(await tokenRow(h, device.tokens!.access_token))?.session_id,
	).toBeNull();
	expect(
		(
			await sql(h).query('select id from session where user_id = $1', [
				person.id,
			])
		).rowCount,
	).toBe(sessionsBefore.rowCount);
	expect(
		(
			await h.resource(device.tokens!.access_token, {
				...read(h),
				scope: 'folders:write',
			})
		).status,
	).toBe(200);

	// Each client's registration is its ceiling.
	const browserDevice = await client.request('/auth/device/code', {
		form: { client_id: h.browser.clientId, scope: 'folders:read', resource },
	});
	expect(browserDevice.status).toBe(400);
	expect((await client.json(browserDevice)).error).toBe('unauthorized_client');
	const { challenge } = await pkce();
	const cliCode = await client.authorize({
		clientId: h.cli.clientId,
		redirectUri: h.desktop.redirectUri,
		cookie: person.cookie,
		challenge,
		resource,
	});
	expect(cliCode.status).toBe(302);
	const cliRefusal = new URL(cliCode.location);
	expect(cliRefusal.pathname).toBe('/auth/error');
	expect(cliRefusal.searchParams.get('error')).toBe('unauthorized_client');
	expect(cliRefusal.searchParams.has('code')).toBe(false);

	// An offline grant outlives the browser session that approved it; a
	// browser grant without offline_access dies with it.
	const browserGrant = await client.codeGrant({
		...h.browser,
		cookie: person.cookie,
		resource,
		scope: 'folders:read',
	});
	expect(browserGrant.refresh_token).toBeUndefined();
	const offline = await client.codeGrant({
		...h.desktop,
		cookie: person.cookie,
		resource,
	});
	expect((await refreshRow(h, offline.refresh_token!))?.session_id).toBeNull();
	await sql(h).query('update session set expires_at = $2 where id = $1', [
		person.sessionId,
		new Date(Date.now() - 60_000),
	]);
	expect((await h.resource(browserGrant.access_token, read(h))).status).toBe(
		401,
	);
	const afterExpiry = await client.refresh(
		h.desktop.clientId,
		offline.refresh_token!,
	);
	expect(afterExpiry.status).toBe(200);
	expect(
		(await h.resource(afterExpiry.body.access_token, read(h))).status,
	).toBe(200);

	// Signing out deletes the access tokens issued under that session; an
	// offline grant it approved keeps working.
	{
		const leaving = await client.person('sign-out');
		const browserToken = await client.codeGrant({
			...h.browser,
			cookie: leaving.cookie,
			resource,
			scope: 'folders:read',
		});
		const desktopGrant = await client.codeGrant({
			...h.desktop,
			cookie: leaving.cookie,
			resource,
		});
		const signedOut = await client.request('/auth/sign-out', {
			cookie: leaving.cookie,
			json: {},
		});
		expect(signedOut.status).toBe(200);
		expect((await h.resource(browserToken.access_token, read(h))).status).toBe(
			401,
		);
		expect(await tokenRow(h, browserToken.access_token)).toBeUndefined();
		expect((await h.resource(desktopGrant.access_token, read(h))).status).toBe(
			200,
		);
		expect(
			(await client.refresh(h.desktop.clientId, desktopGrant.refresh_token!))
				.status,
		).toBe(200);
	}
}

/**
 * Check 3: the consent page. An app that does not skip consent lands there,
 * and the person's answer is the grant, with no choice of folders: which
 * folders a token reaches is its scopes and the apps folders are attached
 * to (ADR-0811). The same page approves a device code, and silent
 * re-authorization then needs no page.
 */
export async function checkConsent(h: OAuthHarness) {
	const { client } = h;
	const person = await client.person('consent');
	const resource = [h.audiences.git];

	const { verifier, challenge } = await pkce();
	const authorized = await client.authorize({
		...h.untrusted,
		cookie: person.cookie,
		challenge,
		resource,
	});
	const consentPage = new URL(authorized.location, client.origin);
	expect(consentPage.pathname).toBe('/consent');
	const consented = await client.consent(
		person.cookie,
		consentPage.search.slice(1),
	);
	expect(consented.status).toBe(200);
	const code = new URL(
		consented.body.url ?? consented.body.redirect_uri ?? '',
	).searchParams.get('code')!;
	const tokens = await client.exchange({
		...h.untrusted,
		code,
		verifier,
		resource,
	});
	expect((await h.resource(tokens.access_token, read(h))).status).toBe(200);

	// Silent re-authorization after the consent needs no page.
	const silent = await pkce();
	const reauthorized = await client.authorize({
		...h.untrusted,
		cookie: person.cookie,
		challenge: silent.challenge,
		resource,
		prompt: 'none',
	});
	expect(new URL(reauthorized.location).searchParams.get('code')).toBeString();

	// A device code is approved on the consent page.
	const device = await client.deviceGrant({
		clientId: h.cli.clientId,
		cookie: person.cookie,
		resource,
	});
	expect((await h.resource(device.tokens!.access_token, read(h))).status).toBe(
		200,
	);
}

/**
 * Check 5: silent re-authorization. With the authorization server's cookie, a
 * top-level `prompt=none` returns a code without a page; without it, the app
 * hears `login_required`; consent is skipped only for first-party clients;
 * a silent flow cannot widen the client's ceiling.
 */
export async function checkSilentReauthorization(h: OAuthHarness) {
	const { client } = h;
	const person = await client.person('silent');
	const resource = [h.audiences.api, h.audiences.git];
	const { verifier, challenge } = await pkce();
	const silent = await client.authorize({
		...h.browser,
		cookie: person.cookie,
		challenge,
		resource,
		scope: 'folders:read',
		prompt: 'none',
	});
	expect(silent.status).toBe(302);
	expect(silent.location.startsWith(h.browser.redirectUri)).toBe(true);
	const code = new URL(silent.location).searchParams.get('code')!;
	// One audience per token request: a token naming both is refused at each.
	const issued = await client.exchange({
		...h.browser,
		code,
		verifier,
		resource: [h.audiences.git],
	});
	expect(issued.refresh_token).toBeUndefined();
	expect((await h.resource(issued.access_token, read(h))).status).toBe(200);

	const anonymous = await client.authorize({
		...h.browser,
		challenge,
		scope: 'folders:read',
		prompt: 'none',
	});
	expect(anonymous.status).toBe(302);
	expect(anonymous.location.startsWith(h.browser.redirectUri)).toBe(true);
	expect(new URL(anonymous.location).searchParams.get('error')).toBe(
		'login_required',
	);

	const interactive = await client.authorize({
		...h.browser,
		challenge,
		scope: 'folders:read',
	});
	expect(new URL(interactive.location, client.origin).pathname).toBe(
		'/sign-in',
	);

	const untrusted = await client.authorize({
		...h.untrusted,
		cookie: person.cookie,
		challenge,
		scope: 'folders:read',
		prompt: 'none',
	});
	expect(new URL(untrusted.location).searchParams.get('error')).toBe(
		'consent_required',
	);

	// The untrusted client's ceiling holds no `ai`.
	const wider = await client.authorize({
		...h.untrusted,
		cookie: person.cookie,
		challenge,
		scope: 'folders:read ai',
		prompt: 'none',
	});
	expect(new URL(wider.location).searchParams.get('error')).toBe(
		'invalid_scope',
	);
}

export type { Person };
