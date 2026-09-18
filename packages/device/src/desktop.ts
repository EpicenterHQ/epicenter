/// <reference lib="dom" />

/**
 * Native SQLite uses one WebSocket per acquired lifetime. Socket loss retires
 * client handles and lets the host drain and close that connection's resources.
 * Secrets use HTTP and survive SQLite closure.
 */

import type { AccountIdentity } from '@epicenter/principal';
import { Ok, type Result } from 'wellcrafted/result';
import {
	appIdOrThrow,
	type Device,
	DeviceError,
	SecretError,
	type SecretLabel,
	type SecretStore,
} from './index.js';
import {
	type AppSqliteTransport,
	createAppSqlite,
	createTransportSqliteOwner,
} from './owner.js';
import {
	DEVICE_PATH,
	type DeviceRequest,
	type DeviceResponse,
	isDeviceResponse,
	parseSqliteFrame,
	stringifySqliteFrame,
} from './protocol.js';

export type CreateDesktopDeviceOptions = {
	/** The trusted origin that owns the files and the keychain entries. */
	baseURL?: string;
	fetch?: typeof globalThis.fetch;
	webSocket?: typeof globalThis.WebSocket;
};

export function createDesktopSqliteOwner(
	options: CreateDesktopDeviceOptions = {},
): import('./owner.js').DeviceSqliteOwner {
	return {
		async acquire(appId, account) {
			const socket = createSqliteSocket(options);
			try {
				const lifetime = await createTransportSqliteOwner(
					socket.request,
				).acquire(appId, account);
				let closing: Promise<void> | undefined;
				return {
					open: lifetime.open,
					delete: lifetime.delete,
					close() {
						return (closing ??= lifetime.close().finally(() => socket.close()));
					},
				};
			} catch (cause) {
				socket.close();
				throw cause;
			}
		},
	};
}

/** A document's socket never reconnects or transfers its lifetime to a new page. */
function createSqliteSocket({
	baseURL = globalThis.location?.origin,
	webSocket: Socket = globalThis.WebSocket,
}: CreateDesktopDeviceOptions) {
	let socket: WebSocket | undefined;
	let opening: Promise<void> | undefined;
	let failed: DeviceError | undefined;
	let nextId = 0;
	const pending = new Map<
		number,
		(result: Result<DeviceResponse, DeviceError>) => void
	>();
	let rejectOpen: ((cause: unknown) => void) | undefined;
	function fail(cause: unknown) {
		if (failed) return;
		failed = DeviceError.StorageFailed({ cause }).error;
		rejectOpen?.(failed);
		for (const settle of pending.values())
			settle({ error: failed, data: null });
		pending.clear();
		socket?.close();
	}
	function ready() {
		return (opening ??= new Promise<void>((resolve, reject) => {
			rejectOpen = reject;
			if (!baseURL || !Socket)
				throw new Error('Desktop SQLite needs an origin and WebSocket.');
			const url = new URL(`${DEVICE_PATH}/sqlite`, baseURL);
			url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
			socket = new Socket(url.href);
			socket.onopen = () => resolve();
			socket.onclose = () => fail(new Error('SQLite socket closed.'));
			socket.onerror = () => fail(new Error('SQLite socket failed.'));
			socket.onmessage = (event) => {
				try {
					const answer: unknown = parseSqliteFrame(String(event.data));
					if (
						typeof answer !== 'object' ||
						answer === null ||
						!('id' in answer) ||
						typeof answer.id !== 'number' ||
						!Number.isSafeInteger(answer.id) ||
						!pending.has(answer.id)
					)
						throw new Error('Invalid SQLite response id.');
					const settle = pending.get(answer.id)!;
					if ('failure' in answer && typeof answer.failure === 'string') {
						pending.delete(answer.id);
						settle(
							DeviceError.StorageFailed({ cause: new Error(answer.failure) }),
						);
						return;
					}
					if (!('response' in answer) || !isDeviceResponse(answer.response))
						throw new Error('Invalid SQLite response.');
					pending.delete(answer.id);
					settle(Ok(answer.response));
				} catch (cause) {
					fail(cause);
				}
			};
		}));
	}
	const request: AppSqliteTransport = async (message) => {
		if (failed) return { error: failed, data: null };
		const id = nextId++;
		let frame: string;
		try {
			frame = stringifySqliteFrame({ id, request: message });
		} catch (cause) {
			return DeviceError.StorageFailed({ cause });
		}
		try {
			await ready();
			if (failed) return { error: failed, data: null };
			return await new Promise<Result<DeviceResponse, DeviceError>>(
				(resolve) => {
					pending.set(id, resolve);
					try {
						socket!.send(frame);
					} catch (cause) {
						fail(cause);
					}
				},
			);
		} catch (cause) {
			fail(cause);
			return DeviceError.StorageFailed({ cause });
		}
	};
	return {
		request,
		close() {
			fail(new Error('SQLite socket closed.'));
		},
	};
}

