/**
 * Dev-only credential bypass for the runtime-parity smoke.
 *
 * `Authorization: Bearer dev:<principalId>` resolves to the principal
 * `{ id: <principalId>, email: <principalId>@dev.invalid }` with no interactive
 * login.
 * The fabricated email is allowed here because dev auth simulates Cloud, where
 * Better Auth always supplies an email; instance principals have none.
 * It exists so `apps/api/scripts/smoke.ts` (and CI) can drive the authed
 * surfaces without Google OAuth or a forged Better Auth session, which is the
 * only thing that scenario cannot obtain over plain HTTP.
 *
 * This IS a bypass, so it is quarantined: it is wired ONLY by `server.dev.ts`,
 * which the production entrypoints (`worker/index.ts`, `server.ts`) never
 * import, so it cannot ship. It is a `ResolveBearerPrincipal` injected on
 * `createServerApp`, never an env-gated branch inside `@epicenter/server` (that
 * would compile the bypass into production). Belt-and-suspenders: it refuses
 * unless the request landed on localhost, so even a misconfigured deploy that
 * somehow wired it would admit nobody off-box.
 *
 * The resolved `id` is the partition directly, so the smoke needs no seeded user
 * and no database access of its own.
 */

import { Principal } from '@epicenter/auth';
import { asPrincipalId } from '@epicenter/identity';
import {
	type CloudEnv,
	OAuthError,
	type ResolveBearerPrincipal,
} from '@epicenter/server/bun';
import { Ok } from 'wellcrafted/result';

const DEV_TOKEN_PREFIX = 'dev:';
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Resolve a `dev:<principalId>` bearer to a synthetic principal, on localhost
 * only. The surface wrapper owns extraction (the `Authorization` header, or the
 * `bearer.<token>` subprotocol on a WebSocket upgrade), so this only sees the bare
 * token. Any other input (off-box, non-`dev:` token, empty id) is an
 * `InvalidToken`, the same `Result` arm the real resolver returns, so the
 * surface wrappers reject it unchanged.
 */
export const resolveDevPrincipal: ResolveBearerPrincipal<CloudEnv> = async (
	c,
	bearer,
) => {
	const hostname = new URL(c.req.url).hostname;
	if (!LOCAL_HOSTNAMES.has(hostname)) return OAuthError.InvalidToken();

	if (!bearer.startsWith(DEV_TOKEN_PREFIX)) return OAuthError.InvalidToken();

	const principalId = bearer.slice(DEV_TOKEN_PREFIX.length);
	if (!principalId) return OAuthError.InvalidToken();

	return Ok(
		Principal.assert({
			id: asPrincipalId(principalId),
			email: `${principalId}@dev.invalid`,
		}),
	);
};
