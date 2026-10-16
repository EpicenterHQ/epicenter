/**
 * AI connections in a browser page (ADR-0581): rows of the origin's own
 * `so.epicenter`, opened in OPFS, with each row's endpoint and key kept in
 * the page's `localStorage` under the row's id. Requests go out through
 * {@link sendRequest}, by the row's kind, exactly as `epicenter send` sends
 * them on the desktop; only the secret store and the account's transport
 * differ.
 */

import { openFolder } from '@epicenter/folder/browser';
import { Ok } from 'wellcrafted/result';
import {
	CONNECTIONS_FOLDER_ID,
	epicenterDefinition,
} from './connection-table.js';
import {
	type SecretStore,
	type SendRequest,
	type SendTarget,
	sendRequest,
	toSendRequest,
} from './send.js';

/** The `localStorage` key a connection's `{ endpoint, key }` is kept under. */
export function secretStorageKey(connection: string) {
	return `so.epicenter.secret.${connection}`;
}

/**
 * The page's `SecretStore`: one `localStorage` entry per connection id.
 * Any script on the origin can read it, which the connection form says
 * before a key is saved.
 */
export function browserSecrets(
	storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
): SecretStore {
	// Read at each call, so a page that never sends with a key never touches it.
	const store = () => storage ?? globalThis.localStorage;
	return {
		async get(name) {
			return store().getItem(secretStorageKey(name));
		},
		async set(name, value) {
			store().setItem(secretStorageKey(name), value);
		},
		async delete(name) {
			const key = secretStorageKey(name);
			const present = store().getItem(key) !== null;
			store().removeItem(key);
			return present;
		},
	};
}

/** Open this origin's `so.epicenter`, seen through its `connections` table. */
export function openBrowserConnections() {
	return openFolder({
		id: CONNECTIONS_FOLDER_ID,
		definition: epicenterDefinition,
		browser: { author: { name: 'Epicenter', email: 'epicenter@localhost' } },
	});
}

/**
 * The signed-in Epicenter account as a browser page holds it: its API
 * origin and a `fetch` that adds its token and refuses every origin but the
 * account's own (`packages/auth/src/browser-oauth.ts`). Only an `epicenter`
 * row sends through it.
 */
export type BrowserAccount = {
	readonly baseURL: string;
	readonly fetch: typeof globalThis.fetch;
};

/**
 * Send `request` over `target` from a browser page, with the page's saved
 * keys and, for an `epicenter` row, the signed-in account. A `local` row is
 * refused: a browser has no local model.
 */
export function sendFromBrowser({
	target,
	request,
	secrets,
	account,
	fetch,
	signal,
}: {
	target: SendTarget;
	request: SendRequest;
	secrets?: SecretStore;
	account?: BrowserAccount | null;
	/** The page's own `fetch`; an `epicenter` row sends over the account's instead. */
	fetch?: typeof globalThis.fetch;
	signal?: AbortSignal;
}) {
	return sendRequest({
		target,
		request,
		secrets: secrets ?? browserSecrets(),
		...(account && {
			epicenter: async () =>
				Ok({
					endpoint: accountEndpoint(account),
					key: '',
					fetch: account.fetch,
				}),
		}),
		fetch,
		signal,
	});
}

/** Where an `epicenter` row sends from a browser: the account's API origin plus `/v1`. */
export function accountEndpoint(account: BrowserAccount) {
	return `${account.baseURL.replace(/\/+$/, '')}/v1`;
}

/**
 * A `fetch` bound to one connection, for a client such as the OpenAI SDK
 * that is pointed at `endpoint`: each call is turned into a request below
 * `endpoint` and sent with {@link sendFromBrowser}. A call that is not
 * below `endpoint`, or that is refused, rejects with the reason.
 */
export function connectionFetch({
	target,
	endpoint,
	secrets,
	account,
	fetch,
}: {
	target: SendTarget;
	endpoint: string;
	secrets?: SecretStore;
	account?: BrowserAccount | null;
	fetch?: typeof globalThis.fetch;
}): typeof globalThis.fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const { data: request, error } = await toSendRequest(endpoint, input, init);
		if (error !== null) throw new Error(error.message);
		const signal =
			init?.signal ?? (input instanceof Request ? input.signal : undefined);
		const { data: response, error: sendError } = await sendFromBrowser({
			target,
			request,
			secrets,
			account,
			fetch,
			signal: signal ?? undefined,
		});
		if (sendError !== null) throw new Error(sendError.message);
		return response;
	}) as typeof globalThis.fetch;
}
