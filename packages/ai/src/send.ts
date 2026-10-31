/**
 * One request over an AI connection, and the key it carries (ADR-0557).
 *
 * A connection is named by its id. The endpoint and key of an
 * `openai-compatible` connection live in this computer's keychain under that
 * id, written and read only by the `epicenter` CLI, so nothing synced can
 * send a key somewhere new.
 *
 * The same command carries account requests: an `account` target names one
 * of the deployment's resources (ADR-0549), and `epicenter send` adds the
 * signed-in account's access token for it, so its caller holds none
 * (ADR-0556).
 *
 * Everything here is shared by the two ways a request leaves:
 *
 * - `epicenter send` reads its stdin with {@link decodeSendInput}, sends
 *   with {@link sendRequest} over the keychain, and prints
 *   {@link responseEvents} as NDJSON. A program that runs it reads the lines
 *   back into a `Response` with {@link createResponseReader}.
 * - A browser tab has no keychain; it keeps its key in the page's storage
 *   and sends with {@link sendToEndpoint} over its own `fetch`.
 *
 * This module imports nothing but `wellcrafted`, so the compiled CLI carries
 * no UI code.
 */

import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';

/**
 * What a connection sends to: an endpoint that speaks the OpenAI wire, the
 * Epicenter deployment's API origin plus `/v1` (ADR-0326), or this
 * computer's local transcription model, which sends nothing.
 */
export const CONNECTION_KINDS = [
	'openai-compatible',
	'epicenter',
	'local',
] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

const CONNECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A connection id is its keychain name: letters, digits, `.`, `_`, and `-`. */
export function isConnectionId(value: unknown): value is string {
	return typeof value === 'string' && CONNECTION_ID.test(value);
}

/**
 * One spelling for an endpoint, so two that name the same one compare
 * equal: an absolute HTTP or HTTPS URL with no user name, password, query,
 * or fragment, its host lowercased, a default port dropped, and trailing
 * slashes removed from the path.
 */
