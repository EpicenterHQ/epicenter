export function parseFragment(fragment: string): {
	token: string | null;
	api: string | null;
	error: string | null;
} {
	const params = new URLSearchParams(fragment);
	const token = params.get('token')?.trim() || null;
	const api = params.get('api');
	if (api === null) return { token, api: null, error: null };

	try {
		const url = new URL(api);
		if (
			(url.protocol === 'http:' || url.protocol === 'https:') &&
			!url.username &&
			!url.password
		) {
			return { token, api: url.origin, error: null };
		}
	} catch {
		// Malformed URLs use the same validation error as unsupported origins.
	}
	return {
		token,
		api: null,
		error: 'API URL must use HTTP or HTTPS without credentials',
	};
}

export type Credentials = { apiOrigin: string; token: string };
export const credentialsKey = 'codex-voice-queue:credentials';

export function resolveCredentials(
	parsed: ReturnType<typeof parseFragment>,
	saved: Credentials | null,
): {
	credentials: Credentials | null;
	pendingApiOrigin: string | null;
	error: string | null;
} {
	const { token, api, error } = parsed;
	if (token)
		return {
			credentials: { apiOrigin: api ?? '', token },
			pendingApiOrigin: null,
			error,
		};
	if (api)
		return {
			credentials: saved?.apiOrigin === api ? saved : null,
			pendingApiOrigin: saved?.apiOrigin === api ? null : api,
			error,
		};
	return { credentials: saved, pendingApiOrigin: null, error };
}

export function loadCredentials(
	storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
): Credentials | null {
	const oldToken = storage.getItem('codex-voice-queue:token');
	const oldApi = storage.getItem('codex-voice-queue:api');
	storage.removeItem('codex-voice-queue:token');
	storage.removeItem('codex-voice-queue:api');
	if (oldToken && oldApi === null && !storage.getItem(credentialsKey)) {
		storage.setItem(
			credentialsKey,
			JSON.stringify({ apiOrigin: '', token: oldToken }),
		);
	}
	try {
		const saved = JSON.parse(storage.getItem(credentialsKey) ?? 'null');
		if (
			saved &&
			typeof saved.token === 'string' &&
			typeof saved.apiOrigin === 'string' &&
			(saved.apiOrigin === '' ||
				parseFragment(`api=${encodeURIComponent(saved.apiOrigin)}`).api ===
					saved.apiOrigin)
		)
			return saved;
	} catch {
		// Invalid saved credentials require unlocking again.
	}
	return null;
}
