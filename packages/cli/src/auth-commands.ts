/**
 * `epicenter auth login | logout | status | token`
 * (ADR-0558): what `auth.ts` does, as text for a person or JSON for a
 * program, over the CLI's device grant from `epicenter auth login`.
 *
 * `auth login --json` prints NDJSON: `{"device": {...}}` with the code and
 * link, then one result line, `{"signedIn": {...}}` or `{"error"}`.
 */

import {
	type AuthContext,
	accessToken,
	authContext,
	authStatus,
	loginWithDevice,
	logout,
	type StoredGrant,
} from './auth.ts';
import { EXIT, fail, writeErr, writeJson, writeOut } from './output.ts';

type Options = Record<string, string | true>;

const who = (account: StoredGrant['account']) =>
	account === null
		? 'an Epicenter account'
		: account.name
			? `${account.name} (${account.id})`
			: account.id;

function signedInResult(ctx: AuthContext, stored: StoredGrant) {
	return {
		client: stored.client,
		origin: ctx.deployment.origin,
		account: stored.account,
		scope: stored.scope,
	};
}

/** `epicenter auth login`: the device grant. */
export async function authLogin(json: boolean): Promise<number> {
	const ctx = authContext();
	const { data, error } = await loginWithDevice(ctx, {
		onCode: (code) => {
			if (json) writeJson({ device: code });
			else
				writeErr(
					[
						`To sign in, open ${code.verificationUriComplete ?? code.verificationUri}`,
						`and confirm the code ${code.userCode}. Only approve a code you just started.`,
						'Waiting for approval...',
					].join('\n'),
				);
		},
	});
	if (error !== null) return fail(error.message, json);
	if (json) writeJson({ signedIn: signedInResult(ctx, data) });
	else {
		writeOut(
			`This computer is signed in to ${ctx.deployment.origin} as ${who(data.account)}.`,
		);
	}
	return EXIT.ok;
}

/** `epicenter auth token [--resource <url>]`. */
export async function authToken(
	options: Options,
	json: boolean,
): Promise<number> {
	const ctx = authContext();
	const resource =
		typeof options.resource === 'string'
			? options.resource
			: ctx.deployment.audiences.api;
	const { data, error } = await accessToken(ctx, resource);
	if (error !== null) return fail(error.message, json);
	if (json)
		writeJson({
			accessToken: data.token,
			expiresAt: new Date(data.expiresAt).toISOString(),
			resource,
		});
	else writeOut(data.token);
	return EXIT.ok;
}

/** `epicenter auth status`: this machine's sign-in, from the keychain alone. */
export async function authStatusCommand(json: boolean): Promise<number> {
	const ctx = authContext();
	const { data, error } = await authStatus(ctx);
	if (error !== null) return fail(error.message, json);
	if (json) writeJson({ origin: ctx.deployment.origin, ...data });
	else {
		writeOut(ctx.deployment.origin);
		writeOut(
			data.signedIn
				? `Signed in as ${who(data.account)} since ${data.signedInAt}`
				: 'Signed out: run epicenter auth login',
		);
	}
	return EXIT.ok;
}

/** `epicenter auth logout`: revoke and forget this machine's sign-in. */
export async function authLogout(json: boolean): Promise<number> {
	const ctx = authContext();
	const { data, error } = await logout(ctx);
	if (error !== null) return fail(error.message, json);
	if (json) writeJson(data);
	else if (!data.signedOut) writeOut('This computer was not signed in.');
	else {
		writeOut('Signed this computer out.');
		if (!data.revoked)
			writeErr(
				`${ctx.deployment.origin} could not be told, so its tokens stay valid until they expire. Revoke this device from your account page.`,
			);
	}
	return EXIT.ok;
}
