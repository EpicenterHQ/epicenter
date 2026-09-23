export const MAX_HOSTED_BLOB_BYTES = 25 * 1024 * 1024;

/** Stable Personal object addresses shared by the HTTP authority and clients. */
export const PERSONAL_BLOB_COLLECTION =
	'/api/blobs/personal/:principalId/:visibility';
export const PERSONAL_BLOB_OBJECT = `${PERSONAL_BLOB_COLLECTION}/:key`;

const ownerPattern = /^[A-Za-z0-9_-]{1,64}$/;
const keyPattern = /^[A-Za-z0-9_-]{22}$/;

export type PersonalBlobAddress = {
	principalId: string;
	visibility: 'private' | 'public';
	key: string;
	storageKey: string;
};

/** The authority is one canonical origin, with HTTP allowed only on loopback. */
function authorityOrigin(authority: string): string | undefined {
	try {
		const url = new URL(authority);
		if (
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			url.pathname !== '/' ||
			(url.protocol !== 'https:' &&
				!(
					url.protocol === 'http:' &&
					['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
				))
		)
			return undefined;
		return url.origin;
	} catch {
		return undefined;
	}
}

/** Parse the literal route path without depending on a reverse proxy's Host. */
export function parsePersonalBlobPath(path: string): PersonalBlobAddress | undefined {
	const match =
		/^\/api\/blobs\/personal\/([^/]+)\/(private|public)\/([^/]+)$/.exec(path);
	if (!match) return undefined;
	const [, principalId, visibility, key] = match;
	if (!principalId || !ownerPattern.test(principalId) || !key || !keyPattern.test(key))
		return undefined;
	return {
		principalId,
		visibility: visibility as 'private' | 'public',
		key,
		storageKey: `personal/${principalId}/${visibility}/${key}`,
	};
}

/** Accept only a complete, canonical URL on the captured authority. */
export function parsePersonalBlobUrl(
	value: string,
	authority: string,
): PersonalBlobAddress | undefined {
	const origin = authorityOrigin(authority);
	if (!origin) return undefined;
	try {
		const url = new URL(value);
		if (
			url.origin !== origin ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			value !== url.href
		)
			return undefined;
		return parsePersonalBlobPath(url.pathname);
	} catch {
		return undefined;
	}
}

export function personalBlobCollectionUrl(
	authority: string,
	principalId: string,
	visibility: 'private' | 'public',
): string {
	const origin = authorityOrigin(authority);
	if (!origin || !ownerPattern.test(principalId))
		throw new TypeError('Invalid personal blob authority or owner');
	return `${origin}/api/blobs/personal/${principalId}/${visibility}`;
}

export function mintPersonalBlobUrl(
	authority: string,
	principalId: string,
	visibility: 'private' | 'public',
): string {
	const key = btoa(
		String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))),
	)
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/, '');
	return `${personalBlobCollectionUrl(authority, principalId, visibility)}/${key}`;
}
