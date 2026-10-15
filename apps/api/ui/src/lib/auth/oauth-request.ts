/**
 * The authorization server's pages (ADR-0549): sign-in, consent, and device
 * approval. The server sends the browser to sign-in and consent with the
 * authorization request it signed; the page hands that signed query back.
 */

/** The parameters the server adds when it signs an authorization request. */
const SIGNING_PARAMS = ['sig', 'exp', 'ba_iat', 'ba_param', 'ba_pl'];

export type OAuthRequest = {
	clientId: string;
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
	if (!clientId || !params.get('sig')) return null;
	const resume = new URLSearchParams(params);
	for (const name of SIGNING_PARAMS) resume.delete(name);
	// Signing in satisfied a `prompt=login`; asking again would loop.
	if (resume.get('prompt') === 'login') resume.delete('prompt');
	return {
		clientId,
		scopes: (params.get('scope') ?? '').split(' ').filter(Boolean),
		oauthQuery: search.replace(/^\?/, ''),
		resumeUrl: `/auth/oauth2/authorize?${resume}`,
	};
}

/** What each scope lets an app do, in the words a person reads. */
const SCOPE_COPY: Record<string, string> = {
	'folders:read': 'Read your folders',
	'folders:write': 'Change your folders',
	ai: 'Use Epicenter AI on your plan',
	profile: 'See your name, email, plan, and usage',
	offline_access: 'Stay signed in on that device',
};

/** The scope lines to show, skipping the ones that grant nothing on their own. */
export function describeScopes(scopes: readonly string[]): string[] {
	return scopes.flatMap((scope) => {
		const copy = SCOPE_COPY[scope];
		return copy ? [copy] : [];
	});
}

/** One choice on the folder picker, as `/auth/grant-target/options` lists it. */
export type GrantTargetOption = { target: string; label: string };

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

/** The folder choices for the signed-in person. */
export async function fetchGrantTargets(): Promise<GrantTargetOption[]> {
	return readJson<GrantTargetOption[]>(
		await fetch('/auth/grant-target/options', { credentials: 'include' }),
		'Could not load your folders.',
	);
}

/** The app's public name, for the consent and approval pages. */
export async function fetchPublicClient(clientId: string) {
	return readJson<PublicClient>(
		await fetch(
			`/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`,
			{ credentials: 'include' },
		),
		'Could not load the app.',
	);
}

/**
 * Stage the folder choice for the request that follows: one app's consent, or
 * one device code's approval.
 */
export async function selectGrantTarget(
	target: string,
	forRequest: { clientId: string } | { userCode: string },
) {
	await readJson(
		await fetch('/auth/grant-target/select', {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				target,
				...('clientId' in forRequest
					? { client_id: forRequest.clientId }
					: { user_code: forRequest.userCode }),
			}),
		}),
		'Could not save your folder choice.',
	);
}
