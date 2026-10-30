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
	/** The resource check for one request. */
	resource(
		token: string,
		o: { audience: string; scope: string; namespace: string; basic?: boolean },
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
		reference_id: string | null;
		session_id: string | null;
		authorization_code_id: string | null;
		expires_at: Date;
	}>(
		'select reference_id, session_id, authorization_code_id, expires_at from oauth_access_token where token = $1',
		[hash],
	);
	return rows[0];
}

async function refreshRow(h: OAuthHarness, refreshToken: string) {
	const hash = await hashPrefixedToken(refreshToken, TOKEN_PREFIX.refresh);
	const { rows } = await sql(h).query<{
		id: string;
		reference_id: string | null;
		session_id: string | null;
		authorization_code_id: string | null;
		expires_at: Date;
	}>(
		'select id, reference_id, session_id, authorization_code_id, expires_at from oauth_refresh_token where token = $1',
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

const read = (h: OAuthHarness, ns: string) => ({
	audience: h.audiences.git,
	scope: 'folders:read',
	namespace: ns,
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
			target: '*',
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
		expect((await h.resource(token, read(h, person.personal))).status).toBe(
			401,
		);
	expect(
		(await h.resource(D1.access_token, read(h, person.personal))).status,
	).toBe(200);
	expect(
		(await h.resource(O.access_token, read(h, other.personal))).status,
	).toBe(200);
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
	expect(
		(await h.resource(D2.access_token, read(h, person.personal))).status,
	).toBe(401);
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
 * audience, scope, and membership, rotation, revocation on the next request,
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
	const stranger = await client.person('stranger');
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
		expect(
			(await h.resource(first.body.access_token, read(h, person.personal)))
				.status,
		).toBe(401);
	}

	// The resource: Bearer and Basic, audience, scope, membership.
	const owner = await h.resource(issued.access_token, read(h, person.personal));
	expect(owner.status).toBe(200);
	expect(owner.body).toMatchObject({ accountId: person.id, role: 'owner' });
	expect(
		(
			await h.resource(issued.access_token, {
				...read(h, person.personal),
				scope: 'folders:write',
				basic: true,
			})
		).status,
	).toBe(200);
	const wrongAudience = await h.resource(issued.access_token, {
		...read(h, person.personal),
		audience: h.audiences.api,
	});
	expect(wrongAudience.status).toBe(401);
	expect(wrongAudience.challenge).toContain('resource_metadata=');
	expect(
		(await h.resource(issued.access_token, read(h, stranger.personal))).status,
	).toBe(403);
	const readOnly = await client.codeGrant({
		...h.desktop,
		cookie: person.cookie,
		resource,
		scope: 'folders:read',
	});
	const noWrite = await h.resource(readOnly.access_token, {
		...read(h, person.personal),
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
	expect(
		(await h.resource(rotated.body.access_token, read(h, person.personal)))
			.status,
	).toBe(200);
	expect(
		await client.revoke(
			h.desktop.clientId,
			rotated.body.access_token,
			'access_token',
		),
	).toBe(200);
	expect(
		(await h.resource(rotated.body.access_token, read(h, person.personal)))
			.status,
	).toBe(401);
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
	expect(
		(await h.resource(again.body.access_token, read(h, person.personal)))
			.status,
	).toBe(401);
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
		target: '*',
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
				...read(h, person.personal),
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
	expect(
		(await h.resource(browserGrant.access_token, read(h, person.personal)))
			.status,
	).toBe(401);
	const afterExpiry = await client.refresh(
		h.desktop.clientId,
		offline.refresh_token!,
	);
	expect(afterExpiry.status).toBe(200);
	expect(
		(await h.resource(afterExpiry.body.access_token, read(h, person.personal)))
			.status,
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
		expect(
			(await h.resource(browserToken.access_token, read(h, leaving.personal)))
				.status,
		).toBe(401);
		expect(await tokenRow(h, browserToken.access_token)).toBeUndefined();
		expect(
			(await h.resource(desktopGrant.access_token, read(h, leaving.personal)))
				.status,
		).toBe(200);
		expect(
			(await client.refresh(h.desktop.clientId, desktopGrant.refresh_token!))
				.status,
		).toBe(200);
	}

	// Removing a member stops that member's tokens at the next request.
	const group = await client.group(person, 'Studio', 'member');
	expect(
		(await h.resource(afterExpiry.body.access_token, read(h, group))).status,
	).toBe(200);
	await sql(h).query(
		'delete from namespace_member where namespace_id = $1 and account_id = $2',
		[group, person.id],
	);
	expect(
		(await h.resource(afterExpiry.body.access_token, read(h, group))).status,
	).toBe(403);
}

/**
 * Check 3: the grant target, chosen on the consent page for an app or a
 * device code, rides every token and the resource enforces it.
 */
export async function checkGrantTarget(h: OAuthHarness) {
	const { client } = h;
	const person = await client.person('target');
	const group = await client.group(person, 'Family', 'member');
	const resource = [h.audiences.git];

	const options = await client.request('/auth/grant-target/options', {
		cookie: person.cookie,
	});
	expect(await client.json<unknown>(options)).toEqual([
		{ target: '*', label: 'All folders' },
		{ target: `ns:${person.personal}`, label: 'Personal' },
		{ target: `ns:${group}`, label: 'Family' },
	]);

	// A consent page: no choice is a refusal; the choice lands on every token.
	const { verifier, challenge } = await pkce();
	const authorized = await client.authorize({
		...h.untrusted,
		cookie: person.cookie,
		challenge,
		resource,
	});
	const consentPage = new URL(authorized.location, client.origin);
	expect(consentPage.pathname).toBe('/consent');
	const oauthQuery = consentPage.search.slice(1);
	expect((await client.consent(person.cookie, oauthQuery)).status).toBe(400);
	const stranger = await client.person('outsider');
	expect(
		(
			await client.selectTarget(
				person.cookie,
				`ns:${stranger.personal}`,
				h.untrusted.clientId,
			)
		).status,
	).toBe(403);
	// A choice staged for another app does not reach this one's consent.
	expect(
		(
			await client.selectTarget(
				person.cookie,
				`ns:${group}`,
				h.desktop.clientId,
			)
		).status,
	).toBe(200);
	expect((await client.consent(person.cookie, oauthQuery)).status).toBe(400);
	expect(
		(
			await client.selectTarget(
				person.cookie,
				`ns:${group}`,
				h.untrusted.clientId,
			)
		).status,
	).toBe(200);
	const consented = await client.consent(person.cookie, oauthQuery);
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
	expect((await tokenRow(h, tokens.access_token))?.reference_id).toBe(
		`ns:${group}`,
	);
	expect((await refreshRow(h, tokens.refresh_token!))?.reference_id).toBe(
		`ns:${group}`,
	);
	expect((await h.resource(tokens.access_token, read(h, group))).status).toBe(
		200,
	);
	const outside = await h.resource(
		tokens.access_token,
		read(h, person.personal),
	);
	expect(outside.status).toBe(403);
	expect(outside.body.error).toBe('forbidden');
	const rotated = await client.refresh(
		h.untrusted.clientId,
		tokens.refresh_token!,
	);
	expect((await tokenRow(h, rotated.body.access_token))?.reference_id).toBe(
		`ns:${group}`,
	);
	// The consent consumed its choice; the one staged for another app stays
	// until it expires.
	const staged = await sql(h).query<{ identifier: string }>(
		'select identifier from verification where identifier like $1',
		[`grant-target:consent:${person.sessionId}:%`],
	);
	expect(staged.rows.map((row) => row.identifier)).toEqual([
		`grant-target:consent:${person.sessionId}:${h.desktop.clientId}`,
	]);

	// Silent re-authorization reuses the consented target.
	const silent = await pkce();
	const reauthorized = await client.authorize({
		...h.untrusted,
		cookie: person.cookie,
		challenge: silent.challenge,
		resource,
		prompt: 'none',
	});
	const silentCode = new URL(reauthorized.location).searchParams.get('code');
	expect(silentCode).toBeString();
	const silentTokens = await client.exchange({
		...h.untrusted,
		code: silentCode!,
		verifier: silent.verifier,
		resource,
	});
	expect((await tokenRow(h, silentTokens.access_token))?.reference_id).toBe(
		`ns:${group}`,
	);

	// A first-party app gets `*` without a prompt.
	const desktop = await client.codeGrant({
		...h.desktop,
		cookie: person.cookie,
		resource,
	});
	expect((await tokenRow(h, desktop.access_token))?.reference_id).toBe('*');
	expect((await h.resource(desktop.access_token, read(h, group))).status).toBe(
		200,
	);
	expect(
		(await h.resource(desktop.access_token, read(h, person.personal))).status,
	).toBe(200);

	// A device code is approved only on the consent page, and with no choice
	// the consent refuses it. The consent's target rides the device grant's
	// tokens and their refreshes, through the library's own device consent.
	const unchosen = await client.deviceGrant({
		clientId: h.cli.clientId,
		cookie: person.cookie,
		resource,
	});
	expect(unchosen.approval?.status).toBe(400);
	const device = await client.deviceGrant({
		clientId: h.cli.clientId,
		cookie: person.cookie,
		target: `ns:${person.personal}`,
		resource,
	});
	const deviceTokens = device.tokens!;
	expect((await tokenRow(h, deviceTokens.access_token))?.reference_id).toBe(
		`ns:${person.personal}`,
	);
	expect((await refreshRow(h, deviceTokens.refresh_token!))?.reference_id).toBe(
		`ns:${person.personal}`,
	);
	expect(
		(await h.resource(deviceTokens.access_token, read(h, person.personal)))
			.status,
	).toBe(200);
	expect(
		(await h.resource(deviceTokens.access_token, read(h, group))).status,
	).toBe(403);
	const deviceRotated = await client.refresh(
		h.cli.clientId,
		deviceTokens.refresh_token!,
	);
	expect(
		(await tokenRow(h, deviceRotated.body.access_token))?.reference_id,
	).toBe(`ns:${person.personal}`);
	const deviceConsent = await sql(h).query<{ reference_id: string }>(
		'select reference_id from oauth_consent where client_id = $1 and user_id = $2',
		[h.cli.clientId, person.id],
	);
	expect(deviceConsent.rows.map((row) => row.reference_id)).toEqual([
		`ns:${person.personal}`,
	]);
	// The consent consumed the device's staged choice too.
	expect(
		(
			await sql(h).query('select 1 from verification where identifier = $1', [
				`grant-target:consent:${person.sessionId}:${h.cli.clientId}`,
			])
		).rowCount,
	).toBe(0);
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
	expect(
		(await h.resource(issued.access_token, read(h, person.personal))).status,
	).toBe(200);

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
