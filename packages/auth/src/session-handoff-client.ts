const ATTEMPT_MAX_AGE_MS = 10 * 60_000;

function absoluteUrl(value: string) {
	if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value) || /[\s\\#]/.test(value))
		throw new Error('An absolute URL without a fragment is required.');
	const url = new URL(value);
	if (!url.host || url.username || url.password)
		throw new Error('URL credentials are not allowed.');
	return url;
}

function base64url(bytes: Uint8Array) {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '');
}

/** One browser/native PKCE ceremony. Storage is synchronous, like sessionStorage.
 * Credentials belong to the caller; this client only returns a redeemed token.
 * Callback configuration must be an absolute URL without query or fragment.
 */
export function createSessionHandoffClient({
	baseURL,
	callback,
	storage,
	fetch: fetchImpl = globalThis.fetch.bind(globalThis),
}: {
	baseURL: string;
	callback: string;
	storage: Pick<Storage, 'getItem' | 'setItem'>;
	fetch?: (
		input: Request | string | URL,
		init?: RequestInit,
	) => Promise<Response>;
}) {
	const server = absoluteUrl(baseURL);
	if (!['http:', 'https:'].includes(server.protocol) || server.search)
		throw new Error('The auth server must be an HTTP(S) URL without a query.');
	const destination = absoluteUrl(callback);
	if (destination.search || callback.includes('?'))
		throw new Error('The callback must not contain a query.');
	const callbackUrl = destination.href;
	const key = `epicenter.session-handoff:${server.origin}:${callbackUrl}`;
	let generation = 0;

	return {
		/** Supersede the previous attempt and persist before returning the login URL. */
		async begin(): Promise<URL> {
			const startedGeneration = ++generation;
			const version = crypto.randomUUID();
			const started = JSON.stringify({ version });
			storage.setItem(key, started);
			const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
			const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
			const challenge = base64url(
				new Uint8Array(
					await crypto.subtle.digest(
						'SHA-256',
						new TextEncoder().encode(verifier),
					),
				),
			);
			if (generation !== startedGeneration || storage.getItem(key) !== started)
				throw new Error('Sign-in was superseded.');
			storage.setItem(
				key,
				JSON.stringify({
					version,
					verifier,
					state,
					callback: callbackUrl,
					createdAt: Date.now(),
				}),
			);
			const url = new URL('/sign-in', server);
			url.search = new URLSearchParams({
				callback: callbackUrl,
				challenge,
				state,
			}).toString();
			return url;
		},
		/** Consume a matching attempt once. Reject failures and stale completions. */
		async complete(value: string | URL): Promise<string> {
			const startedGeneration = generation;
			const url = absoluteUrl(String(value));
			const params = new URLSearchParams(url.search);
			const code = params.get('code');
			const state = params.get('state');
			url.search = '';
			if (
				url.href !== callbackUrl ||
				!code ||
				code.length > 128 ||
				!state ||
				[...params.keys()].length !== 2 ||
				params.getAll('code').length !== 1 ||
				params.getAll('state').length !== 1
			)
				throw new Error('Invalid sign-in callback.');
			const raw = storage.getItem(key);
			const pending: unknown = raw === null ? null : JSON.parse(raw);
			if (
				!pending ||
				typeof pending !== 'object' ||
				!('version' in pending) ||
				typeof pending.version !== 'string' ||
				!pending.version ||
				!('verifier' in pending) ||
				typeof pending.verifier !== 'string' ||
				!/^[A-Za-z0-9_-]{43}$/.test(pending.verifier) ||
				!('state' in pending) ||
				pending.state !== state ||
				!('callback' in pending) ||
				pending.callback !== callbackUrl ||
				!('createdAt' in pending) ||
				typeof pending.createdAt !== 'number' ||
				!Number.isFinite(pending.createdAt) ||
				Date.now() < pending.createdAt ||
				Date.now() - pending.createdAt >= ATTEMPT_MAX_AGE_MS
			)
				throw new Error(
					'Sign-in attempt is missing, expired, or does not match.',
				);
			// Consume the verifier, retaining ownership after this and later completions.
			// Every instance compares this same cell; an empty cell proves nothing.
			const consumed = JSON.stringify({ version: pending.version });
			storage.setItem(key, consumed);
			const response = await fetchImpl(
				new URL('/auth/session/redeem', server),
				{
					method: 'POST',
					credentials: 'omit',
					redirect: 'error',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						callback: callbackUrl,
						code,
						state,
						verifier: pending.verifier,
					}),
				},
			);
			if (!response.ok)
				throw new Error(`Session redemption failed (${response.status}).`);
			const result: unknown = await response.json();
			if (
				!result ||
				typeof result !== 'object' ||
				!('token' in result) ||
				typeof result.token !== 'string' ||
				!result.token ||
				/\s/.test(result.token)
			)
				throw new Error('Session redemption returned an invalid token.');
			let ownsCompletion = false;
			try {
				ownsCompletion =
					generation === startedGeneration && storage.getItem(key) === consumed;
			} catch {
				// An unreadable ownership record cannot authorize returning a token.
			}
			if (!ownsCompletion) {
				// Do not abort redemption: its response may carry an orphan to revoke.
				void Promise.resolve()
					.then(() =>
						fetchImpl(new URL('/auth/sign-out', server), {
							method: 'POST',
							credentials: 'omit',
							redirect: 'error',
							headers: {
								'content-type': 'application/json',
								authorization: `Bearer ${result.token}`,
							},
							body: '{}',
						}),
					)
					.catch(() => undefined);
				throw new Error('Sign-in was cancelled or superseded.');
			}
			return result.token;
		},
		/** Invalidate every instance's in-flight work with a fresh shared tombstone.
		 * Throws if storage cannot persist cancellation.
		 */
		cancel(): void {
			// Local cancellation still takes effect when shared storage cannot write.
			generation += 1;
			storage.setItem(key, JSON.stringify({ version: crypto.randomUUID() }));
		},
	};
}