export function canonicalEndpoint(text: string): Result<string, string> {
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

/**
 * The deployment's resources an account request may carry a token for, by
 * role: `api` for profile and usage reads, `git` for Git and the folder
 * connect call (ADR-0549). The deployment maps each to its audience.
 */
export const ACCOUNT_AUDIENCES = ['api', 'git'] as const;
export type AccountAudience = (typeof ACCOUNT_AUDIENCES)[number];

/**
 * Account paths at the deployment: `/api/*` for both resources, API-bound
 * `/v1/*` inference, and API-bound `GET` userinfo. The rest of `/auth/*`,
 * token revocation included, stays out of reach.
 */
const ACCOUNT_PATH_PREFIX = '/api/';
const INFERENCE_PATH_PREFIX = '/v1/';
const USERINFO_PATH = '/auth/oauth2/userinfo';

/** Whether an account request may go to `url`. */
function isAccountPath(
	url: string,
	method: string,
	audience: AccountAudience,
): boolean {
	const { pathname } = new URL(url);
	return (
		pathname.startsWith(ACCOUNT_PATH_PREFIX) ||
		(audience === 'api' &&
			(pathname.startsWith(INFERENCE_PATH_PREFIX) ||
				(pathname === USERINFO_PATH && method.toUpperCase() === 'GET')))
	);
}

/**
 * Where a request goes. An `openai-compatible` target names the endpoint
 * the request was prepared for; it is sent only while the keychain entry
 * still holds that endpoint, and always to the entry's own. An `account`
 * target is one of the deployment's resources (ADR-0549), named by role,
 * and sends with the signed-in account's access token for it.
 */
export type SendTarget =
	| {
			readonly kind: 'openai-compatible';
			readonly connection: string;
			readonly endpoint: string;
	  }
	| { readonly kind: 'epicenter'; readonly connection: string }
	| { readonly kind: 'local'; readonly connection: string }
	| {
			readonly kind: 'account';
			readonly audience: AccountAudience;
			/** Required for the desktop grant; the terminal's device grant needs none. */
			readonly generation?: string;
	  };

/** An OpenAI-compatible request, relative to its connection's endpoint. */
export type SendRequest = {
	readonly method: string;
	/** Below the endpoint, such as `audio/transcriptions`; never a URL. */
	readonly path: string;
	readonly headers: readonly (readonly [string, string])[];
	readonly body?: Uint8Array;
};

/** One keychain entry: the endpoint a key was saved for, and the key, empty for a keyless endpoint. */
export type KeyEntry = { readonly endpoint: string; readonly key: string };

/** What a page may learn of a keychain entry: never the key. */
export type KeyState =
	| { readonly state: 'missing' }
	| {
			readonly state: 'saved';
			readonly endpoint: string;
			readonly hasKey: boolean;
	  };

export const SendError = defineErrors({
	/** The request or the stdin that carried it does not read. Nothing was sent. */
	InvalidRequest: ({ reason }: { reason: string }) => ({
		message: `The request cannot be sent: ${reason}`,
		reason,
	}),
	/** This computer holds no endpoint for the connection. Nothing was sent. */
	NoKey: ({ connection }: { connection: string }) => ({
		message: `No endpoint or key is saved on this computer for the connection '${connection}'. Add your key on this computer.`,
		connection,
	}),
	/** The keychain entry names another endpoint than the request was prepared for. Nothing was sent. */
	EndpointChanged: ({
		connection,
		expected,
		saved,
	}: {
		connection: string;
		expected: string;
		saved: string;
	}) => ({
		message: `The request was prepared for ${expected}, but the key for '${connection}' on this computer is saved for ${saved}, so nothing was sent.`,
		connection,
		expected,
		saved,
	}),
	/**
	 * An Epicenter connection sends with the account's access token, and none
	 * could be had: no sign-in, a sign-in that ended, or a server that could
	 * not be reached. Nothing was sent.
	 */
	NoAccessToken: ({
		connection,
		reason,
	}: {
		connection: string;
		reason: string;
	}) => ({
		message: `The Epicenter connection '${connection}' cannot send requests: ${reason}`,
		connection,
		reason,
	}),
	/**
	 * An account request sends with the account's access token for its
	 * resource, and none could be had: no sign-in, a sign-in that ended, or a
	 * server that could not be reached. Nothing was sent.
	 */
	NoAccountToken: ({
		audience,
		reason,
	}: {
		audience: AccountAudience;
		reason: string;
	}) => ({
		message: `The Epicenter account cannot send requests to its ${audience} resource: ${reason}`,
		audience,
		reason,
	}),
	GrantChanged: () => ({
		message:
			'The Epicenter sign-in changed. Open a new Account before sending.',
	}),
	/** A local connection runs this computer's model and sends no request. */
	LocalNotSent: ({ connection }: { connection: string }) => ({
		message: `The connection '${connection}' runs on this computer and sends no request.`,
		connection,
	}),
	/** The keychain could not be read or written. */
	KeychainUnavailable: ({ reason }: { reason: string }) => ({
		message: `This computer's keychain could not be used: ${reason}`,
		reason,
	}),
	/** The keychain entry is not one this module wrote. */
	EntryUnreadable: ({ connection }: { connection: string }) => ({
		message: `The keychain entry for '${connection}' does not read. Save its endpoint and key again.`,
		connection,
	}),
	/** The request may have left; no response came back. */
	Unreachable: ({ url, reason }: { url: string; reason: string }) => ({
		message: `${url} could not be reached: ${reason}`,
		url,
		reason,
	}),
	/** The response started and its body stopped before the end. */
	ResponseFailed: ({ reason }: { reason: string }) => ({
		message: `The response stopped before it ended: ${reason}`,
		reason,
	}),
});
export type SendError = InferErrors<typeof SendError>;

/**
 * Where keychain entries are kept, by connection id. The CLI binds
 * `Bun.secrets`; tests bind {@link createMemorySecrets}. A method may
 * throw; the functions below report that as `KeychainUnavailable`.
 */
export type SecretStore = {
	get(name: string): Promise<string | null>;
	set(name: string, value: string): Promise<void>;
	delete(name: string): Promise<boolean>;
};

/** A store that forgets everything with its process, seeded with `entries` by connection id. */
export function createMemorySecrets(
	entries: Readonly<Record<string, KeyEntry>> = {},
): SecretStore {
	const values = new Map(
		Object.entries(entries).map(([name, entry]) => [
			name,
			JSON.stringify(entry),
		]),
	);
	return {
		async get(name) {
			return values.get(name) ?? null;
		},
		async set(name, value) {
			values.set(name, value);
		},
		async delete(name) {
			return values.delete(name);
		},
	};
}

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

async function keychain<T>(
	operation: () => Promise<T>,
): Promise<Result<T, SendError>> {
	try {
		return Ok(await operation());
	} catch (cause) {
		return SendError.KeychainUnavailable({ reason: describe(cause) });
	}
}

function refuseId(connection: unknown) {
	return SendError.InvalidRequest({
		reason: `'${String(connection)}' is not a connection id: use letters, digits, '.', '_', and '-'`,
	});
}

/** The entry saved for `connection`, or undefined when there is none. */
export async function readKeyEntry(
	secrets: SecretStore,
	connection: string,
): Promise<Result<KeyEntry | undefined, SendError>> {
	if (!isConnectionId(connection)) return refuseId(connection);
	const { data: text, error } = await keychain(() => secrets.get(connection));
	if (error !== null) return Err(error);
	if (text === null) return Ok(undefined);
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return SendError.EntryUnreadable({ connection });
	}
	const { endpoint, key } = (value ?? {}) as Record<string, unknown>;
	if (typeof endpoint !== 'string' || typeof key !== 'string')
		return SendError.EntryUnreadable({ connection });
	const { data: canonical, error: endpointError } = canonicalEndpoint(endpoint);
	if (endpointError !== null || canonical !== endpoint)
		return SendError.EntryUnreadable({ connection });
	return Ok({ endpoint, key });
}

