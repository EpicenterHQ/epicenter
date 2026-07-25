/**
 * The single-partition instance's bearer credential (self-host; ADR-0075).
 *
 * A self-hosted instance authenticates one operator-supplied static bearer
 * (`INSTANCE_TOKEN`). The operator generates it once (`gen-token`, backed by
 * `generateInstanceToken` in `@epicenter/auth`), supplies it through the
 * environment, and pastes it into the client's instance setting
 * (`{ baseURL, token }`, ADR-0071). Every request then carries that token (an
 * `Authorization: Bearer <token>` header, or the `bearer.<token>` WebSocket
 * subprotocol on a room upgrade), and {@link createEnvTokenResolver} is the
 * `ResolveBearerPrincipal` the deployment injects on `createServerApp` to turn
 * the extracted bearer into the instance principal.
 *
 * This is the VERIFIER side of that credential: it needs
 * `Principal`/`ResolveBearerPrincipal`, so it lives in `@epicenter/server`. The pure
 * pieces that need neither (the token generator and the boot entropy gate,
 * `generateInstanceToken` / `assertStrongToken`) live in `@epicenter/auth` so a
 * token can be minted and validated without the server graph.
 *
 * It is a credential SOURCE, not a new auth mode: it feeds the one total gate
 * exactly like `resolveRequestOAuthPrincipal`. There is no OAuth on an instance;
 * OAuth stays the hosted star's only (ADR-0071).
 *
 * The seam is {@link ResolveBearerPrincipal}, not a sub-seam beneath it. v1 is one
 * constant-time env-token compare. Future named instance tokens, if earned, must
 * still resolve to the same principal id (`INSTANCE_PRINCIPAL_ID`) because that id
 * is the partition. Per-token principals would create per-token partitions and
 * belong to a Cloud-shaped auth model, not this single-partition instance.
 *
 * Portable (ADR-0066): nothing here names `node:` or touches disk. The constant-
 * time compare and the token generator both use the Web Crypto `crypto` global,
 * which Bun and Cloudflare Workers expose identically, so the instance runs on
 * either runtime with the operator supplying the secret.
 */

import { Principal } from '@epicenter/auth';
import { INSTANCE_PRINCIPAL_ID } from '@epicenter/identity';
import { Ok } from 'wellcrafted/result';
import type { ResolveBearerPrincipal } from '../types.js';
import { OAuthError } from './oauth-errors.js';

/**
 * Constant-time equality for two strings of any length.
 *
 * Both sides are first hashed to a fixed 32-byte SHA-256 digest, so the compare
 * loop runs the same length regardless of the inputs (no early-out on the first
 * differing byte and no length tell), and an attacker observing comparison
 * timing learns nothing about the configured token: they would need a preimage
 * of its digest. `crypto.subtle` is a Web Crypto global on both Bun and Workers,
 * so this stays portable and names no `node:` built-in on the shared surface.
 */
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const [digestA, digestB] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(a)),
		crypto.subtle.digest('SHA-256', encoder.encode(b)),
	]);
	const bytesA = new Uint8Array(digestA);
	const bytesB = new Uint8Array(digestB);
	let mismatch = 0;
	for (let i = 0; i < bytesA.length; i += 1) {
		mismatch |= (bytesA[i] ?? 0) ^ (bytesB[i] ?? 0);
	}
	return mismatch === 0;
}

/**
 * The instance's `ResolveBearerPrincipal` (self-host v1): a constant-time compare
 * of the presented bearer against the operator-supplied secret, resolving an
 * exact match to `{ id: INSTANCE_PRINCIPAL_ID }` and a wrong token to
 * `InvalidToken`, the same `Result` arm the OAuth resolver returns, so the
 * surface wrappers reject it unchanged (HTTP 401 with the OAuth
 * `WWW-Authenticate` challenge, or the rooms 4401 close). The wrapper owns
 * extraction, so a missing or non-bearer credential never reaches this compare.
 * Nobody fabricates an email for the instance principal.
 */
export function createEnvTokenResolver(secret: string): ResolveBearerPrincipal {
	return async (_c, presented) =>
		(await constantTimeEqual(presented, secret))
			? Ok(Principal.assert({ id: INSTANCE_PRINCIPAL_ID }))
			: OAuthError.InvalidToken();
}
