/**
 * The Epicenter host leaf: the account Epicenter's Settings signed in to,
 * which the `epicenter` CLI holds as its desktop grant (ADR-0556, ADR-0558).
 *
 * The page never holds a token (ADR-0549's desktop row). It learns who is
 * signed in, and on which deployment, from `auth_status`, so it names the
 * deployment the shell runs the CLI for and none of its own build. It sends its one account request,
 * `GET /api/repos`, through `account_send` with the `git` resource, where the
 * CLI adds the token, and sends the person to Settings with `open_home` to
 * sign in. The shell grants these three commands to Todos' windows by app id
 * (`installed-todos-*`). Git itself runs in `epicenter sync`, which signs in
 * with the same grant.
 */

import {
	bytesToBase64,
	createResponseReader,
	type SendEvent,
	toSendRequest,
} from '@epicenter/ai/send';
import type { AuthClient } from '@epicenter/auth';
import {
	createDesktopAccountAuth,
	type DesktopAccountAudience,
	type DesktopAccountStatus,
} from '@epicenter/auth/desktop';
import { Channel, invoke } from '@tauri-apps/api/core';

/** What `auth_status` answers (`AuthStatus` in `src-tauri/src/cli.rs`). */
type AuthStatus = {
	origin: string;
	grants: {
		grant: string;
		signedIn: boolean;
		account: { id: string } | null;
		signedInAt: string | null;
	}[];
};

/** The shell's own last line of a send: the run ended. */
type ExitLine = { type: 'exit'; code: number; stderr: string };

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

/** The desktop grant, the one the app signs in with, from `auth_status`. */
async function status(): Promise<DesktopAccountStatus> {
	const { origin, grants } = await invoke<AuthStatus>('auth_status');
	const desktop = grants.find((grant) => grant.grant === 'desktop');
	return {
		origin,
		grant:
			desktop?.signedIn && desktop.account
				? { accountId: desktop.account.id, signedInAt: desktop.signedInAt }
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
	const reader = createResponseReader();
	const channel = new Channel<string>();
	channel.onmessage = (line) => {
		let event: SendEvent | ExitLine;
		try {
			event = JSON.parse(line);
		} catch {
			reader.fail({
				name: 'InvalidResponse',
				message: 'Epicenter answered with a line that does not read',
			});
			return;
		}
		// The run ended, so a response not ended by now never will be.
		if (event.type === 'exit')
			reader.fail({
				name: 'Incomplete',
				message: `the epicenter command exited ${event.code}${event.stderr.trim() ? `: ${event.stderr.trim()}` : ''}`,
			});
		else reader.push(event);
	};
	invoke('account_send', {
		audience,
		request: {
			method: prepared.method,
			path: prepared.path,
			headers: prepared.headers,
			body: prepared.body ? bytesToBase64(prepared.body) : null,
		},
		onEvent: channel,
	}).catch((cause: unknown) => {
		const refusal = cause as { name?: string; message?: string } | undefined;
		reader.fail({
			name: refusal?.name ?? 'Failed',
			message: refusal?.message ?? describe(cause),
		});
	});
	const { data: response, error: failure } = await reader.response;
	if (failure !== null)
		throw Object.assign(new Error(failure.message), { name: failure.name });
	return response;
}

export const auth: AuthClient | undefined = createDesktopAccountAuth({
	audience: 'git',
	status,
	send,
	openSignIn: async () => {
		await invoke('open_home', { section: null });
	},
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => auth?.[Symbol.dispose]());
	import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