function stateOf(entry: KeyEntry | undefined): KeyState {
	return entry === undefined
		? { state: 'missing' }
		: { state: 'saved', endpoint: entry.endpoint, hasKey: entry.key !== '' };
}

/** Whether a key is saved for `connection`, and for which endpoint. Never the key. */
export async function keyState(
	secrets: SecretStore,
	connection: string,
): Promise<Result<KeyState, SendError>> {
	const { data: entry, error } = await readKeyEntry(secrets, connection);
	if (error !== null) return Err(error);
	return Ok(stateOf(entry));
}

/**
 * Save `endpoint` and `key` for `connection`, replacing what was saved. An
 * empty key confirms a keyless endpoint, so a request still goes only where
 * a person on this computer said.
 */
export async function saveKey(
	secrets: SecretStore,
	connection: string,
	input: unknown,
): Promise<Result<KeyState, SendError>> {
	if (!isConnectionId(connection)) return refuseId(connection);
	const { endpoint, key } = (
		typeof input === 'object' && input !== null ? input : {}
	) as Record<string, unknown>;
	if (
		typeof endpoint !== 'string' ||
		(key !== undefined && typeof key !== 'string')
	)
		return SendError.InvalidRequest({
			reason:
				'stdin must be one JSON object: {"endpoint": "<url>", "key": "<key>"}',
		});
	const { data: canonical, error: endpointError } = canonicalEndpoint(endpoint);
	if (endpointError !== null)
		return SendError.InvalidRequest({ reason: endpointError });
	const entry: KeyEntry = { endpoint: canonical, key: (key ?? '').trim() };
	const { error } = await keychain(() =>
		secrets.set(connection, JSON.stringify(entry)),
	);
	if (error !== null) return Err(error);
	return Ok(stateOf(entry));
}

/** Remove what is saved for `connection`; whether there was anything. */
export async function removeKey(
	secrets: SecretStore,
	connection: string,
): Promise<Result<{ removed: boolean }, SendError>> {
	if (!isConnectionId(connection)) return refuseId(connection);
	const { data: removed, error } = await keychain(() =>
		secrets.delete(connection),
	);
	if (error !== null) return Err(error);
	return Ok({ removed });
}

/** Headers a caller may not set: the key is added here, and nothing ambient is carried. */
const REFUSED_HEADERS = new Set([
	'authorization',
	'cookie',
	'host',
	'content-length',
	'proxy-authorization',
]);

/** The URL `request` goes to below `endpoint`, or why it may not. */
export function requestUrl(
	endpoint: string,
	path: string,
): Result<string, SendError> {
	const relative = path.replace(/^\/+/, '');
	if (
		relative === '' ||
		relative.includes('#') ||
		relative.includes('\\') ||
		relative.split(/[/?]/)[0] === '..' ||
		(relative.split('?')[0] ?? '')
			.split('/')
			.some((segment) => segment === '..' || segment === '.')
	)
		return SendError.InvalidRequest({
			reason: `'${path}' is not a path below the endpoint`,
		});
	const url = new URL(`${endpoint}/${relative}`);
	if (!url.href.startsWith(`${endpoint}/`))
		return SendError.InvalidRequest({
			reason: `'${path}' is not a path below the endpoint`,
		});
	return Ok(url.href);
}

/**
 * Send `request` to `endpoint` with `key`, as a browser tab does with the
 * key in its own storage, and as {@link sendRequest} does with the
 * keychain's entry. A redirect is refused, not followed, so the key is
 * never carried to another URL; no cookie is sent.
 */
