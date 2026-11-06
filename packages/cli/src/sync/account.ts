/**
 * The CLI's own sign-in as the account a folder's repository is reached
 * through (`@epicenter/folder/sync`'s `RemoteAccount`): every request to the
 * deployment carries the grant's access token for the Git audience, fetched
 * (and refreshed, under its lock) as each request starts, so a long sync
 * never sends a stale one. A token travels over `https`, or over `http` only
 * to this computer (a development API).
 */
import type { RemoteAccount } from '@epicenter/folder/sync';
import { type AuthContext, accessToken, type GrantKind } from '../auth.ts';

/** Whether a token may travel to `url`: `https`, or `http` that never leaves this computer. */
export function carriesTokens(url: string): boolean {
	if (url.startsWith('https://')) return true;
	if (!URL.canParse(url)) return false;
	const { protocol, hostname } = new URL(url);
	return (
		protocol === 'http:' &&
		['localhost', '127.0.0.1', '[::1]'].includes(hostname)
	);
}

/** `ctx`'s sign-in under `grant`, as a repository takes an account. */
export function signedInAccount(
	ctx: AuthContext,
	grant: GrantKind,
): RemoteAccount {
	const lifetime = new AbortController();
	return {
		baseURL: ctx.deployment.origin,
		signal: lifetime.signal,
		async fetch(input, init) {
			const url = String(input instanceof Request ? input.url : input);
			if (!carriesTokens(url))
				throw new Error(`${url} is neither https nor this computer`);
			const { data, error } = await accessToken(
				ctx,
				grant,
				ctx.deployment.audiences.git,
			);
			if (error !== null) throw new Error(error.message);
			const headers = new Headers(init?.headers);
			headers.set('authorization', `Bearer ${data.token}`);
			return ctx.fetch(url, { ...init, headers });
		},
	};
}
