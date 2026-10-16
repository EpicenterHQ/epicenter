/**
 * What the connection editor shares, whichever place keeps a connection's
 * endpoint and key: the row's fields, how each kind is named, a new
 * connection's id, and {@link ConnectionKeys}, the one thing that differs
 * between Epicenter (this computer's keychain, through the `epicenter` CLI)
 * and a browser page (`localStorage`, ADR-0581).
 */

import type { Result } from 'wellcrafted/result';
import { browserSecrets, secretStorageKey } from '../browser-connections.js';

export { connectionId } from '../connection-table.js';

import {
	type ConnectionKind,
	type KeyState,
	keyState,
	removeKey,
	type SecretStore,
	saveKey,
} from '../send.js';

/** A `connections` row's fields, as `so.epicenter`'s declaration reads them. */
export type ConnectionFields = {
	kind: ConnectionKind;
	title: string;
	model: string;
};

export const KIND_LABELS: Record<ConnectionKind, string> = {
	'openai-compatible': 'OpenAI-compatible endpoint',
	epicenter: 'Epicenter account',
	local: 'This computer',
};

/**
 * Where a connection's endpoint and key are kept, and how to reach them. The
 * editor hands a key over and never reads one back: `state` answers with the
 * endpoint and whether a key is saved.
 */
export type ConnectionKeys = {
	/** How the editor names the place, in the sentences it shows. */
	readonly place: 'computer' | 'browser';
	state(connection: string): Promise<Result<KeyState, string>>;
	save(
		connection: string,
		endpoint: string,
		key: string,
	): Promise<Result<unknown, string>>;
	remove(connection: string): Promise<Result<unknown, string>>;
	/**
	 * Calls `listener` when another tab changes a saved key, with `null` when
	 * it cleared them all; returns the unsubscribe.
	 */
	onChange?(listener: (connection: string | null) => void): () => void;
};

/** The query key of what `keys` holds for `connection`. */
export const keyStateKey = (connection: string) =>
	['ai-key-state', connection] as const;

const withMessage = <T>(result: Result<T, { message: string }>) =>
	result.error === null
		? result
		: ({ data: null, error: result.error.message } as Result<T, string>);

/** A browser page's keys: one `localStorage` entry per connection (ADR-0581). */
export function browserKeys(secrets: SecretStore = browserSecrets()) {
	return {
		place: 'browser',
		async state(connection) {
			return withMessage(await keyState(secrets, connection));
		},
		async save(connection, endpoint, key) {
			return withMessage(await saveKey(secrets, connection, { endpoint, key }));
		},
		async remove(connection) {
			return withMessage(await removeKey(secrets, connection));
		},
		onChange(listener) {
			const prefix = secretStorageKey('');
			const changed = (event: StorageEvent) => {
				if (event.key === null) listener(null);
				else if (event.key.startsWith(prefix))
					listener(event.key.slice(prefix.length));
			};
			globalThis.addEventListener('storage', changed);
			return () => globalThis.removeEventListener('storage', changed);
		},
	} satisfies ConnectionKeys;
}
