import { secretScopeKey } from '@epicenter/device';
import type { AccountIdentity } from '@epicenter/principal';

/**
 * Opaque credentials scoped by application, captured account and caller label.
 * Rust composes the native keychain address from these structured fields.
 * These namespaces prevent collisions among trusted apps; they are not a sandbox.
 */

export type AppSecretOwner = {
	put(
		appId: string,
		account: AccountIdentity | null,
		label: string,
		value: string,
	): Promise<void>;
	get(
		appId: string,
		account: AccountIdentity | null,
		label: string,
	): Promise<string | null>;
	delete(
		appId: string,
		account: AccountIdentity | null,
		label: string,
	): Promise<void>;
};

/** The native half of this owner: three correlated requests on the Rust pipe. */
export type NativeSecretPort = {
	putAppSecret(
		appId: string,
		account: AccountIdentity | null,
		label: string,
		value: string,
	): Promise<void>;
	getAppSecret(
		appId: string,
		account: AccountIdentity | null,
		label: string,
	): Promise<string | null>;
	deleteAppSecret(
		appId: string,
		account: AccountIdentity | null,
		label: string,
	): Promise<void>;
};

export function createNativeAppSecrets(port: NativeSecretPort): AppSecretOwner {
	return {
		put: (appId, account, label, value) =>
			port.putAppSecret(appId, account, label, value),
		get: (appId, account, label) => port.getAppSecret(appId, account, label),
		delete: (appId, account, label) =>
			port.deleteAppSecret(appId, account, label),
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
	const key = (appId: string, account: AccountIdentity | null, label: string) =>
		JSON.stringify([secretScopeKey(appId, account), label]);
	return {
		async put(appId, account, label, value) {
			values.set(key(appId, account, label), value);
		},
		async get(appId, account, label) {
			return values.get(key(appId, account, label)) ?? null;
		},
		async delete(appId, account, label) {
			values.delete(key(appId, account, label));
		},
	};
}
