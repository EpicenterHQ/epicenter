/**
 * Machine auth API surface for CLI and other Node processes.
 *
 * `loginWithOob` runs the OOB OAuth dance once, fetches `/api/session` to derive
 * the local workspace identity, and persists a `PersistedAuth` cell to the
 * API-target-specific machine auth file (mode 0o600). `status` and `logout`
 * read that cell and reach the server through a regular `createOAuthAppAuth`
 * client. `createMachineAuthClient` is the long-lived Node entry point: it
 * loads the cell, constructs the auth client, and never spawns an interactive
 * launcher.
 *
 * Architectural note: `loginWithOob` deliberately bypasses
 * `createOAuthAppAuth`. The factory is for long-lived clients (refresh on
 * 401, network gate); login is a one-shot human action that fetches a grant,
 * calls `/api/session`, persists, and exits. Routing login through the factory
 * would double the round-trip count (the factory would call `/api/session`
 * internally, but the CLI also needs the email for "Signed in as ...").
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { EPICENTER_CLI_OAUTH_CLIENT_ID } from '@epicenter/constants/oauth-clients';
import envPaths from 'env-paths';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { AuthFetch, SyncAuthClient } from '../auth-contract.js';
import { PersistedAuth, type Principal } from '../auth-types.js';
import { createOAuthAppAuth } from '../create-oauth-app-auth.js';
import { serializePersistedAuth } from '../persisted-auth-storage.js';
import { readApiSession } from '../read-api-session.js';
import { createOobOAuthLauncher } from './oob-launcher.js';

/**
 * Auth's per-user data directory. Honors `EPICENTER_DATA_DIR` first, then
 * falls back to the env-paths platform data directory (e.g.
 * `~/Library/Application Support/epicenter` on macOS,
 * `~/.local/share/epicenter` on Linux). Resolved once at module load:
 * production env vars don't change mid-process.
 */
const DEFAULT_DATA_DIR =
	process.env.EPICENTER_DATA_DIR ?? envPaths('epicenter', { suffix: '' }).data;

/**
 * The on-disk machine auth file for a given API target.
 *
 * One file per API target under the platform data directory, in an `auth/`
 * subdirectory: `<dataDir>/auth/<host>.json` with `:` in the host replaced
 * by `_`. Prod resolves to `<dataDir>/auth/api.epicenter.so.json`; `cli:local`
 * (`EPICENTER_API_URL=http://localhost:8787`) resolves to
 * `<dataDir>/auth/localhost_8787.json`. Different targets cannot trample
 * each other.
 *
 * `dataDir` defaults to {@link DEFAULT_DATA_DIR} and exists as an override
 * for tests; production callers should never pass it.
 */
export function machineAuthFilePath({
	baseURL = EPICENTER_API_URL,
	dataDir = DEFAULT_DATA_DIR,
}: {
	baseURL?: string;
	dataDir?: string;
} = {}): string {
	let host: string;
	try {
		host = new URL(baseURL).host;
	} catch (cause) {
		throw new Error(`Invalid Epicenter API URL: ${baseURL}`, { cause });
	}
	return path.join(dataDir, 'auth', `${host.replaceAll(':', '_')}.json`);
}

const MachineAuthRequestError = defineErrors({
	RequestFailed: ({ cause }: { cause: unknown }) => ({
		message: `Auth transport request failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
type MachineAuthRequestError = InferErrors<typeof MachineAuthRequestError>;

export const MachineAuthStorageError = defineErrors({
	StorageFailed: ({ cause }: { cause: unknown }) => ({
		message: `Could not access machine auth storage: ${extractErrorMessage(cause)}`,
		cause,
	}),
	PermissionsTooOpen: ({
		filePath,
		mode,
	}: {
		filePath: string;
		mode: number;
	}) => ({
		message: `Refusing to load ${filePath}: permissions ${mode.toString(8)} are too permissive. Run: chmod 600 ${filePath}`,
		filePath,
		mode,
	}),
	NoSavedSession: ({
		filePath,
		baseURL,
	}: {
		filePath: string;
		baseURL: string;
	}) => ({
		message: `[machine-auth] no saved session at ${filePath}. Run \`epicenter auth login\` against ${baseURL} first.`,
		filePath,
		baseURL,
	}),
});
export type MachineAuthStorageError = InferErrors<
	typeof MachineAuthStorageError
