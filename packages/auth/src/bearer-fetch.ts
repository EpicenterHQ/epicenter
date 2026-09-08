import type { AuthFetch } from './auth-contract.js';

/**
 * The four input shapes an auth client's `fetch` accepts: a full `Request`, a
 * `URL`, an absolute string, or a relative-path string.
 */
export type AuthFetchInput = Request | string | URL;

/**
 * Normalize any auth-fetch input to its absolute target URL. The single place
 * the four input shapes (Request, URL, relative string, absolute string) are
 * resolved: a relative `/path` resolves against `baseURL`, so it always lands
 * on the client's own origin. Returns null for an unparseable target so callers
 * fail closed.
 */
export function resolveTargetUrl(
	input: AuthFetchInput,
	baseURL: string,
): URL | null {
	try {
		if (input instanceof Request) return new URL(input.url);
		if (input instanceof URL) return input;
		return new URL(input, baseURL);
	} catch {
		return null;
	}
}

/**
 * Merge Request headers with RequestInit headers using Fetch's own normalization.
 *
 * This stays a helper because `HeadersInit` accepts several runtime shapes,
 * including iterable entries that TypeScript does not always model directly.
 */
export function mergeRequestHeaders(
	input: AuthFetchInput,
	init?: RequestInit,
): Headers {
	const headers = new Headers(
		input instanceof Request ? input.headers : undefined,
	);
	const source = init?.headers;
	if (!source) return headers;

	new Headers(source).forEach((value, key) => {
		headers.set(key, value);
	});
	return headers;
}

/**
 * Attach an Epicenter bearer and dispatch a request. The single implementation
 * of the credential-attach rules shared by the OAuth ({@link createOAuthAppAuth})
 * and host transports, which differ only
 * in how they resolve the token:
 *
 *   - The bearer is attached only to `epicenterOrigin` (ADR-0053 audience
 *     scoping), so handing this `fetch` to a custom inference backend or any
 *     third party can never leak the token. `resolveToken` is called only for an
 *     Epicenter-origin target, and may return null to fail closed.
 *   - `credentials: 'omit'` keeps OAuth tokens the sole resource credential.
 *   - `redirect: 'manual'` when (and only when) a bearer is attached: some
 *     runtimes (reqwest in Tauri, older Chromium) re-send the header to the new
 *     origin on a cross-origin 3xx, so the redirect is returned to the caller.
 *   - A `Request` is passed through cloned (it carries its own method and body);
 *     anything else goes as its resolved absolute URL so a relative `/path`
 *     lands on `baseURL`.
 */
export async function fetchWithBearer({
	input,
	init,
	fetch: fetchImpl,
	baseURL,
	epicenterOrigin,
	resolveToken,
}: {
	input: AuthFetchInput;
	init: RequestInit | undefined;
	fetch: AuthFetch;
	baseURL: string;
	epicenterOrigin: string;
	resolveToken: () => Promise<string | null>;
}): Promise<Response> {
	const target = resolveTargetUrl(input, baseURL);
	const headers = mergeRequestHeaders(input, init);
	const accessToken =
		target?.origin === epicenterOrigin ? await resolveToken() : null;
	if (accessToken) {
		headers.set('Authorization', `Bearer ${accessToken}`);
	} else {
		headers.delete('Authorization');
	}
	// The clone is cast to `Request` because a Cloudflare Workers consumer types
	// `Request.clone()` as its CF-flavored Request, which is not `AuthFetchInput`.
	const normalizedInput: AuthFetchInput =
		input instanceof Request
			? (input.clone() as Request)
			: (target?.href ?? input);
	return fetchImpl(normalizedInput, {
		...init,
		headers,
		credentials: 'omit',
		...(accessToken ? { redirect: 'manual' as const } : {}),
	});
}
