/**
 * Normalize any auth-fetch input to its absolute target URL. The single place
 * the four input shapes (Request, URL, relative string, absolute string) are
 * resolved: a relative `/path` resolves against `baseURL`, so it always lands
 * on the client's own origin. Returns null for an unparseable target so callers
 * fail closed.
 */
export function resolveTargetUrl(
	input: Request | string | URL,
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
