/**
 * Resolve the right machine auth client from this node's configuration.
 *
 * Node-side CLI and administrative tools talk to one of two kinds of star, and the credential model
 * differs by kind (the same fork the browser makes off `Instance.token`):
 *
 *   - a HOSTED star authenticates with a managed OAuth grant the user enrolled
 *     via `epicenter auth login`; it persists (refresh token, access token,
 *     expiry) and refreshes itself. That cell is loaded by
 *     {@link createMachineAuthClient}.
 *   - a SELF-HOSTED star authenticates with a static instance bearer token. A
 *     static token has no refresh lifecycle, so its home is configuration, not a
 *     persisted credential store: it is supplied non-interactively through
 *     `EPICENTER_TOKEN` (or `EPICENTER_TOKEN_FILE`) and consumed by
 *     {@link createInstanceTokenAuth}. It is never written to disk.
 *
 * This is the single choke point for Node-side consumers such as
 * `epicenter blobs` and `epicenter tables`, so neither re-implements the fork. The rule: a
 * configured static token wins and selects the instance-token client; otherwise
 * fall back to the persisted OAuth cell.
 *
 * See `specs/20260625T132139-cli-and-headless-credential-seam-for-self-host.md`.
 */

import { readFileSync } from 'node:fs';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Ok, type Result } from 'wellcrafted/result';
import type { AuthFetch, SyncAuthClient } from '../auth-contract.js';
import { createInstanceTokenAuth } from '../instance-token-auth.js';
import {
	createMachineAuthClient,
	type MachineAuthStorageError,
} from './machine-auth.js';

export type ResolveMachineAuthClientConfig = {
	/**
	 * The star's origin. Defaults to {@link EPICENTER_API_URL} (which honors
	 * `EPICENTER_API_URL`), so a self-host node sets that env var to its box.
	 */
	baseURL?: string;
	/**
	 * An explicit static instance token. Defaults to the configured token
	 * ({@link readConfiguredToken}: `EPICENTER_TOKEN`, then `EPICENTER_TOKEN_FILE`).
	 * Present here so callers and tests can supply a token directly without the
	 * environment. Whatever its source, a static token is never persisted.
	 */
	token?: string;
	/**
	 * Override the persisted OAuth cell path. Tests pass it; production resolves
	 * it from the API target. Only consulted on the OAuth (no-token) path.
	 */
	filePath?: string;
	/** Fetch implementation. Defaults to the bound global `fetch`. */
	fetch?: AuthFetch;
	/** Library logger. */
	log?: Logger;
	/** Clock seam for the OAuth client's refresh-skew math. */
	now?: () => number;
};

/**
 * Pick and construct the machine auth client for this node.
 *
 * A configured static token yields a {@link createInstanceTokenAuth} client, which
 * boots optimistically signed-in as the instance principal (local-first, like the
 * OAuth client's cached cell). Its first `/api/session` confirmation is awaited so
 * the returned client reports a settled result: the await only rewrites `state`
 * when the token is rejected (drops to signed-out); an offline star leaves it
 * signed-in and cloud sync retries in the background. Callers such as `blobs`
 * read `auth.state` synchronously right after this call.
 *
 * With no configured token, this is exactly {@link createMachineAuthClient}: the
 * persisted OAuth cell, including its `NoSavedSession` arm (which callers map to
 * a signed-out Node client).
 */
export async function resolveMachineAuthClient({
	baseURL = EPICENTER_API_URL,
	token,
	filePath,
	fetch = globalThis.fetch.bind(globalThis),
	log = createLogger('machine-auth'),
	now = Date.now,
}: ResolveMachineAuthClientConfig = {}): Promise<
	Result<SyncAuthClient, MachineAuthStorageError>
> {
	const configuredToken = token ?? readConfiguredToken({ log });
	if (configuredToken) {
		const client = createInstanceTokenAuth({
			baseURL,
			token: configuredToken,
			fetch,
			log,
		});
		// Await the first confirmation so the caller reads a settled `state` (settle
		// semantics are in the JSDoc above). A network failure is not fatal: the
		// client can retry, so log it and return the client rather than erroring.
		const { error } = await client.startSignIn();
		if (error) {
			log.debug(
				'Instance token could not be verified against /api/session; the client remains available for retry.',
				{ baseURL, cause: error },
			);
		}
		return Ok(client);
	}
	return createMachineAuthClient({ baseURL, filePath, fetch, log, now });
}

/**
 * The static instance token from this node's environment, or `undefined`.
 *
 * `EPICENTER_TOKEN` (raw) wins; otherwise the trimmed contents of the file at
 * `EPICENTER_TOKEN_FILE` (the `_FILE` convention: keeps the secret out of the
 * process environment, where it would leak via `/proc/<pid>/environ` and `ps`,
 * matching local-books and ADR-0062). An empty value, an unset path, or an
 * unreadable file all read as "no configured token", so the caller falls through
 * to the persisted OAuth cell rather than hard-failing.
 *
 * `env` is injectable so the precedence is unit-testable without mutating
 * `process.env`.
 */
export function readConfiguredToken({
	env = process.env,
	log = createLogger('machine-auth'),
}: {
	env?: NodeJS.ProcessEnv;
	log?: Logger;
} = {}): string | undefined {
	const raw = env.EPICENTER_TOKEN?.trim();
	if (raw) return raw;

	const filePath = env.EPICENTER_TOKEN_FILE?.trim();
	if (!filePath) return undefined;

	try {
		const contents = readFileSync(filePath, 'utf8').trim();
		return contents || undefined;
	} catch (cause) {
		log.debug(
			'EPICENTER_TOKEN_FILE is set but could not be read; falling through to the stored auth cell.',
			{ filePath, cause },
		);
		return undefined;
	}
}
