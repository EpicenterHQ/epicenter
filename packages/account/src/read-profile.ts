import { type } from 'arktype';
import { Ok, type Result } from 'wellcrafted/result';
import type { AuthFetch } from './auth-contract.js';
import { AuthError } from './auth-errors.js';
import { Principal } from './auth-types.js';

/** The authorization server's userinfo endpoint, below the deployment's origin. */
export const USERINFO_PATH = '/auth/oauth2/userinfo';

/**
 * What userinfo answers: `sub` for any token with `openid`, and `email` only
 * when the token also carries `email`. Better Auth reads no audience here, so
 * any of the account's tokens works.
 */
const UserInfo = type({ sub: 'string > 0', 'email?': 'string' });

/**
 * Read the account a client's `fetch` acts for from userinfo, as the
 * `AuthClient` contract's `getProfile`. `fetch` is the client's own
 * account fetch, which adds the token. Any failure, a token without
 * `openid` included, is the one `ProfileUnavailable`.
 */
export async function getProfileVia(
	fetch: AuthFetch,
	baseURL: string,
): Promise<Result<Principal, AuthError>> {
	try {
		const response = await fetch(new URL(USERINFO_PATH, baseURL), {
			credentials: 'omit',
		});
		if (!response.ok)
			return AuthError.ProfileUnavailable({
				cause: `${USERINFO_PATH} answered ${response.status}`,
			});
		const info = UserInfo(await response.json());
		if (info instanceof type.errors)
			return AuthError.ProfileUnavailable({ cause: info.summary });
		return Ok(
			Principal.assert(
				info.email === undefined
					? { id: info.sub }
					: { id: info.sub, email: info.email },
			),
		);
	} catch (cause) {
		return AuthError.ProfileUnavailable({ cause });
	}
}