export async function sendToEndpoint(
	{ endpoint, key }: KeyEntry,
	request: SendRequest,
	{
		fetch: send = globalThis.fetch.bind(globalThis),
		signal,
	}: { fetch?: typeof globalThis.fetch; signal?: AbortSignal } = {},
): Promise<Result<Response, SendError>> {
	const { data: url, error: urlError } = requestUrl(endpoint, request.path);
	if (urlError !== null) return Err(urlError);
	const headers = new Headers();
	for (const [name, value] of request.headers)
		if (!REFUSED_HEADERS.has(name.toLowerCase())) headers.append(name, value);
	if (key !== '') headers.set('authorization', `Bearer ${key}`);
	try {
		return Ok(
			await send(url, {
				method: request.method,
				headers,
				body: request.body as Uint8Array<ArrayBuffer> | undefined,
				redirect: 'error',
				credentials: 'omit',
				signal,
			}),
		);
	} catch (cause) {
		// An endpoint that echoes the key must not carry it into a message.
		const reason = describe(cause);
		return SendError.Unreachable({
			url,
			reason: key === '' ? reason : reason.split(key).join('[key removed]'),
		});
	}
}

/**
 * Where an Epicenter connection sends: the deployment's API origin plus
 * `/v1`, and the access token `epicenter send` reads for it, or why there is
 * none.
 */
export type EpicenterAccess = () => Promise<Result<KeyEntry, string>>;

/**
 * Where an account request sends: the deployment's origin, and an access
 * token for `audience` that `epicenter send` reads, or why there is none.
 */
export type AccountAccess = (
	audience: AccountAudience,
	generation?: string,
) => Promise<Result<KeyEntry, { name: string; message: string }>>;

/**
 * Send an account request to the deployment's origin with `access`'s token.
 * Only an account path (`isAccountPath`) is sent, checked after the URL is
 * resolved, so an encoded dot segment cannot climb out of it.
 */
async function sendToAccount(
	audience: AccountAudience,
	generation: string | undefined,
	request: SendRequest,
	access: AccountAccess | undefined,
	options: { fetch?: typeof globalThis.fetch; signal?: AbortSignal },
): Promise<Result<Response, SendError>> {
	const refusePath = SendError.InvalidRequest({
		reason: `'${request.path}' is not an account path for ${audience}: use ${ACCOUNT_PATH_PREFIX}, API-bound ${INFERENCE_PATH_PREFIX}, or API-bound GET ${USERINFO_PATH}`,
	});
	// Checked before any token is minted, against a stand-in origin.
	const { data: probe, error: probeError } = requestUrl(
		'https://deployment.invalid',
		request.path,
	);
	if (probeError !== null) return Err(probeError);
	if (!isAccountPath(probe, request.method, audience)) return refusePath;
	if (!access)
		return SendError.NoAccountToken({
			audience,
			reason: 'nothing here signs in to Epicenter',
		});
	const { data: entry, error } = await access(audience, generation);
	if (error !== null)
		return error.name === 'GrantChanged'
			? SendError.GrantChanged()
			: SendError.NoAccountToken({ audience, reason: error.message });
	const { data: url, error: urlError } = requestUrl(
		entry.endpoint,
		request.path,
	);
	if (urlError !== null) return Err(urlError);
	if (!isAccountPath(url, request.method, audience)) return refusePath;
	return sendToEndpoint(entry, request, options);
}

/**
 * Send `request` over `target` with the key saved on this computer: the
 * CLI's `send`. An Epicenter connection sends with what `epicenter` gives,
 * an account request with what `account` gives, a local connection sends
 * nothing, and an `openai-compatible` one is sent only while its keychain
 * entry still holds the endpoint the request was prepared for.
 */
