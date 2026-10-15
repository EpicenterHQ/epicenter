/**
 * Transports for client ID metadata documents (CIMD). A transport must refuse
 * redirects and never reach a non-public address. Each is a module-level
 * function so the CIMD cache, keyed by transport, outlives a Worker request.
 */
import type { ClientMetadataResourceFetch } from '@better-auth/oauth-provider';

/**
 * The Worker transport. Redirects come back to the caller unfollowed; the
 * Worker's `global_fetch_strictly_public` compatibility flag keeps `fetch` on
 * the public internet. Unverified in production (ADR-0549).
 */
export const workerClientMetadataFetch: ClientMetadataResourceFetch = (
	input,
	init,
) => fetch(input, { ...init, redirect: 'manual' });
