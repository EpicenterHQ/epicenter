/**
 * Force a Bun `server.upgrade` to echo only the main subprotocol, by rewriting
 * the inbound request's `Sec-WebSocket-Protocol` header in place before the
 * upgrade.
 *
 * Bun's uWS layer negotiates by auto-echoing the client's FIRST offered
 * subprotocol, so without this a client that ordered `bearer.<token>` first
 * would get its credential echoed on the 101. The two other channels do not
 * work here: passing `Sec-WebSocket-Protocol` via `options.headers` writes a
 * SECOND copy of the header beside uWS's negotiated one (clients then fail the
 * handshake with 1002; verified on Bun 1.3.3), and reconstructing the request
 * severs the internal upgrade context (`server.upgrade` returns false on
 * anything but the exact object `fetch` received). Mutating the live header on
 * the original object threads that needle: identity is preserved and uWS reads
 * the rewritten value at upgrade time (also verified).
 *
 * Shared by every Bun WebSocket surface that carries a `bearer.<token>`
 * subprotocol a browser upgrade cannot otherwise send safely: Document V3 and
 * the AttachRelay transport. Each surface guarantees its selected application
 * subprotocol on every path that upgrades, so the sanitized header contains
 * exactly that value. The delete branch is defense in depth for a client that
 * offered only non-selected protocols: no header, nothing to auto-echo.
 */

import {
	MAIN_SUBPROTOCOL,
	parseSubprotocols,
} from '@epicenter/sync/auth-subprotocol';

/** Rewrite `request`'s subprotocol header to the main one only (or none). */
export function sanitizeUpgradeSubprotocols(
	request: Request,
	selected = MAIN_SUBPROTOCOL,
): void {
	const offered = parseSubprotocols(
		request.headers.get('sec-websocket-protocol'),
	);
	if (offered.length === 0) return;
	if (offered.includes(selected)) {
		request.headers.set('sec-websocket-protocol', selected);
	} else {
		request.headers.delete('sec-websocket-protocol');
	}
}
