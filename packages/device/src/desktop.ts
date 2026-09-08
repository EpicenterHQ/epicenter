/// <reference lib="dom" />

/**
 * The desktop binding: the trusted Epicenter origin is the owner, reached over
 * same-origin HTTP.
 *
 * Two capabilities, and neither of them is the store. **Data stays
 * client-owned, and the host contributes nothing to it.** The store lives in
 * the WebView, exactly as it does in a browser tab, because the host serves
 * bundles and brokers credentials and owns no application data (ADR-0226,
 * ADR-0227). It is not on this leaf at all (ADR-0339): a deployed app is a
 * trusted app (ADR-0334), so there was no admission round trip and no second
 * party whose answer could mean anything, and a seam with one implementation
 * is not a seam.
 *
 * **This leaf builds storage, not a data session.** Nothing about a session
 * varies by runtime; the trusted owner's files and keychain do. So this is what
 * an application selects per build, while one `createEpicenter` in
 * `@epicenter/app` serves every build.
 *
 * **SQLite is a Bun-owned file.** The owner maps `(appId, name)` to a path
 * below the one Epicenter data root; the application sends statements and never
 * sees the path. Deleting one is the same round trip, and the owner closes its
 * handle before it unlinks, because the application cannot (ADR-0321).
 *
 * **A secret is a keychain entry.** The owner hands it to Rust over the private
 * sidecar pipe, which is the only thing on this machine that names a keyring
 * entry. Nothing durable lands in the page.
 */

import { Ok, type Result } from 'wellcrafted/result';
import {
	appIdOrThrow,
	type Device,
	DeviceError,
	SecretError,
	type SecretStore,
} from './index.js';
import { createOwnedSqlite, createScopedSqlite, unwrap } from './owner.js';
import {
	DEVICE_PATH,
	type DeviceRequest,
	type DeviceResponse,
	isDeviceResponse,
} from './protocol.js';

export type CreateDesktopDeviceOptions = {
	/** The trusted origin that owns the files and the keychain entries. */
	baseURL?: string;
	fetch?: typeof globalThis.fetch;
};

export function createDesktopSqliteOwner(
	options: CreateDesktopDeviceOptions = {},
): import('./owner.js').DeviceSqliteOwner {
	const request = createOwnerRequest(options);
	return {
		open: async (ownerAppId, scope, name) =>
			createOwnedSqlite(request, ownerAppId, scope, name),
		delete: async (ownerAppId, scope, name) => {
			const result = await unwrap(
				request({ kind: 'sqlite-delete', appId: ownerAppId, scope, name }),
				'sqlite-delete',
				() => undefined,
			);
			if (result.error !== null) throw result.error;
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
	const request = createOwnerRequest(options);
	const owner = createDesktopSqliteOwner(options);
	return {
		sqlite: Object.freeze(
			createScopedSqlite(owner, appId, { kind: 'local' }),
		),
		secrets: Object.freeze(createKeychainSecrets(request, appId)),
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

function createKeychainSecrets(
	request: OwnerRequest,
	appId: string,
): SecretStore {
	return {
		put: async (label, value) => {
			const result = await request({
				kind: 'secret-put',
				appId,
				label,
				value,
			});
			return result.error === null
				? Ok(undefined)
				: SecretError.StorageFailed({ cause: result.error });
		},
		get: async (label) => {
			const result = await request({ kind: 'secret-get', appId, label });
			if (result.error !== null) {
				return SecretError.StorageFailed({ cause: result.error });
			}
			return result.data.kind === 'secret-get'
				? Ok(result.data.value)
				: SecretError.StorageFailed({
						cause: DeviceError.InvalidResponse().error,
					});
		},
		delete: async (label) => {
			const result = await request({ kind: 'secret-delete', appId, label });
			return result.error === null
				? Ok(undefined)
				: SecretError.StorageFailed({ cause: result.error });
		},
	};
}