>;

/**
 * Read the persisted auth cell at `filePath`. Private to this module: the
 * orchestration functions below resolve the path and call through to here.
 *
 * - Missing file -> `Ok(null)` (signed-out).
 * - Corrupt JSON or shape mismatch -> log warning, `Ok(null)`.
 * - Permissions wider than 0o600 on a regular file -> refuse with a clear
 *   chmod hint.
 */
async function loadMachineTokens({
	filePath,
	log,
}: {
	filePath: string;
	log: Logger;
}): Promise<Result<PersistedAuth | null, MachineAuthStorageError>> {
	const stat = await tryAsync({
		try: () => fs.stat(filePath),
		catch: (cause) => MachineAuthStorageError.StorageFailed({ cause }),
	});
	if (stat.error) {
		const cause = stat.error.cause as NodeJS.ErrnoException | undefined;
		if (cause?.code === 'ENOENT') return Ok(null);
		return Err(stat.error);
	}
	if (process.platform !== 'win32') {
		const mode = stat.data.mode & 0o777;
		if ((mode & 0o077) !== 0) {
			return Err(
				MachineAuthStorageError.PermissionsTooOpen({ filePath, mode }).error,
			);
		}
	}

	const read = await tryAsync({
		try: () => fs.readFile(filePath, 'utf-8'),
		catch: (cause) => MachineAuthStorageError.StorageFailed({ cause }),
	});
	if (read.error) return Err(read.error);

	try {
		return Ok(PersistedAuth.assert(JSON.parse(read.data)));
	} catch (cause) {
		log.warn(
			MachineAuthStorageError.StorageFailed({
				cause: new Error(
					`Discarding corrupted ${filePath}: ${extractErrorMessage(cause)}`,
					{ cause },
				),
			}),
		);
		return Ok(null);
	}
}

/**
 * Write or remove the persisted auth cell. Atomic via `.tmp` + rename so a
 * crash mid-write never leaves a half-written file. Private to this module.
 */
async function saveMachineTokens(
	value: PersistedAuth | null,
	{ filePath }: { filePath: string },
): Promise<Result<undefined, MachineAuthStorageError>> {
	return tryAsync({
		try: async (): Promise<undefined> => {
			if (value === null) {
				try {
					await fs.unlink(filePath);
				} catch (cause) {
					const code = (cause as NodeJS.ErrnoException | undefined)?.code;
					if (code !== 'ENOENT') throw cause;
				}
				return undefined;
			}
			await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
			const tmp = `${filePath}.tmp`;
			await fs.writeFile(tmp, serializePersistedAuth(value), {
				mode: 0o600,
			});
			await fs.rename(tmp, filePath);
			return undefined;
		},
		catch: (cause) => MachineAuthStorageError.StorageFailed({ cause }),
	});
}

/**
 * Identity returned to the CLI for display. `identity.user.email` is fetched from
 * `/api/session` and returned by value here so the CLI can print "Signed in as
 * <email>" without a second round-trip. `email` is absent when the machine is
 * offline during `status`.
 */
type MachineIdentity = {
	user: Principal;
};

type CommonConfig = {
	baseURL?: string;
	clientId?: string;
	filePath?: string;
	fetch?: AuthFetch;
	log?: Logger;
	now?: () => number;
};

type LoginWithOobConfig = CommonConfig & {
	/**
	 * Optional OOB callback override for tests and local trusted-client fixtures.
	 * Production login uses the callback derived from `baseURL`.
	 */
	redirectUri?: string;
	/**
	 * Output sink for the authorize URL and paste prompt. Defaults to stdout;
	 * tests pass a collector.
	 */
	print?: (line: string) => void;
	/**
	 * Best-effort browser opener used by the OOB launcher.
	 */
	openBrowser?: (url: string) => Promise<void> | void;
	/**
	 * Reads the one-time code pasted from the hosted CLI callback page.
	 */
	readCode?: () => Promise<string>;
};

