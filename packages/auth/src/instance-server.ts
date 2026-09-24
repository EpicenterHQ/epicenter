/** Validate a configured instance origin before constructing its credential and data lifetimes. */
export function normalizeInstanceServer(input: string) {
	const url = new URL(input.trim());
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