export async function sendRequest({
	target,
	request,
	secrets,
	epicenter,
	account,
	fetch,
	signal,
}: {
	target: SendTarget;
	request: SendRequest;
	secrets: SecretStore;
	/** Absent where nothing signs in, which refuses an Epicenter connection. */
	epicenter?: EpicenterAccess;
	/** Absent where nothing signs in, which refuses an account request. */
	account?: AccountAccess;
	fetch?: typeof globalThis.fetch;
	signal?: AbortSignal;
}): Promise<Result<Response, SendError>> {
	if (target.kind === 'account')
		return sendToAccount(target.audience, target.generation, request, account, {
			fetch,
			signal,
		});
	if (!isConnectionId(target.connection)) return refuseId(target.connection);
	switch (target.kind) {
		case 'epicenter': {
			if (!epicenter)
				return SendError.NoAccessToken({
					connection: target.connection,
					reason: 'nothing here signs in to Epicenter',
				});
			const { data: access, error } = await epicenter();
			if (error !== null)
				return SendError.NoAccessToken({
					connection: target.connection,
					reason: error,
				});
			return sendToEndpoint(access, request, { fetch, signal });
		}
		case 'local':
			return SendError.LocalNotSent({ connection: target.connection });
	}
	const { data: expected, error: endpointError } = canonicalEndpoint(
		target.endpoint,
	);
	if (endpointError !== null)
		return SendError.InvalidRequest({ reason: endpointError });
	const { data: entry, error } = await readKeyEntry(secrets, target.connection);
	if (error !== null) return Err(error);
	if (entry === undefined)
		return SendError.NoKey({ connection: target.connection });
	if (entry.endpoint !== expected)
		return SendError.EndpointChanged({
			connection: target.connection,
			expected,
			saved: entry.endpoint,
		});
	return sendToEndpoint(entry, request, { fetch, signal });
}

/**
 * A request as a page's `fetch` call states it, relative to `endpoint`:
 * the desktop page's fetch-shaped shim over `ai_send`. A URL that is not
 * below `endpoint` is refused, so a shim never retargets a request.
 */
export async function toSendRequest(
	endpoint: string,
	input: string | URL | Request,
	init?: RequestInit,
): Promise<Result<SendRequest, SendError>> {
	const request = new Request(input, init);
	if (!request.url.startsWith(`${endpoint}/`))
		return SendError.InvalidRequest({
			reason: `${request.url} is not below the endpoint ${endpoint}`,
		});
	const headers = new Headers(request.headers);
	let body: Uint8Array | undefined;
	if (request.body) {
		// A FormData body's boundary is in the blob's type; not every runtime
		// puts it in the request's headers.
		const blob = await request.blob();
		if (blob.type && !headers.has('content-type'))
			headers.set('content-type', blob.type);
		body = new Uint8Array(await blob.arrayBuffer());
	}
	return Ok({
		method: request.method,
		path: request.url.slice(endpoint.length + 1),
		headers: [...headers],
		...(body && { body }),
	});
}

/**
 * What `epicenter send` reads on stdin: one JSON line, `{ target, request }`
 * with the request's method, path, and headers, then the body's raw bytes to
 * the end. The desktop shell writes the same bytes (`cli.rs`).
 */
export function encodeSendInput(
	target: SendTarget,
	{ body, ...request }: SendRequest,
): Uint8Array {
	const head = new TextEncoder().encode(
		`${JSON.stringify({ target, request })}\n`,
	);
	if (!body) return head;
	const bytes = new Uint8Array(head.length + body.length);
	bytes.set(head);
	bytes.set(body, head.length);
	return bytes;
}

const isPair = (value: unknown): value is [string, string] =>
	Array.isArray(value) &&
	value.length === 2 &&
	typeof value[0] === 'string' &&
	typeof value[1] === 'string';

function readTarget(value: unknown): SendTarget | undefined {
	if (typeof value !== 'object' || value === null) return undefined;
	const { kind, connection, endpoint, audience, generation } = value as Record<
		string,
		unknown
	>;
	if (kind === 'account')
		return ACCOUNT_AUDIENCES.includes(audience as AccountAudience) &&
			(generation === undefined ||
				(typeof generation === 'string' &&
					/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
						generation,
					)))
			? {
					kind,
					audience: audience as AccountAudience,
					...(generation !== undefined && { generation: generation as string }),
				}
			: undefined;
	if (typeof connection !== 'string') return undefined;
	if (kind === 'openai-compatible')
		return typeof endpoint === 'string'
			? { kind, connection, endpoint }
			: undefined;
	if (kind === 'epicenter' || kind === 'local') return { kind, connection };
	return undefined;
}

