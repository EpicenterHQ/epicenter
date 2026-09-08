import { API_ROUTES } from '@epicenter/constants/api-routes';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { AuthFetch } from './auth-contract.js';
import { AuthError } from './auth-errors.js';
import { ApiSessionResponse, type Principal } from './auth-types.js';

/**
 * The neutral outcome of one bearer `/api/session` read. The variants name the
 * four ways the read can fail. A refusal pauses session access or rejects the
 * instance connection; an infrastructure failure preserves cached identity.
 */
export const ApiSessionReadError = defineErrors({
	/** The `fetch` itself threw (network, DNS, CORS, offline). */
	Unreachable: ({ cause }: { cause: unknown }) => ({
		message: `Could not reach ${API_ROUTES.session.pattern}: ${extractErrorMessage(cause)}`,
		cause,
	}),
	/** The bearer was rejected with a 401 or 403. */
	Rejected: ({ status }: { status: 401 | 403 }) => ({
		message: `${API_ROUTES.session.pattern} rejected the bearer (${status}).`,
		status,
	}),
	/** The server answered with some other non-ok status. */
	Unexpected: ({ status }: { status: number }) => ({
		message: `${API_ROUTES.session.pattern} failed with ${status}.`,
		status,
	}),
	/** The body could not be read or did not match {@link ApiSessionResponse}. */
	Malformed: ({ cause }: { cause: unknown }) => ({
		message: `${API_ROUTES.session.pattern} returned an unreadable body: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type ApiSessionReadError = InferErrors<typeof ApiSessionReadError>;

/**
 * Read `/api/session` once with a bearer token and return the validated session
 * or a neutral failure.
 *
 * Session verification and the instance-token boot check share this read.
 * Each owner decides how the result affects its own lifetime and state.
 *
 * `baseURL` is the deployment's authority origin (ADR-0326), already canonical.
 */
export async function readApiSession({
	baseURL,
	fetch,
	token,
}: {
	baseURL: string;
	fetch: AuthFetch;
	token: string;
}): Promise<Result<ApiSessionResponse, ApiSessionReadError>> {
	let response: Response;
	try {
		response = await fetch(API_ROUTES.session.url(baseURL), {
			headers: { Authorization: `Bearer ${token}` },
			credentials: 'omit',
			redirect: 'error',
		});
	} catch (cause) {
		return ApiSessionReadError.Unreachable({ cause });
	}
	if (!response.ok) {
		if (response.status === 401 || response.status === 403) {
			return ApiSessionReadError.Rejected({ status: response.status });
		}
		return ApiSessionReadError.Unexpected({ status: response.status });
	}
	return tryAsync({
		try: async () => ApiSessionResponse.assert(await response.json()),
		catch: (cause) => ApiSessionReadError.Malformed({ cause }),
	});
}

/**
 * Read `/api/session` as an {@link Principal} for the bearer clients' `getProfile`.
 *
 * `fetch` is the client's own auth-attaching fetch: it owns the Authorization
 * header (it sets the bearer for the Epicenter origin and strips it elsewhere),
 * so this reuses {@link readApiSession} only for the request, status branching,
 * and body parsing. The token readApiSession is given is overwritten by `fetch`
 * before the wire, so it is passed empty. Any read failure (unreachable,
 * rejected, unexpected, malformed) surfaces as the single `ProfileUnavailable`
 * the `AuthClient` contract returns.
 */
export async function getProfileVia(
	fetch: AuthFetch,
	baseURL: string,
): Promise<Result<Principal, AuthError>> {
	const { data: session, error } = await readApiSession({
		baseURL,
		fetch,
		token: '',
	});
	if (error) return AuthError.ProfileUnavailable({ cause: error });
	return Ok({ id: session.principalId, email: session.email });
}
