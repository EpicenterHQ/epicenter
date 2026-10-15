/**
 * How the todos folder signs in to its remote, in both builds.
 *
 * The folder asks `credentials` right before each push and fetch with the URL
 * it is about to reach (`@epicenter/folder`'s `GitCredentials`), and keeps
 * nothing it is given. There are two kinds of remote:
 *
 * - Epicenter's: a repository under `<server>/git/` on the server this build
 *   signs in to (ADR-0521). `connectEpicenter` asks the server for the
 *   folder's repository and a write token for it alone; the token lives in
 *   memory, is renewed before it expires, and is dropped when the account
 *   signs out or changes. It is sent only to the exact remote the server
 *   named.
 * - Any other: a token the person pasted for that exact URL, kept in this
 *   device's local storage, or none, so the desktop's `git` uses the person's
 *   own credential helper or SSH key.
 */
import type { Account, AuthClient } from '@epicenter/auth';
import type { GitCredential, GitCredentials } from '@epicenter/folder';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { TODOS_FOLDER_ID } from './platform/types.js';

/** Renew a hosted token this long before it expires. */
const RENEW_BEFORE_MS = 5 * 60_000;
/** Pasted tokens, one per exact remote URL. */
const PASTED_PREFIX = 'so.epicenter.todos.git-credential:';

export const GitAccessError = defineErrors({
	SignInRequired: () => ({
		message: 'Sign in to Epicenter to sync with it.',
	}),
	OtherAccount: ({ remote }: { remote: string }) => ({
		message: `These todos sync with ${remote}, which the signed-in Epicenter account does not own. Sign in with the account that connected them, or connect again.`,
		remote,
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
export type GitAccessError = InferErrors<typeof GitAccessError>;

type Hosted = {
	readonly account: Account;
	readonly remote: string;
	readonly credential: GitCredential;
	/** When to renew, by this device's clock, from the server's `expiresIn`. */
	readonly renewAt: number;
};

export type GitAccess = {
	readonly credentials: GitCredentials;
	/** The folder's repository on Epicenter's server, with a fresh token for it. */
	connectEpicenter(): Promise<Result<string, GitAccessError>>;
	/** Whether `url` names a repository on the server this build signs in to. */
	isEpicenter(url: string): boolean;
	/** Keep `credential` for exactly `url`, or forget it when `undefined`. */
	remember(url: string, credential: GitCredential | undefined): void;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null;

export function createGitAccess({
	auth,
	storage = globalThis.localStorage,
	now = Date.now,
}: {
	auth: AuthClient | undefined;
	storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
	now?: () => number;
}): GitAccess {
	/** The signed-in account's repository and token, once connected. */
	let hosted: Hosted | undefined;
	/** Pasted tokens this page holds when storage refuses them. */
	const held = new Map<string, GitCredential>();
	auth?.onStateChange(() => {
		hosted = undefined;
	});

	const account = () => {
		const state = auth?.getState();
		return state?.status === 'signed-in' ? state.account : undefined;
	};

	const isEpicenter = (url: string) => {
		if (auth === undefined) return false;
		try {
			const target = new URL(url);
			return (
				target.origin === new URL(auth.baseURL).origin &&
				target.pathname.startsWith('/git/')
			);
		} catch {
			return false;
		}
	};

	/** Ask the server for `current`'s repository and a fresh token for it. */
	async function connect(
		current: Account,
	): Promise<Result<Hosted, GitAccessError>> {
		let response: Response;
		try {
			response = await current.fetch(
				new URL('/api/git/connect', current.baseURL),
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ folder: TODOS_FOLDER_ID }),
				},
			);
		} catch (cause) {
			return GitAccessError.Unreachable({ cause });
		}
		const body: unknown = await response.json().catch(() => undefined);
		if (!response.ok)
			return GitAccessError.Refused({
				status: response.status,
				detail:
					isObject(body) && typeof body.message === 'string'
						? body.message
						: undefined,
			});
		if (
			!isObject(body) ||
			typeof body.remote !== 'string' ||
			typeof body.token !== 'string' ||
			typeof body.expiresIn !== 'number' ||
			!isEpicenter(body.remote)
		)
			return GitAccessError.Malformed();
		// A sign-out or account change while this was in flight retires it.
		if (account() !== current) return GitAccessError.SignInRequired();
		hosted = {
			account: current,
			remote: body.remote,
			credential: { username: 'x-token', password: body.token },
			renewAt: now() + body.expiresIn * 1000 - RENEW_BEFORE_MS,
		};
		return Ok(hosted);
	}

	async function connectEpicenter(): Promise<Result<string, GitAccessError>> {
		const current = account();
		if (current === undefined) return GitAccessError.SignInRequired();
		const { data, error } = await connect(current);
		return error === null ? Ok(data.remote) : Err(error);
	}

	const credentials: GitCredentials = async (url) => {
		if (!isEpicenter(url)) return pasted(url);
		const refuse = (error: GitAccessError): never => {
			throw new Error(error.message);
		};
		const current = account();
		if (current === undefined)
			return refuse(GitAccessError.SignInRequired().error);
		const known = hosted?.account === current ? hosted : undefined;
		// This account's own repository is another: ask the server for nothing.
		if (known !== undefined && known.remote !== url)
			return refuse(GitAccessError.OtherAccount({ remote: url }).error);
		if (known !== undefined && now() < known.renewAt) return known.credential;
		const { data: fresh, error } = await connect(current);
		if (error !== null) return refuse(error);
		// A transfer to Epicenter always carries this account's token, or none goes.
		if (account() !== current)
			return refuse(GitAccessError.SignInRequired().error);
		if (fresh.remote !== url)
			return refuse(GitAccessError.OtherAccount({ remote: url }).error);
		return fresh.credential;
	};

	function pasted(url: string): GitCredential | undefined {
		try {
			const raw = storage.getItem(PASTED_PREFIX + url);
			if (raw === null) return held.get(url);
			const value: unknown = JSON.parse(raw);
			return typeof value === 'object' &&
				value !== null &&
				'username' in value &&
				typeof value.username === 'string' &&
				'password' in value &&
				typeof value.password === 'string'
				? { username: value.username, password: value.password }
				: undefined;
		} catch {
			return held.get(url);
		}
	}

	function remember(url: string, credential: GitCredential | undefined) {
		if (credential === undefined) held.delete(url);
		else held.set(url, credential);
		try {
			if (credential === undefined) storage.removeItem(PASTED_PREFIX + url);
			else storage.setItem(PASTED_PREFIX + url, JSON.stringify(credential));
		} catch {
			// Without storage the token lasts until this page closes.
		}
	}

	return { credentials, connectEpicenter, isEpicenter, remember };
}