/**
 * What the trusted origin owns, scoped to one application.
 *
 * The origin and the fetch are read here rather than at module scope, so a
 * seam leaf does not refuse a build before anything asked it for storage.
 */
export function createDesktopDevice({
	appId,
	...options
}: CreateDesktopDeviceOptions & { appId: string }): Device {
	appIdOrThrow(appId);
	const owner = createDesktopSqliteOwner(options);
	const sqlite = createAppSqlite(owner, appId);
	return {
		sqlite: Object.freeze(sqlite.value),
		close: () => sqlite.close(),
		secrets: Object.freeze(createDesktopSecrets(appId, options).value),
	};
}

type OwnerRequest = (
	message: DeviceRequest,
) => Promise<Result<DeviceResponse, DeviceError>>;

function createOwnerRequest({
	baseURL = globalThis.location?.origin,
	fetch: fetchImplementation = globalThis.fetch,
}: CreateDesktopDeviceOptions): OwnerRequest {
	if (!baseURL || !fetchImplementation) {
		throw new Error('Desktop app storage needs an origin and fetch.');
	}
	return async (message) => {
		try {
			const response = await fetchImplementation(`${baseURL}${DEVICE_PATH}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(message),
			});
			if (!response.ok) {
				return DeviceError.ProtocolFailed({ status: response.status });
			}
			const body: unknown = await response.json();
			if (!isDeviceResponse(body)) return DeviceError.InvalidResponse();
			return Ok(body);
		} catch (cause) {
			return DeviceError.StorageFailed({ cause });
		}
	};
}

export function createDesktopSecrets(
	appId: string,
	{
		assertUsable,
		account,
		...options
	}: CreateDesktopDeviceOptions & {
		assertUsable?: () => void;
		account?: AccountIdentity;
	} = {},
): { value: SecretStore; close(): Promise<void> } {
	appIdOrThrow(appId);
	const request = createOwnerRequest(options);
	let closed = false;
	let closing: Promise<void> | undefined;
	let operations = 0;
	let drained: (() => void) | undefined;
	function assertOpen() {
		assertUsable?.();
		if (closed) throw new Error('Secret store is closed.');
	}
	async function admitted<T>(operation: () => Promise<T>): Promise<T> {
		operations++;
		try {
			return await operation();
		} finally {
			if (--operations === 0) drained?.();
		}
	}
	return {
		value: {
			put(label: SecretLabel, value: string) {
				assertOpen();
				return admitted(async () => {
					const result = await request({
						kind: 'secret-put',
						account,
						appId,
						label,
						value,
					});
					return result.error === null
						? Ok(undefined)
						: SecretError.StorageFailed({ cause: result.error });
				});
			},
			get(label: SecretLabel) {
				assertOpen();
				return admitted(async () => {
					const result = await request({
						kind: 'secret-get',
						account,
						appId,
						label,
					});
					if (result.error !== null)
						return SecretError.StorageFailed({ cause: result.error });
					return result.data.kind === 'secret-get'
						? Ok(result.data.value)
						: SecretError.StorageFailed({
								cause: DeviceError.InvalidResponse().error,
							});
				});
			},
			delete(label: SecretLabel) {
				assertOpen();
				return admitted(async () => {
					const result = await request({
						kind: 'secret-delete',
						account,
						appId,
						label,
					});
					return result.error === null
						? Ok(undefined)
						: SecretError.StorageFailed({ cause: result.error });
				});
			},
		},
		close(): Promise<void> {
			if (closing) return closing;
			closed = true;
			return (closing = operations
				? new Promise<void>((resolve) => {
						drained = resolve;
					})
				: Promise.resolve());
		},
	};
}
