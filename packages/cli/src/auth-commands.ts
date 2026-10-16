/**
 * `epicenter auth login | logout | status | token | git-credential`
 * (ADR-0558): what `auth.ts` does, as text for a person or JSON for a
 * program. Without `--desktop` every command uses the device grant from
 * `epicenter auth login`; with it, the desktop app's grant, which only Rust
 * passes.
 *
 * `auth login --json` prints NDJSON: `{"device": {...}}` with the code and
 * link, or `{"open": "<url>"}` with `--desktop`, then one result line,
 * `{"signedIn": {...}}` or `{"error"}`. `auth git-credential` speaks Git's
 * credential protocol and takes no `--json`.
 */

import {
	type AuthContext,
	type AuthError,
	accessToken,
	authContext,
	authStatus,
	configureGitHelper,
	type GrantKind,
	type GrantStatus,
	gitCredential,
	loginWithDevice,
	loginWithLoopback,
	logout,
	type StoredGrant,
} from './auth.ts';
import { gitCommand } from './install-command.ts';
import { EXIT, fail, writeErr, writeJson, writeOut } from './output.ts';

type Options = Record<string, string | true>;

const grantOf = (desktop: boolean): GrantKind =>
	desktop ? 'desktop' : 'device';

const who = (account: StoredGrant['account']) =>
	account === null
		? 'an Epicenter account'
		: account.name
			? `${account.name} (${account.id})`
			: account.id;

/** Open `url` in the person's browser with macOS's `open` (ADR-0567). */
function openInBrowser(url: string) {
	try {
		Bun.spawn(['open', url], { stdio: ['ignore', 'ignore', 'ignore'] });
	} catch {
		// The URL is printed as well; a person can open it by hand.
	}
}

function signedInResult(
	ctx: AuthContext,
	grant: GrantKind,
	stored: StoredGrant,
) {
	return {
		grant,
		client: stored.client,
		origin: ctx.deployment.origin,
		account: stored.account,
		scope: stored.scope,
	};
}

/**
 * `epicenter auth login`: the device grant. With `--desktop`, the desktop
 * app's sign-in as `so.epicenter` through a loopback redirect, which only
 * Settings runs.
 */
export async function authLogin(
	json: boolean,
	desktop: boolean,
	ctx: AuthContext = authContext(),
	helperCommand?: readonly string[],
	env: Record<string, string | undefined> = process.env,
): Promise<number> {
	if (desktop) {
		const { data, error } = await loginWithLoopback(ctx, {
			onUrl: (url) => {
				if (json) writeJson({ open: url });
				else {
					writeErr(
						`Opening your browser to sign in. If it does not open, visit:\n${url}`,
					);
					openInBrowser(url);
				}
			},
		});
		if (error !== null) return fail(error.message, json);
		if (json) writeJson({ signedIn: signedInResult(ctx, 'desktop', data) });
		else
			writeOut(
				`The Epicenter app is signed in to ${ctx.deployment.origin} as ${who(data.account)}.`,
			);
		return EXIT.ok;
	}
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
	// The link is remade only now, once the sign-in it serves exists.
	const helper = await configureGitHelper(
		ctx,
		helperCommand ?? gitCommand(),
		env,
	);
	if (json)
		writeJson({
			signedIn: {
				...signedInResult(ctx, 'device', data),
				gitHelper:
					helper.error === null
						? { configured: true, helper: helper.data }
						: { configured: false, reason: helper.error },
			},
		});
	else {
		writeOut(
			`This computer is signed in to ${ctx.deployment.origin} as ${who(data.account)}.`,
		);
		if (helper.error !== null)
			writeErr(
				`Git was not set up to use this sign-in for ${ctx.deployment.audiences.git}: ${helper.error}`,
			);
	}
	return EXIT.ok;
}

/** `epicenter auth token [--resource <url>]`. */
export async function authToken(
	options: Options,
	json: boolean,
	desktop: boolean,
	ctx: AuthContext = authContext(),
): Promise<number> {
	const resource =
		typeof options.resource === 'string'
			? options.resource
			: ctx.deployment.audiences.api;
	const { data, error } = await accessToken(ctx, grantOf(desktop), resource);
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

function statusLine(status: GrantStatus) {
	const name =
		status.grant === 'device'
			? 'This computer (epicenter auth login)'
			: 'The Epicenter app';
	return status.signedIn
		? `${name}: signed in as ${who(status.account)} since ${status.signedInAt}`
		: `${name}: signed out`;
}

/** `epicenter auth status`: each grant on this machine, from the keychain alone. */
export async function authStatusCommand(
	json: boolean,
	ctx: AuthContext = authContext(),
): Promise<number> {
	const { data, error } = await authStatus(ctx);
	if (error !== null) return fail(error.message, json);
	if (json) writeJson({ origin: ctx.deployment.origin, grants: data });
	else {
		writeOut(ctx.deployment.origin);
		for (const status of data) writeOut(statusLine(status));
	}
	return EXIT.ok;
}

/** `epicenter auth logout`: the device grant, or with `--desktop` the app's. */
export async function authLogout(
	json: boolean,
	desktop: boolean,
	ctx: AuthContext = authContext(),
): Promise<number> {
	const grant = grantOf(desktop);
	const { data, error } = await logout(ctx, grant);
	if (error !== null) return fail(error.message, json);
	if (json) writeJson({ grant, ...data });
	else if (!data.signedOut)
		writeOut(
			grant === 'desktop'
				? 'The Epicenter app was not signed in.'
				: 'This computer was not signed in.',
		);
	else {
		writeOut(
			grant === 'desktop'
				? 'Signed the Epicenter app out.'
				: 'Signed this computer out.',
		);
		if (!data.revoked)
			writeErr(
				`${ctx.deployment.origin} could not be told, so its tokens stay valid until they expire. Revoke this device from your account page.`,
			);
	}
	return EXIT.ok;
}

/**
 * `epicenter auth git-credential get | store | erase`: Git's credential
 * helper protocol on stdin and stdout. `store` and `erase` do nothing, since
 * the token is minted, not stored. A failure is told on stderr, which Git
 * shows, and Git moves on to its next helper.
 */
export async function authGitCredential(
	action: string,
	desktop: boolean,
	ctx: AuthContext = authContext(),
	stdin: () => Promise<string> = () => Bun.stdin.text(),
): Promise<number> {
	const request = await stdin();
	if (action === 'store' || action === 'erase') return EXIT.ok;
	if (action !== 'get') {
		writeErr(
			`epicenter auth git-credential takes get, store, or erase, not '${action}'`,
		);
		return EXIT.unusable;
	}
	const { data, error } = await gitCredential(ctx, grantOf(desktop), request);
	if (error !== null) {
		writeErr(`epicenter: ${(error as AuthError).message}`);
		return EXIT.unusable;
	}
	if (data !== undefined) process.stdout.write(data);
	return EXIT.ok;
}
