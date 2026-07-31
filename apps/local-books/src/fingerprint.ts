/**
 * Canonical JSON and a domain-separated SHA-256 fingerprint for mirror
 * declarations. The fingerprint describes stored row shape and derivation,
 * not indexes, paths, cursors, credentials, or runtime details.
 */

function canonicalJson(value: unknown): string {
	if (value === null) return 'null';

	switch (typeof value) {
		case 'string':
			return JSON.stringify(value);
		case 'boolean':
			return value ? 'true' : 'false';
		case 'number':
			if (!Number.isFinite(value)) {
				throw new TypeError(
					'Fingerprint declarations cannot contain non-finite numbers',
				);
			}
			return JSON.stringify(value);
		case 'object':
			if (Array.isArray(value)) {
				return `[${value.map(canonicalJson).join(',')}]`;
			}
			return `{${Object.keys(value)
				.sort()
				.map(
					(key) =>
						`${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
				)
				.join(',')}}`;
		default:
			throw new TypeError(
				`Fingerprint declarations cannot contain ${typeof value} values`,
			);
	}
}

export function fingerprintDeclaration(
	domain: string,
	declaration: unknown,
): string {
	const hasher = new Bun.CryptoHasher('sha256');
	hasher.update(`${domain}\0${canonicalJson(declaration)}`);
	return hasher.digest('hex');
}

export function canonicalizeDeclaration(declaration: unknown): string {
	return canonicalJson(declaration);
}