type LoginWithOobResult = { identity: MachineIdentity };

type StatusResult =
	| { status: 'signedOut' }
	| { status: 'valid'; identity: MachineIdentity }
	| { status: 'unverified'; identity: MachineIdentity };

type LogoutResult = { status: 'signedOut' } | { status: 'loggedOut' };

/**
 * Run the OOB OAuth dance, call `/api/session` for the local workspace identity,
 * persist `PersistedAuth`, and return the identity for the CLI to display.
 */
export async function loginWithOob({
	baseURL = EPICENTER_API_URL,
	clientId = EPICENTER_CLI_OAUTH_CLIENT_ID,
	redirectUri,
	filePath,
	fetch = globalThis.fetch.bind(globalThis),
	now = Date.now,
	print,
	openBrowser,
	readCode,
}: LoginWithOobConfig = {}): Promise<
	Result<LoginWithOobResult, MachineAuthRequestError | MachineAuthStorageError>
> {
	const authFilePath = filePath ?? machineAuthFilePath({ baseURL });
	// Passing `undefined` engages the launcher's own destructuring defaults.
	const launcher = createOobOAuthLauncher({
		baseURL,
		clientId,
		fetch,
		now,
		redirectUri,
		print,
		openBrowser,
		readCode,
	});

	const grantResult = await launcher.startSignIn();
	if (grantResult.error) {
		return Err(
			MachineAuthRequestError.RequestFailed({ cause: grantResult.error }).error,
		);
	}
	const launchResult = grantResult.data;
	if (launchResult.status !== 'completed') {
		return Err(
			MachineAuthRequestError.RequestFailed({
				cause: {
					message: 'OOB launcher returned no grant.',
					launchStatus: launchResult.status,
				},
			}).error,
		);
	}
	const grant = launchResult.grant;

	const { data: session, error: sessionError } = await readApiSession({
		baseURL,
		fetch,
		token: grant.accessToken,
	});
	if (sessionError) {
		return Err(
			MachineAuthRequestError.RequestFailed({ cause: sessionError }).error,
		);
	}

	const cell = {
		grant,
		principalId: session.principalId,
	} satisfies PersistedAuth;
	const saved = await saveMachineTokens(cell, { filePath: authFilePath });
	if (saved.error) return Err(saved.error);

	return Ok({
		identity: {
			user: { id: session.principalId, email: session.email },
		},
	});
}

/**
 * Load the persisted cell and verify it by hitting `/api/session` through a
 * regular `createOAuthAppAuth` client (so refresh-on-401 fires automatically
 * and the same-principal guard wipes the cell on mismatch). Returns `unverified`
 * on network failures so the CLI can still report the cached identity.
 */
export async function status({
	baseURL = EPICENTER_API_URL,
	clientId = EPICENTER_CLI_OAUTH_CLIENT_ID,
	filePath,
	fetch = globalThis.fetch.bind(globalThis),
	log = createLogger('machine-auth'),
	now = Date.now,
}: CommonConfig = {}): Promise<
	Result<StatusResult, MachineAuthStorageError | MachineAuthRequestError>
> {
	const authFilePath = filePath ?? machineAuthFilePath({ baseURL });
	const loaded = await loadMachineTokens({
		filePath: authFilePath,
		log,
	});
	if (loaded.error) return Err(loaded.error);
	if (!loaded.data) return Ok({ status: 'signedOut' as const });
	const cachedCell = loaded.data;

	// Cell may still be valid for local use when the server is unreachable;
	// the underlying auth client wipes it on same-principal mismatch or
	// reauth-required. Email is unknown without /api/session.
	const unverifiedFromCache = {
		status: 'unverified' as const,
		identity: {
			user: { id: cachedCell.principalId },
		},
	};

	const clientResult = await createMachineAuthClient({
		baseURL,
		clientId,
		filePath: authFilePath,
		fetch,
		log,
		now,
	});
	if (clientResult.error) return Err(clientResult.error);
	const client = clientResult.data;

	// `client.fetch` owns the Authorization header (refresh-on-401 fires inside
	// it), so the token readApiSession is given is overwritten before the wire.
	const { data: session, error: sessionError } = await readApiSession({
		baseURL,
		fetch: client.fetch,
		token: '',
	});
	if (sessionError) {
		// A malformed 200 body is a real fault worth surfacing; every other
		// failure (unreachable, rejected, unexpected status) reads as unverified
		// so the CLI can still print the cached identity.
		if (sessionError.name === 'Malformed') {
			return Err(
				MachineAuthRequestError.RequestFailed({ cause: sessionError }).error,
			);
		}
		return Ok(unverifiedFromCache);
	}
	return Ok({
		status: 'valid' as const,
		identity: {
			user: { id: session.principalId, email: session.email },
		},
	});
}

