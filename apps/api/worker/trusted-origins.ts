import { APPS, localUrl } from '@epicenter/constants/apps';

/**
 * Epicenter cloud's trusted-origin set. This lives in `apps/api`, not in the
 * shared `@epicenter/server` library: it names Epicenter's own app origins,
 * which only apps/api should trust.
 */

/**
 * Production origins trusted on every Epicenter cloud deployment: each app's
 * production `url`.
 *
 * Adding an app to `APPS` auto-extends this.
 *
 * No desktop webview origin is trusted. Epicenter's windows never call this
 * API themselves: the desktop host relays their account traffic with its own
 * bearer token, and no `tauri://localhost` page calls the API.
 *
 * No browser extension is trusted. Tab Manager's pinned
 * `chrome-extension://` origin used to sit here and outlived the extension:
 * `trustedOrigins` gates Better Auth's `callbackURL` / `redirectTo`
 * allow-list, not just cookie CSRF, so an origin nothing can serve from is
 * production trust granted to nobody. Should an extension ever return, add it
 * with a pinned origin (Chrome via the WXT `key`, Firefox via
 * `browser_specific_settings.gecko.id` plus AMO signing, required, no
 * exceptions; self-distributed XPIs get a random per-install UUID) rather than
 * a wildcard, which is what defeated CSRF protection the first time.
 */
const PRODUCTION_TRUSTED_ORIGINS: readonly string[] = Object.values(APPS).map(
	(app) => app.url,
);

/**
 * Development-only origins: each app's `localhost:<port>` dev server plus the
 * plain-HTTP API host that `wrangler dev` serves the custom domain over.
 *
 * These are trusted ONLY on a local deployment (see
 * {@link buildEpicenterTrustedOrigins}). A production isolate must not trust
 * `localhost`: `trustedOrigins` gates not just cookie CSRF but Better Auth's
 * `callbackURL` / `redirectTo` open-redirect allow-list, so a permanent
 * localhost entry needlessly widens the production surface. Local iteration
 * against the deployed API still works because a developer runs the API
 * locally too.
 */
const DEVELOPMENT_TRUSTED_ORIGINS: readonly string[] = [
	'http://localhost:5177',
	`http://127.0.0.1:${APPS.TODOS.port}`,
	...Object.values(APPS).map((app) => localUrl(app)),
	`http://${new URL(APPS.API.url).host}`,
];

/**
 * Whether the deployment's own origin is a loopback host, which is what makes
 * it a local development deployment. An unparseable origin is not local.
 */
export function isLocalDeployment(baseURL: string): boolean {
	try {
		const { hostname } = new URL(baseURL);
		return (
			hostname === 'localhost' ||
			hostname === '127.0.0.1' ||
			hostname === '[::1]'
		);
	} catch {
		return false;
	}
}

/**
 * Origins Epicenter cloud permits for CORS and Better Auth CSRF / redirect
 * checks.
 *
 * A local deployment additionally trusts the localhost dev origins so a
 * developer can iterate against a local API; a deployed origin trusts only the
 * production set. The deployment identity comes from the deployment's own auth
 * base URL, never the request.
 *
 * Frozen so the long-lived Cloudflare isolate cannot accumulate mutations
 * across requests. Typed `string[]` (not `readonly string[]`) because Better
 * Auth's `trustedOrigins` option expects a mutable array type.
 */
export function buildEpicenterTrustedOrigins(baseURL: string): string[] {
	return Object.freeze(
		isLocalDeployment(baseURL)
			? [...PRODUCTION_TRUSTED_ORIGINS, ...DEVELOPMENT_TRUSTED_ORIGINS]
			: [...PRODUCTION_TRUSTED_ORIGINS],
	) as string[];
}
