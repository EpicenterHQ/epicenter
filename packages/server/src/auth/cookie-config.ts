import type { BetterAuthOptions } from 'better-auth';

/**
 * Choose Better Auth cookie transport settings for the current API origin.
 *
 * Use this from the auth server factory, not from client code. Localhost uses
 * host-only, non-secure Lax cookies so the Vite auth proxy can work during
 * development. Deployed API origins use host-only, secure Lax cookies for
 * hosted sign-in, account management, and session handoff. Application data
 * requests carry session bearers. Lax permits cookies on top-level GET
 * callbacks such as Google's; it does not cover cross-site POST callbacks.
 *
 * There is deliberately no cross-subdomain knob: a `Domain=` cookie shared
 * across subdomains is the halfway cookie ADR-0079 forbids (it widens CSRF
 * surface and blurs audience boundaries), and it had zero consumers.
 */
export function createCookieAdvancedConfig(baseURL: string) {
	const { hostname } = new URL(baseURL);
	if (
		hostname === 'localhost' ||
		hostname === '127.0.0.1' ||
		hostname === '[::1]'
	) {
		return {
			useSecureCookies: false,
			defaultCookieAttributes: {
				sameSite: 'lax',
				secure: false,
			},
		} satisfies NonNullable<BetterAuthOptions['advanced']>;
	}

	return {
		useSecureCookies: true,
		defaultCookieAttributes: {
			sameSite: 'lax',
			secure: true,
		},
	} satisfies NonNullable<BetterAuthOptions['advanced']>;
}
