/** Whispering's API-bound Account over the host's account request commands. */

import { sendThroughShell, toSendRequest } from '@epicenter/ai/send';
import { createDesktopAccountAuth } from '@epicenter/auth/desktop';
import { Channel } from '@tauri-apps/api/core';
import { commands } from '../../tauri/bindings.gen.js';

const failureOf = (error: { name: string; message?: string }) =>
	error.message ?? `the shell refused the request (${error.name})`;

type AccountCommands = Pick<
	typeof commands,
	'authStatus' | 'accountSend' | 'sendCancel' | 'openHome'
>;

export function createDesktopAccount(native: AccountCommands = commands) {
	return createDesktopAccountAuth({
		audience: 'api',
		async status() {
			const { data, error } = await native.authStatus();
			if (error !== null) throw new Error(failureOf(error));
			const origin = new URL(data.origin).origin;
			const grant = data.grants.find((item) => item.grant === 'desktop');
			const problem =
				grant?.signedIn && !grant.account
					? 'Epicenter is signed in, but could not identify the account. Sign in again from Settings.'
					: grant?.signedIn && !grant.generation
						? 'Epicenter could not identify this sign-in. Open Settings and try again.'
						: undefined;
			return {
				origin,
				problem,
				grant:
					grant?.signedIn && grant.account && grant.generation
						? { accountId: grant.account.id, generation: grant.generation }
						: null,
			};
		},
		async send(audience, generation, request) {
			const { data: wire, error } = await toSendRequest(
				new URL(request.url).origin,
				request,
			);
			if (error !== null) throw new Error(error.message);
			const id = crypto.randomUUID();
			return sendThroughShell(
				wire,
				async (input, onLine) => {
					const channel = new Channel<string>();
					channel.onmessage = onLine;
					const { error: refusal } = await native.accountSend(
						audience,
						generation,
						input,
						id,
						channel,
					);
					return refusal && { name: refusal.name, message: failureOf(refusal) };
				},
				{
					signal: request.signal,
					cancel: () => {
						void native.sendCancel(id);
					},
				},
			);
		},
		openSignIn: () => native.openHome('account'),
		// Connections refresh before each read or send. This service has no
		// window-lifetime owner for a focus listener.
		watch: () => () => {},
	});
}
