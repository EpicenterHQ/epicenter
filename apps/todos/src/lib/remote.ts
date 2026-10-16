/**
 * The todos folder's hosted remote (ADR-0546): `<git origin>/<namespace>/<name>.git`
 * under the signed-in account's personal namespace. Nothing here holds a Git
 * token or asks for one.
 *
 * - Connect proposes `proposedName` from the folder's directory, looks up the
 *   account's personal namespace (`GET /api/repos`), and answers the remote
 *   URL. Where the page can reach Git (`pageReachesGit`: the browser), it
 *   also makes the repository exist, since the first sync fetches before it
 *   pushes. On the desktop, `epicenter sync` does that, with the desktop
 *   grant.
 * - `httpFetch` is the browser folder's Git transport. It sends this build's
 *   own access token to Epicenter's Git origin through the account, and
 *   everything else through plain `fetch`, so no other server sees it.
 */
import type { Account } from '@epicenter/auth';
import { resolveOAuthAudiences } from '@epicenter/constants/apps';
import {
	parseRepositoryUrl,
	type RepositoryListing,
	repositoryUrl,
	toRepositoryName,
} from '@epicenter/constants/repositories';
import type { HttpFetch } from '@epicenter/folder';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { auth, pageReachesGit } from '#platform/auth';
import { TODOS_FOLDER_ID } from './platform/types.js';

export const RemoteError = defineErrors({
	SignInRequired: () => ({
		message: 'Sign in to Epicenter to sync with it.',
	}),
	Refused: ({
		status,
		detail,
	}: {
		status: number;
		detail: string | undefined;
	}) => ({
		message:
			status === 503
				? 'This Epicenter server does not keep todos. Connect to another server.'
				: (detail ??
					`Epicenter refused to connect the todos (HTTP ${status}).`),
		status,
	}),
	Unreachable: ({ cause }: { cause: unknown }) => ({
		message:
			'Todos could not reach Epicenter. Check your connection and try again.',
		cause,
	}),
	Malformed: () => ({
		message: 'Epicenter answered in a way Todos cannot read.',
	}),
});
export type RemoteError = InferErrors<typeof RemoteError>;

/** The repository name Connect proposes: the folder's directory, made a valid name. */
export const proposedName = toRepositoryName(TODOS_FOLDER_ID) ?? 'todos';

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null;

const gitAudience = auth && resolveOAuthAudiences(auth.baseURL).git;

const account = (): Account | undefined => {
	const state = auth?.getState();
	return state?.status === 'signed-in' ? state.account : undefined;
};

/** Whether `url` is one of the hosted repositories on the server this build signs in to. */
export function isEpicenter(url: string): boolean {
	return (
		gitAudience !== undefined &&
		parseRepositoryUrl(gitAudience, url) !== undefined
	);
}

/** The refusal in `response`, as the person reads it. */
async function refused(response: Response): Promise<RemoteError> {
	const body: unknown = await response.json().catch(() => undefined);
	return RemoteError.Refused({
		status: response.status,
		detail:
			isObject(body) && typeof body.error_description === 'string'
				? body.error_description
				: undefined,
	}).error;
}

/**
 * The remote URL for repository `name` in the signed-in account's personal
 * namespace, with the repository made when the page can reach Git.
 */
export async function connectEpicenter(
	name: string,
): Promise<Result<string, RemoteError>> {
	const current = account();
	if (current === undefined || gitAudience === undefined)
		return RemoteError.SignInRequired();
	let url: string;
	try {
		const response = await current.fetch(
			new URL('/api/repos', current.baseURL),
		);
		if (!response.ok) return Err(await refused(response));
		const listing = (await response.json().catch(() => undefined)) as
			| RepositoryListing
			| undefined;
		const personal = listing?.namespaces?.find(
			(namespace) => namespace.personal,
		);
		if (personal === undefined) return RemoteError.Malformed();
		url = repositoryUrl(gitAudience, { namespace: personal.id, name });
		if (pageReachesGit) {
			// The first request of a push creates the repository.
			const created = await current.fetch(
				`${url}/info/refs?service=git-receive-pack`,
			);
			await created.body?.cancel();
			if (!created.ok) return Err(await refused(created));
		}
	} catch (cause) {
		return RemoteError.Unreachable({ cause });
	}
	// A sign-out or account change while this was in flight retires it.
	if (account() !== current) return RemoteError.SignInRequired();
	return Ok(url);
}

/** Whether `url` is under Epicenter's Git origin, whatever it names there. */
function underGitAudience(url: string): boolean {
	if (gitAudience === undefined) return false;
	try {
		const target = new URL(url);
		const audience = new URL(gitAudience);
		const prefix = audience.pathname.replace(/\/+$/, '');
		return (
			target.origin === audience.origin &&
			(target.pathname === prefix || target.pathname.startsWith(`${prefix}/`))
		);
	} catch {
		return false;
	}
}

/**
 * The browser folder's Git transport: this build's account for Epicenter's
 * Git origin, plain `fetch` for any other remote, which never sees the token.
 */
export const httpFetch: HttpFetch = (input, init) => {
	const url =
		input instanceof Request
			? input.url
			: input instanceof URL
				? input.href
				: input;
	if (!underGitAudience(url)) return fetch(input, init);
	const current = account();
	if (current === undefined)
		return Promise.reject(
			new Error(RemoteError.SignInRequired().error.message),
		);
	return current.fetch(input, init);
};
