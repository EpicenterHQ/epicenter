/**
 * Where requests go, and with which key: two private connections, one for
 * transcription and one for text.
 *
 * A connection is a base URL, the model used when a request names none, and
 * an optional API key. Its base URL and key are kept on this device, never in
 * Whispering's folder: inside Epicenter the connection is a row of
 * `so.epicenter` holding the model, with the base URL and key in this
 * computer's keychain, and a browser tab keeps all three in `localStorage`.
 * The folder's files (a recipe's endpoint, `kv.json`) never choose where a
 * request goes or which key it carries. A request names the
 * connection's base URL it was prepared for, and is sent only while the
 * connection still targets exactly that URL, so a change of connection never
 * retargets a request already prepared.
 *
 * A connection is configured on purpose, including a keyless local one. A key
 * is kept only for the destination it was saved for: changing the base URL
 * needs the key replaced or removed in the same change.
 *
 * These rules are pure, so both workspaces apply the same ones to their own
 * storage. Nothing here reads or writes anything.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';

export type Operation = 'transcription' | 'text';
export const OPERATIONS: readonly Operation[] = ['transcription', 'text'];

/** What storage holds for one connection. The key never leaves the storage that holds it. */
export type StoredConnection = {
	/** Canonical: see {@link canonicalBaseUrl}. */
	readonly baseUrl: string;
	readonly model: string;
	/** Absent for a keyless endpoint. Never empty. */
	readonly apiKey?: string;
};

/** What the page is told about a connection. Never the key. */
export type ConnectionInfo = {
	readonly baseUrl: string;
	readonly model: string;
	readonly keyPresent: boolean;
	/** Set when the connection cannot be changed from the app. */
	readonly readOnlyReason: string | undefined;
};

export type ConnectionsInfo = {
	readonly transcription: ConnectionInfo | undefined;
	readonly text: ConnectionInfo | undefined;
	/**
	 * A key saved by an earlier build, which used one key for every endpoint.
	 * It is sent nowhere until the person moves it into a connection.
	 */
	readonly legacyKey: boolean;
};

export type KeyChange =
	| { readonly action: 'keep' }
	| { readonly action: 'replace'; readonly key: string }
	| { readonly action: 'remove' };

export type ConnectionChange = {
	readonly baseUrl: string;
	readonly model: string;
	readonly key: KeyChange;
};

/** Where an unconfigured connection's form starts. Nothing is sent to these until saved. */
export type ConnectionDefaults = Record<
	Operation,
	{ readonly baseUrl: string; readonly model: string }
>;

export const OPERATION_NAMES: Record<Operation, string> = {
	transcription: 'transcription',
	text: 'text',
};

/**
 * One spelling for a base URL, so two that name the same endpoint compare
 * equal and two that do not never do. An absolute HTTP or HTTPS URL with no
 * user name, password, query, or fragment; the host is lowercased, a default
 * port dropped, and trailing slashes removed from the path. Two URLs on the
 * same origin with different paths are different endpoints.
 */
export function canonicalBaseUrl(text: string): Result<string, string> {
	const trimmed = text.trim();
	if (trimmed === '') return Err('The endpoint URL is empty.');
	if (trimmed.includes('?') || trimmed.includes('#'))
		return Err(
			`The endpoint URL ${trimmed} has a query or fragment. Use the base URL only, such as https://api.openai.com/v1.`,
		);
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return Err(
			`${trimmed} is not a URL. Use a base URL such as https://api.openai.com/v1.`,
		);
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:')
		return Err(`The endpoint URL ${trimmed} is not http or https.`);
	if (url.username !== '' || url.password !== '' || /\/\/[^/]*@/.test(trimmed))
		return Err(
			'The endpoint URL contains a user name or password. Put the key in the key field instead.',
		);
	return Ok(`${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`);
}

/** Whether two base URLs name the same endpoint; one that is not a URL names none. */
export function sameBaseUrl(a: string, b: string): boolean {
	const { data: left, error: leftError } = canonicalBaseUrl(a);
	const { data: right, error: rightError } = canonicalBaseUrl(b);
	return leftError === null && rightError === null && left === right;
}

