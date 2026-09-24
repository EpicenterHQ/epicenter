/**
 * Extract the bearer credential from a WebSocket upgrade's headers.
 *
 * A browser `new WebSocket(url, protocols)` upgrade cannot set `Authorization`;
 * the only channel for a bearer is the `Sec-WebSocket-Protocol` list, as
 * `bearer.<token>` (see `@epicenter/sync` `auth-subprotocol.ts`). The attach
 * relay mount, the one surface that authenticates a browser WebSocket client,
 * reads the credential here: an explicit `Authorization` header first (a
 * non-browser client can set one), else a single `bearer.<token>` subprotocol
 * entry.
 *
 * The extracted token feeds the deployment's `ResolveBearerPrincipal` (the
 * cloud's session resolver, an instance's env-token resolver). The ambient
 * browser cookie is never consulted here, so it can never authenticate a
 * WebSocket surface.
 */

import { BEARER_SUBPROTOCOL_PREFIX, parseSubprotocols } from '@epicenter/sync';
import { parseBearer } from './parse-bearer.js';

/**
 * `Authorization: Bearer <token>` wins when present (a non-browser client can
 * set it directly); otherwise a single `bearer.<token>` subprotocol entry is
 * the credential. Returns null when there is no usable bearer: none present, an
 * empty `bearer.` token, or more than one bearer entry (a malformed client).
 * The caller answers 401 in that case.
 */
export function extractUpgradeBearer(headers: Headers): string | null {
	const fromHeader = parseBearer(headers.get('authorization'));
	if (fromHeader) return fromHeader;

	const bearers = parseSubprotocols(headers.get('sec-websocket-protocol'))
		.filter((protocol) => protocol.startsWith(BEARER_SUBPROTOCOL_PREFIX))
		.map((protocol) => protocol.slice(BEARER_SUBPROTOCOL_PREFIX.length));
	if (bearers.length !== 1) return null;
	try {
		return decodeURIComponent(bearers[0]!) || null;
	} catch {
		return null;
	}
}
