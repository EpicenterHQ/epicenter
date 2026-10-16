/**
 * The Epicenter host leaf: the account Epicenter's Settings signed in to,
 * which the `epicenter` CLI holds as its desktop grant (ADR-0556, ADR-0558).
 *
 * The page never holds a token (ADR-0549's desktop row). It learns who is
 * signed in, and on which deployment, from `auth_status`, so it names the
 * deployment the shell runs the CLI for and none of its own build. It sends its one account request,
 * `GET /api/repos`, through `account_send` with the `git` resource, where the
 * CLI adds the token, and sends the person to Settings with `open_home` to
 * sign in. The shell grants these three commands to every installed app's
 * windows (`installed-app.json`), and calls them through the bindings Rust
 * generates for them (`../tauri/bindings.gen.ts`). Git itself runs in
 * `epicenter sync`, which signs in with the same grant.
 */

import { sendThroughShell, toSendRequest } from '@epicenter/ai/send';
import type { AuthClient } from '@epicenter/auth';
import {
	createDesktopAccountAuth,
	type DesktopAccountAudience,
	type DesktopAccountStatus,
} from '@epicenter/auth/desktop';
import { Channel } from '@tauri-apps/api/core';
import { type CliError, commands } from '../tauri/bindings.gen.js';

/** What a refused shell command says, for a person. */
function describeCliError(error: CliError): string {
	return error.name === 'NotGranted'
		? `this window holds no grant: ${JSON.stringify(error.grant)}`
		: error.message;
}

/** The desktop grant, the one the app signs in with, from `auth_status`. */
async function status(): Promise<DesktopAccountStatus> {
	const { data, error } = await commands.authStatus();
	if (error !== null)
		throw Object.assign(new Error(describeCliError(error)), {
			name: error.name,
		});
	const { origin, grants } = data;
	const desktop = grants.find((grant) => grant.grant === 'desktop');
	return {
		origin,
		grant:
			desktop?.signedIn && desktop.account
				? {
						accountId: desktop.account.id,
						signedInAt: desktop.signedInAt ?? null,
					}
				: null,
	};
}

/**
 * Send `request` to the deployment's `audience` resource through
 * `account_send`, and resolve with its response as it streams in. Rejects
 * when nothing came back, named for the CLI's reason, such as
 * `NoAccountToken` when the app is not signed in.
 */
async function send(
	audience: DesktopAccountAudience,
	request: Request,
): Promise<Response> {
	const origin = new URL(request.url).origin;
	const { data: prepared, error } = await toSendRequest(origin, request);
	if (error !== null) throw new Error(error.message);
	return sendThroughShell(prepared, async (wire, onLine) => {
		const channel = new Channel<string>();
		channel.onmessage = onLine;
		const { error } = await commands.accountSend(audience, wire, channel);
		return error && { name: error.name, message: describeCliError(error) };
	});
}

export const auth: AuthClient | undefined = createDesktopAccountAuth({
	audience: 'git',
	status,
	send,
	openSignIn: async () => {
		await commands.openHome(null);
	},
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => auth?.[Symbol.dispose]());
	import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