/** Read what {@link encodeSendInput} wrote. */
export function decodeSendInput(
	bytes: Uint8Array,
): Result<{ target: SendTarget; request: SendRequest }, SendError> {
	const newline = bytes.indexOf(10);
	const invalid = SendError.InvalidRequest({
		reason:
			'stdin must start with one JSON line, {"target": {...}, "request": {"method", "path", "headers"}}, followed by the body',
	});
	if (newline === -1) return invalid;
	let head: unknown;
	try {
		head = JSON.parse(new TextDecoder().decode(bytes.subarray(0, newline)));
	} catch {
		return invalid;
	}
	const { target: rawTarget, request } = (head ?? {}) as Record<
		string,
		unknown
	>;
	const target = readTarget(rawTarget);
	const { method, path, headers } = (request ?? {}) as Record<string, unknown>;
	if (
		target === undefined ||
		typeof method !== 'string' ||
		typeof path !== 'string' ||
		!Array.isArray(headers) ||
		!headers.every(isPair)
	)
		return invalid;
	const body = bytes.subarray(newline + 1);
	return Ok({
		target,
		request: {
			method,
			path,
			headers,
			...(body.length > 0 && { body }),
		},
	});
}

/**
 * One line of `epicenter send`'s output. A response is a `head`, its body as
 * `chunk`s of at most {@link SEND_CHUNK_BYTES} in base64, and an `end`; an
 * `error` ends it early, before or after the head.
 */
export type SendEvent =
	| {
			readonly type: 'head';
			readonly status: number;
			readonly statusText: string;
			readonly headers: readonly (readonly [string, string])[];
	  }
	| { readonly type: 'chunk'; readonly data: string }
	| { readonly type: 'end' }
	| { readonly type: 'error'; readonly name: string; readonly message: string };

/** The most body bytes one `chunk` line carries, so no line grows with the response. */
export const SEND_CHUNK_BYTES = 64 * 1024;

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++)
		bytes[index] = binary.charCodeAt(index);
	return bytes;
}

/** `response` as the lines `epicenter send` prints, its body cut into bounded chunks. */
export async function* responseEvents(
	response: Response,
): AsyncGenerator<SendEvent> {
	yield {
		type: 'head',
		status: response.status,
		statusText: response.statusText,
		headers: [...response.headers],
	};
	if (response.body) {
		const reader = response.body.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				for (let offset = 0; offset < value.length; offset += SEND_CHUNK_BYTES)
					yield {
						type: 'chunk',
						data: bytesToBase64(
							value.subarray(offset, offset + SEND_CHUNK_BYTES),
						),
					};
			}
		} catch (cause) {
			const { error } = SendError.ResponseFailed({ reason: describe(cause) });
			yield { type: 'error', name: error.name, message: error.message };
			return;
		} finally {
			reader.releaseLock();
		}
	}
	yield { type: 'end' };
}

/** Why no response came back: the CLI's refusal, or a failure of the run that carried it. */
export type SendFailure = { readonly name: string; readonly message: string };

/**
 * The page's half of {@link responseEvents}: hand it each line as it
 * arrives and `response` resolves at the head, with a body that streams the
 * chunks that follow. A failure before the head resolves `response` to that
 * failure; after it, the body errors with it.
 */
export function createResponseReader(
	onCancel?: () => void,
	onFinish?: () => void,
) {
	const settled = Promise.withResolvers<Result<Response, SendFailure>>();
	let body: ReadableStreamDefaultController<Uint8Array> | undefined;
	let finished = false;
	function finish(): boolean {
		if (finished) return false;
		finished = true;
		onFinish?.();
		return true;
	}
	function cancel() {
		if (!finish()) return;
		onCancel?.();
	}
	function fail(failure: SendFailure) {
		if (!finish()) return;
		if (body) body.error(Object.assign(new Error(failure.message), failure));
		else settled.resolve(Err(failure));
	}
	function push(event: SendEvent) {
		if (finished) return;
		switch (event.type) {
			case 'head': {
				if (body)
					return fail({
						name: 'InvalidResponse',
						message: 'A second head arrived.',
					});
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						body = controller;
					},
					cancel,
				});
				const nullBody = [101, 204, 205, 304].includes(event.status);
				settled.resolve(
					Ok(
						new Response(nullBody ? null : stream, {
							status: event.status,
							statusText: event.statusText,
							headers: event.headers as [string, string][],
						}),
					),
				);
				return;
			}
			case 'chunk':
				if (!body)
					return fail({
						name: 'InvalidResponse',
						message: 'A chunk arrived before the head.',
					});
				body.enqueue(base64ToBytes(event.data));
				return;
			case 'end':
				if (!body)
					return fail({
						name: 'InvalidResponse',
						message: 'The response ended before its head.',
					});
				finish();
				body.close();
				return;
			case 'error':
				return fail({ name: event.name, message: event.message });
		}
	}
	return {
		push,
		fail,
		cancel,
		/** Resolves at the head, or with why none came. */
		response: settled.promise,
	};
}