/**
 * Revoke the persisted refresh token (best effort) and delete the file.
 * Uses `auth.signOut`, which calls `/auth/oauth2/revoke` and then
 * `persistedAuthStorage.set(null)`; revoke failures are swallowed inside
 * `createOAuthAppAuth` so the file is always cleared.
 */
export async function logout({
	baseURL = EPICENTER_API_URL,
	clientId = EPICENTER_CLI_OAUTH_CLIENT_ID,
	filePath,
	fetch = globalThis.fetch.bind(globalThis),
	log = createLogger('machine-auth'),
	now = Date.now,
}: CommonConfig = {}): Promise<
	Result<LogoutResult, MachineAuthStorageError | MachineAuthRequestError>
> {
	const authFilePath = filePath ?? machineAuthFilePath({ baseURL });
	const loaded = await loadMachineTokens({
		filePath: authFilePath,
		log,
	});
	if (loaded.error) return Err(loaded.error);
	if (!loaded.data) return Ok({ status: 'signedOut' as const });

	const clientResult = await createMachineAuthClient({
		baseURL,
		clientId,
		filePath: authFilePath,
		fetch,
		log,
		now,
	});
	if (clientResult.error) return Err(clientResult.error);
	await clientResult.data.signOut();
	return Ok({ status: 'loggedOut' as const });
}

/**
 * Load the persisted cell and construct a `SyncAuthClient` over it. Daemons
 * call this on boot; they never spawn an interactive sign-in launcher.
 *
 * Returns a typed `Result`. `NoSavedSession` means the user must run
 * `epicenter auth login`; `StorageFailed` / `PermissionsTooOpen` indicate
 * an on-disk fault.
 */
export async function createMachineAuthClient({
	baseURL = EPICENTER_API_URL,
	clientId = EPICENTER_CLI_OAUTH_CLIENT_ID,
	filePath,
	fetch = globalThis.fetch.bind(globalThis),
	log = createLogger('machine-auth'),
	now = Date.now,
}: CommonConfig = {}): Promise<
	Result<SyncAuthClient, MachineAuthStorageError>
> {
	const authFilePath = filePath ?? machineAuthFilePath({ baseURL });
	const loaded = await loadMachineTokens({
		filePath: authFilePath,
		log,
	});
	if (loaded.error) return Err(loaded.error);
	if (!loaded.data) {
		return Err(
			MachineAuthStorageError.NoSavedSession({
				filePath: authFilePath,
				baseURL,
			}).error,
		);
	}
	return Ok(
		createOAuthAppAuth({
			baseURL,
			clientId,
			launcher: {
				// Daemons never sign in interactively; a human must run
				// `epicenter auth login` to refresh the persisted cell.
				startSignIn: async () =>
					Err(
						new Error(
							'Machine auth clients cannot start interactive sign-in. Run `epicenter auth login` first.',
						),
					),
			},
			persistedAuthStorage: {
				initial: loaded.data,
				set: async (next) => {
					const saved = await saveMachineTokens(next, {
						filePath: authFilePath,
					});
					if (saved.error) throw saved.error;
				},
			},
			fetch,
			// Forward the caller's log sink so the long-lived client's background
			// refresh failures land in it, not a default logger. This is the
			// noisiest, most operationally important path for a Node process.
			log,
			now,
		}),
	);
}
