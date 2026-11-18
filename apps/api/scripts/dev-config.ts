import { LOCAL_API_ORIGIN } from '../origins.js';

/** The public issuer used by the local Worker and its sign-in pages. */
export function localPublicOrigin(override: string | undefined): string {
	const origin = override ?? LOCAL_API_ORIGIN;
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
