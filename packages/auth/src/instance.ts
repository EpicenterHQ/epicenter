import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

/**
 * A client's choice of which Epicenter star to talk to (ADR-0069: privacy is
 * which deployment runs the program). The default is the hosted cloud with no
 * token (normal OAuth); a self-hoster sets `baseURL` to their origin and a
 * `token` minted by their box.
 *
 * This is the persisted, per-client setting. How it is stored (localStorage,
 * chrome.storage) is the app's concern, behind the shared {@link InstanceSetting}
 * handle; the shape, its normalization ({@link normalizeInstanceUrl}), and its
 * one credential branch ({@link createAppAuthClient}) live here so every client
 * agrees on them.
 */
export type Instance = {
	/**
	 * Base URL of the Epicenter server: an origin, optionally with a path prefix,
	 * never a trailing slash. Run it through {@link normalizeInstanceUrl} before
	 * persisting.
	 */
	baseURL: string;
	/**
	 * Instance bearer token. When present, the client authenticates with it
	 * (self-host, via {@link createInstanceTokenAuth}); when absent, it uses the
	 * hosted OAuth flow. OAuth is hosted-only, so a non-hosted `baseURL` requires
	 * a token (ADR-0070/0071): the hosted default carries no token.
	 */
	token?: string;
};

/**
 * Failures of {@link normalizeInstanceUrl}. Callers branch on `name` to show an
 * actionable message that names what to fix, not just that the input is bad.
 */
export const InstanceUrlError = defineErrors({
	/** The field is blank. */
	Empty: () => ({ message: 'Enter your instance URL.' }),
	/** A scheme was written out, but it is not http(s). */
	UnsupportedScheme: ({ input }: { input: string }) => ({
		message: `Use an http:// or https:// address, not "${input}".`,
		input,
	}),
	/** The text is not a parseable http(s) URL. */
	Malformed: ({ input }: { input: string }) => ({
		message: `"${input}" is not a valid URL.`,
		input,
	}),
});
export type InstanceUrlError = InferErrors<typeof InstanceUrlError>;

/**
 * Normalize user-entered instance text into a canonical `baseURL`: trim, default
 * a missing scheme to `https://`, require http(s), and drop any query, hash, and
 * trailing slash while preserving a path prefix (the route builders concatenate
 * `${baseURL}/api/...`, so a prefix like `https://host/epicenter` is honored).
 *
 * `http://` is allowed on purpose so a homelabber can point at
 * `http://localhost:8788`; WebSocket transports rewrite the ws scheme to match.
 */
export function normalizeInstanceUrl(
	raw: string,
): Result<string, InstanceUrlError> {
	const trimmed = raw.trim();
	if (trimmed === '') return InstanceUrlError.Empty();
	// A written-out scheme must be http(s); a bare host defaults to https so a
	// homelabber can type "box.local:8788". Reject `ftp://…` rather than
	// prepending https to it.
	const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
	if (hasScheme && !/^https?:\/\//i.test(trimmed)) {
		return InstanceUrlError.UnsupportedScheme({ input: raw });
	}
	let url: URL;
	try {
		url = new URL(hasScheme ? trimmed : `https://${trimmed}`);
	} catch {
		return InstanceUrlError.Malformed({ input: raw });
	}
	// The scheme gate plus the https default leave the protocol always http(s),
	// so only an empty host (e.g. "https://") can still slip through here.
	if (url.hostname === '') return InstanceUrlError.Malformed({ input: raw });
	return Ok(`${url.origin}${url.pathname}`.replace(/\/+$/, ''));
}
