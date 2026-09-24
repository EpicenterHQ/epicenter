/**
 * WebSocket subprotocol auth: shared client/server constants.
 *
 * Auth tokens travel inside the `Sec-WebSocket-Protocol` handshake header
 * as `bearer.<percent-encoded-token>`, not in the URL's query string. The real threat is
 * server-side access logs (Cloudflare, Hono middleware, downstream APMs
 * like Sentry/Datadog): full URLs including query strings are captured by
 * default, so a `?token=` scheme leaks long-lived session tokens into any
 * system with log access. Subprotocol headers aren't captured by default
 * on those systems. The server extracts and consumes the bearer entry on
 * upgrade; only the main protocol name (`epicenter`) is echoed back on
 * the 101 response, so the token never round-trips.
 *
 * The `.` separator is required by RFC compliance: `Sec-WebSocket-Protocol`
 * values are RFC 7230 `token` productions, where `:` is not a valid `tchar`
 * but `.` is. Prior art for `<scheme>.<token>`: Phoenix channels
 * (`phx_bearer.<token>`), Supabase Realtime, and Kubernetes
 * (`base64url.bearer.authorization.k8s.io.<token>`).
 */

/** Primary subprotocol name every Epicenter client negotiates. */
export const MAIN_SUBPROTOCOL = 'epicenter';

/** Prefix for encoded bearer credentials carried through WebSocket subprotocols. */
export const BEARER_SUBPROTOCOL_PREFIX = 'bearer.';

/**
 * Parse a `Sec-WebSocket-Protocol` header value into its list of tokens.
 *
 * RFC 6455 specifies the value as a comma-separated list of RFC 7230 tokens,
 * with optional whitespace after commas. Returns an empty list if the header
 * is absent.
 */
export function parseSubprotocols(header: string | null): string[] {
	if (!header) return [];
	return header.split(',').map((s) => s.trim());
}

/** Percent encoding keeps signed session padding and separators RFC-token safe. */
export function bearerSubprotocol(token: string): string {
	return `${BEARER_SUBPROTOCOL_PREFIX}${encodeURIComponent(token)}`;
}

/**
 * Render a subprotocol list as a `Sec-WebSocket-Protocol` header value.
 *
 * The inverse of {@link parseSubprotocols}, for the callers that write the
 * header themselves rather than hand the list to a `WebSocket` constructor.
 */
export function formatSubprotocols(protocols: readonly string[]): string {
	return protocols.join(', ');
}
