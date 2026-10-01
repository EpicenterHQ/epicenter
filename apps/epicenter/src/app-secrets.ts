/**
 * Opaque credentials scoped by application and caller label.
 * Rust composes the native keychain address from these structured fields.
 * These namespaces prevent collisions among trusted apps; they are not a sandbox.
 */

import { type AccountIdentity, deviceOwnerPath } from '@epicenter/principal';

export type AppSecretOwner = {
	put(
		appId: string,
		label: string,
		value: string,
		account?: AccountIdentity,
	): Promise<void>;
	get(
		appId: string,
		label: string,
		account?: AccountIdentity,
	): Promise<string | null>;
	delete(
		appId: string,
		label: string,
		account?: AccountIdentity,
	): Promise<void>;
};

/** The native half of this owner: three correlated requests on the Rust pipe. */
export type NativeSecretPort = {
	putAppSecret(
		appId: string,
		label: string,
		value: string,
		account?: AccountIdentity,
	): Promise<void>;
	getAppSecret(
		appId: string,
		label: string,
		account?: AccountIdentity,
	): Promise<string | null>;
	deleteAppSecret(
		appId: string,
		label: string,
		account?: AccountIdentity,
	): Promise<void>;
};

export function createNativeAppSecrets(port: NativeSecretPort): AppSecretOwner {
	return {
		put: (appId, label, value, account) =>
			port.putAppSecret(appId, label, value, account),
		get: (appId, label, account) => port.getAppSecret(appId, label, account),
		delete: (appId, label, account) =>
			port.deleteAppSecret(appId, label, account),
	};
}

/**
 * A secret owner for a host running without its Rust parent: the server tests,
 * and the bare Bun run an operator uses to exercise the origin alone.
 *
 * It forgets everything when the process ends, which is the honest behavior for
 * a run with no credential store attached. It is not a fallback the desktop
 * release can reach: the composition root binds the native owner whenever the
 * pipe is there, and no environment variable selects this one.
 */
export function createProcessMemoryAppSecrets(): AppSecretOwner {
	const values = new Map<string, string>();
	const key = (appId: string, label: string, account?: AccountIdentity) =>
		JSON.stringify([appId, deviceOwnerPath(account), label]);
	return {
		async put(appId, label, value, account) {
			values.set(key(appId, label, account), value);
		},
		async get(appId, label, account) {
			return values.get(key(appId, label, account)) ?? null;
		},
		async delete(appId, label, account) {
			values.delete(key(appId, label, account));
		},
	};
}
