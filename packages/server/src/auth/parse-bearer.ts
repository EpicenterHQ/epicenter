/**
 * Extract the token from an HTTP `Authorization: Bearer <token>` header value.
 * Case-insensitive on the scheme; trims surrounding whitespace; returns null
 * for missing, empty, or non-bearer inputs.
 *
 * Shared between WebSocket upgrade extraction and `require-auth` (HTTP
 * wrappers) so both surfaces agree on what counts as a bearer.
 */
export function parseBearer(value: string | null): string | null {
	if (!value) return null;
	const match = value.match(/^Bearer\s+(.+)$/i);
	return match?.[1]?.trim() || null;
}
