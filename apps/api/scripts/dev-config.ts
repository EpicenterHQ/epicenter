import { APPS, localUrl } from '@epicenter/definition/site';
import type { Unstable_RawConfig as WranglerConfig } from 'wrangler';

/** The public issuer used by the local Worker and its sign-in pages. */
export function localPublicOrigin(override: string | undefined): string {
	const origin = override ?? localUrl(APPS.API);
	const url = new URL(origin);
	if (
		url.protocol !== 'http:' ||
		!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
		url.origin !== origin
	)
		throw new Error(
			'API_PUBLIC_ORIGIN must be an HTTP loopback origin for local dev.',
		);
	return origin;
}

/** Wrangler must not attach a production custom domain during local dev. */
export function localWranglerConfig(config: WranglerConfig): WranglerConfig {
	return { ...config, routes: [] };
}