/** A stored connection from untrusted storage, or undefined when it does not read as one. */
export function readStoredConnection(
	value: unknown,
): StoredConnection | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		return undefined;
	const { baseUrl, model, apiKey } = value as Record<string, unknown>;
	if (typeof baseUrl !== 'string' || typeof model !== 'string')
		return undefined;
	const { data: canonical, error: urlError } = canonicalBaseUrl(baseUrl);
	if (urlError !== null || canonical !== baseUrl) return undefined;
	if (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey === ''))
		return undefined;
	return apiKey === undefined ? { baseUrl, model } : { baseUrl, model, apiKey };
}

export function connectionInfo(
	stored: StoredConnection,
	readOnlyReason?: string,
): ConnectionInfo {
	return {
		baseUrl: stored.baseUrl,
		model: stored.model,
		keyPresent: stored.apiKey !== undefined,
		readOnlyReason,
	};
}

/**
 * The connection a change produces from the one stored now, or why it is
 * refused. Keeping a key is allowed only for the same destination: a key is
 * never carried to a base URL it was not saved for.
 */
export function applyConnectionChange(
	operation: Operation,
	current: StoredConnection | undefined,
	change: ConnectionChange,
): Result<StoredConnection, string> {
	const { data: baseUrl, error: urlError } = canonicalBaseUrl(change.baseUrl);
	if (urlError !== null) return Err(urlError);
	const model = change.model.trim();
	if (model === '')
		return Err(
			`The ${OPERATION_NAMES[operation]} connection needs a model: the name its endpoint uses.`,
		);
	let apiKey: string | undefined;
	switch (change.key.action) {
		case 'replace': {
			const key = change.key.key.trim();
			if (key === '')
				return Err('The new key is empty. Type the key, or choose no key.');
			apiKey = key;
			break;
		}
		case 'remove':
			apiKey = undefined;
			break;
		case 'keep':
			apiKey = current?.apiKey;
			if (apiKey !== undefined && current?.baseUrl !== baseUrl)
				return Err(
					`The endpoint changed from ${current?.baseUrl} to ${baseUrl}, so the saved key is not sent there. Enter the key for the new endpoint, or remove the key.`,
				);
			break;
	}
	return Ok(
		apiKey === undefined ? { baseUrl, model } : { baseUrl, model, apiKey },
	);
}

/** Where the earlier key is to go: the destination the person was shown and agreed to. */
export type LegacyKeyTargets = Partial<
	Record<Operation, { readonly baseUrl: string; readonly model: string }>
>;

/**
 * The connections that result from moving the earlier key into the targets
 * the person chose. Each target becomes a connection with that key, so the
 * key goes only to destinations shown to them.
 */
export function adoptLegacyKey(
	key: string,
	targets: LegacyKeyTargets,
	readOnly: Partial<Record<Operation, string>>,
): Result<Partial<Record<Operation, StoredConnection>>, string> {
	if (key === '')
		return Err('No key from an earlier version is saved on this device.');
	const chosen = OPERATIONS.filter((operation) => targets[operation]);
	if (chosen.length === 0)
		return Err('Choose where the earlier key may be sent.');
	const adopted: Partial<Record<Operation, StoredConnection>> = {};
	for (const operation of chosen) {
		const reason = readOnly[operation];
		if (reason !== undefined) return Err(reason);
		const target = targets[operation]!;
		const { data: made, error: changeError } = applyConnectionChange(
			operation,
			undefined,
			{
				baseUrl: target.baseUrl,
				model: target.model,
				key: { action: 'replace', key },
			},
		);
		if (changeError !== null) return Err(changeError);
		adopted[operation] = made;
	}
	return Ok(adopted);
}

/**
 * Whether a request prepared for `expected` may go out over the connection
 * stored now. The request is sent to the stored connection's own URL;
 * `expected` only confirms that it is the one the request was prepared for.
 */
export function connectionTargets(
	stored: StoredConnection,
	expected: string,
): boolean {
	const { data: canonical, error: urlError } = canonicalBaseUrl(expected);
	return urlError === null && canonical === stored.baseUrl;
}
