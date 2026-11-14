/**
 * The authorization server's pages (ADR-0549): sign-in, consent, and the
 * device page. The server sends the browser to sign-in and consent with the
 * authorization request it signed; the page hands that signed query back. A
 * device code's request is `/oauth2/authorize?user_code=<code>`, and its
 * consent approves the code.
 */

/** The parameters the server adds when it signs an authorization request. */
const SIGNING_PARAMS = ['sig', 'exp', 'ba_iat', 'ba_param', 'ba_pl'];

export type OAuthRequest = {
	/** The client asking. Sign-in for a device code does not name it yet. */
	clientId: string | null;
	/** The device code this request approves, when it is one. */
	userCode: string | null;
	scopes: string[];
	/** The signed query, handed back to `/auth/oauth2/consent`. */
	oauthQuery: string;
	/** Where an already signed-in browser resumes the authorization. */
	resumeUrl: string;
};

/** A signed authorization request, or null when the page was opened directly. */
export function readOAuthRequest(search: string): OAuthRequest | null {
	const params = new URLSearchParams(search);
	const clientId = params.get('client_id');
	const userCode = params.get('user_code');
	if ((!clientId && !userCode) || !params.get('sig')) return null;
	const resume = new URLSearchParams(params);
	for (const name of SIGNING_PARAMS) resume.delete(name);
	// Signing in satisfied a `prompt=login`; asking again would loop.
	if (resume.get('prompt') === 'login') resume.delete('prompt');
	return {
		clientId,
		userCode,
		scopes: (params.get('scope') ?? '').split(' ').filter(Boolean),
		oauthQuery: search.replace(/^\?/, ''),
		resumeUrl: `/auth/oauth2/authorize?${resume}`,
	};
}

/** Where the device page sends a code: the authorization server's approval. */
export function deviceAuthorizeUrl(userCode: string) {
	return `/auth/oauth2/authorize?${new URLSearchParams({ user_code: userCode })}`;
}

/**
 * What each scope lets an app do, in the words a person reads, in the order
 * they are shown. `folders:all` comes first: it says which folders the
 * reading and changing below it reach (ADR-0820).
 */
const SCOPE_COPY = new Map([
	[
		'folders:all',
		'Reach every folder you have, not only the ones you use with this app',
	],
	['folders:read', 'Read your folders'],
	['folders:write', 'Change your folders'],
	['ai', 'Use Epicenter AI on your plan'],
	['profile', 'See your name, plan, and usage'],
	['email', 'See your email address'],
	['offline_access', 'Stay signed in on that device'],
]);

/** The scope lines to show, skipping the ones that grant nothing on their own. */
export function describeScopes(scopes: readonly string[]): string[] {
	const asked = new Set(scopes);
	return [...SCOPE_COPY].flatMap(([scope, copy]) =>
		asked.has(scope) ? [copy] : [],
	);
}

/** The app as the server describes it publicly. */
export type PublicClient = {
	client_id: string;
	client_name?: string;
	client_uri?: string;
};

/** Read a JSON answer from the server, or throw its message. */
export async function readJson<T>(response: Response, fallback: string) {
	const body = (await response.json().catch(() => ({}))) as T & {
		message?: string;
		error_description?: string;
	};
	if (!response.ok)
		throw new Error(body.error_description ?? body.message ?? fallback);
	return body;
}

/** The app's public name, for the consent page. */
export async function fetchPublicClient(clientId: string) {
	return readJson<PublicClient>(
		await fetch(
			`/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`,
			{ credentials: 'include' },
		),
		'Could not load the app.',
	);
}
