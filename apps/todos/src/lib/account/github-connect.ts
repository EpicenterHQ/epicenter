/**
 * Connecting GitHub across the redirect. `startGitHubConnect` keeps the
 * browser's `state`, PKCE verifier, callback, and the account it began for
 * in this tab's session storage, then returns the GitHub URL to navigate to.
 * GitHub returns through the connector to `/sync?github_code&github_state`,
 * where `finishGitHubConnect` takes that record back (once), checks the
 * state and the account, and completes with the verifier.
 *
 * Nothing here transfers Git data or pairs a folder.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	type ConnectorAccount,
	ConnectorError,
	challengeOf,
	createConnector,
	randomSecret,
} from './connector.js';

/** The session storage key of the one pending attempt in this tab. */
export const PENDING_CONNECT_KEY = 'so.epicenter.todos.github-connect';
/** The connector keeps a pending authorization for 10 minutes. */
const PENDING_LIFETIME_MS = 10 * 60 * 1000;

/** One attempt, kept in this tab between leaving for GitHub and returning. */
type PendingConnect = {
	readonly state: string;
	readonly verifier: string;
	readonly redirectUri: string;
	readonly authorityId: string;
	readonly principalId: string;
	readonly startedAt: number;
};

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** The exact callback the connector allow-lists: this origin's `/sync`. */
export function syncCallback(origin: string): string {
	return `${origin}/sync`;
}

/**
 * Begin connecting GitHub for `account`, returning to `redirectUri`. The
 * pending record is written before the GitHub URL is returned, so the page
 * that navigates there can always finish it.
 */
export async function startGitHubConnect({
	account,
	redirectUri,
	storage,
	isCurrent = () => true,
	now = Date.now,
}: {
	account: ConnectorAccount;
	redirectUri: string;
	storage: KeyValueStorage;
	isCurrent?: () => boolean;
	now?: () => number;
}): Promise<Result<string, ConnectorError>> {
	const state = randomSecret();
	const verifier = randomSecret();
	const { data: authorizeUrl, error } = await createConnector(account).connect({
		redirectUri,
		state,
		codeChallenge: await challengeOf(verifier),
	});
	if (error) return Err(error);
	if (!isCurrent()) return ConnectorError.Session();
	const pending: PendingConnect = {
		state,
		verifier,
		redirectUri,
		authorityId: account.authorityId,
		principalId: account.principalId,
		startedAt: now(),
	};
	storage.setItem(PENDING_CONNECT_KEY, JSON.stringify(pending));
	return Ok(authorizeUrl);
}

/** Why a return from GitHub did not connect it, in words a person acts on. */
export const ConnectReturnError = defineErrors({
	/** No matching attempt in this tab: another tab, a replay, or it expired. */
	Unknown: () => ({
		message:
			'This GitHub connection was not started in this tab, or it expired. Connect GitHub again.',
	}),
	/** The person declined, or GitHub or the connector refused. */
	Declined: ({
		code,
		installUrl,
	}: {
		code: string;
		installUrl: string | undefined;
	}) => ({
		message:
			code === 'access_denied'
				? 'GitHub authorization was declined. Nothing was connected.'
				: code === 'repository_unavailable'
					? 'The Epicenter Folder Sync app cannot reach a private repository for you yet. Install it on a repository, then connect again.'
					: 'GitHub did not finish connecting. Connect GitHub again.',
		code,
		installUrl,
	}),
	/** The signed-in account is not the one the attempt began for. */
	AccountChanged: () => ({
		message:
			'You are signed in to a different Epicenter account than the one that started connecting GitHub. Nothing was connected.',
	}),
});
export type ConnectReturnError = InferErrors<typeof ConnectReturnError>;

/** The one parameter `name`, when it appears exactly once. */
function single(params: URLSearchParams, name: string) {
	const values = params.getAll(name);
	return values.length === 1 ? values[0] : undefined;
}

function pendingFrom(raw: string | null): PendingConnect | undefined {
	if (raw === null) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		return undefined;
	const pending = value as Record<string, unknown>;
	if (
		typeof pending.state !== 'string' ||
		typeof pending.verifier !== 'string' ||
		typeof pending.redirectUri !== 'string' ||
		typeof pending.authorityId !== 'string' ||
		typeof pending.principalId !== 'string' ||
		typeof pending.startedAt !== 'number' ||
		!Number.isFinite(pending.startedAt)
	)
		return undefined;
	return {
		state: pending.state,
		verifier: pending.verifier,
		redirectUri: pending.redirectUri,
		authorityId: pending.authorityId,
		principalId: pending.principalId,
		startedAt: pending.startedAt,
	};
}

/** Whether `url` is a return from GitHub at all. */
export function isGitHubReturn(url: URL): boolean {
	return url.searchParams.has('github_state');
}

/**
 * Finish connecting GitHub from the return URL. The pending record is
 * removed whatever happens, so a code is never completed twice from here.
 * `account` is whoever is signed in now; it must be the account the attempt
 * began for.
 */
export async function finishGitHubConnect({
	url,
	account,
	storage,
	now = Date.now,
}: {
	url: URL;
	account: ConnectorAccount | undefined;
	storage: KeyValueStorage;
	now?: () => number;
}): Promise<Result<{ login: string }, ConnectReturnError | ConnectorError>> {
	const raw = storage.getItem(PENDING_CONNECT_KEY);
	storage.removeItem(PENDING_CONNECT_KEY);
	const pending = pendingFrom(raw);
	const state = single(url.searchParams, 'github_state');
	const age = pending === undefined ? undefined : now() - pending.startedAt;
	if (
		pending === undefined ||
		state === undefined ||
		pending.state !== state ||
		age === undefined ||
		age < 0 ||
		age >= PENDING_LIFETIME_MS
	)
		return ConnectReturnError.Unknown();
	const failure = single(url.searchParams, 'github_error');
	if (failure !== undefined) {
		const installUrl = single(url.searchParams, 'github_install_url');
		return ConnectReturnError.Declined({
			code: failure,
			installUrl: installUrl?.startsWith('https://github.com/')
				? installUrl
				: undefined,
		});
	}
	const code = single(url.searchParams, 'github_code');
	if (code === undefined) return ConnectReturnError.Unknown();
	if (
		account === undefined ||
		account.authorityId !== pending.authorityId ||
		account.principalId !== pending.principalId
	)
		return ConnectReturnError.AccountChanged();
	return createConnector(account).complete({
		code,
		verifier: pending.verifier,
		redirectUri: pending.redirectUri,
	});
}

/** This tab just connected GitHub; Connect says so once. */
const CONNECTED_KEY = 'so.epicenter.todos.github-connected';

/** Note that GitHub was just connected as `login`, for Connect to show. */
export function noteConnected(storage: KeyValueStorage, login: string) {
	storage.setItem(CONNECTED_KEY, login);
}

/** The login GitHub was just connected as, read once. */
export function takeConnected(storage: KeyValueStorage): string | undefined {
	const login = storage.getItem(CONNECTED_KEY);
	storage.removeItem(CONNECTED_KEY);
	return login ?? undefined;
}
