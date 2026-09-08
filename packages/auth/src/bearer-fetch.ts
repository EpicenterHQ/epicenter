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
