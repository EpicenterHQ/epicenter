/** Deployment-owned network destination and local-data identity. Never chosen from saved user state. */
export type AuthServer = {
	baseURL: string;
	authorityId: string;
};

export function epicenterCloud(baseURL: string): AuthServer {
	return {
		baseURL: new URL(baseURL).origin,
		authorityId: 'epicenter-api',
	};
}

/** Validate a configured instance origin before constructing its credential and data lifetimes. */
export function selfHostedServer(origin: string): AuthServer {
	const url = new URL(origin.trim());
	if (
		!['http:', 'https:'].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.pathname !== '/' ||
		url.search ||
		url.hash
	) {
		throw new TypeError(
			'Expected a server origin, without a path, credentials, query, or fragment.',
		);
	}
	const baseURL = url.origin;
	// URL aliases are separate destinations. No implicit server migration.
	const authorityId =
		'instance-' +
		Array.from(new TextEncoder().encode(baseURL), (byte) =>
			byte.toString(16).padStart(2, '0'),
		).join('');
	return { baseURL, authorityId };
}
