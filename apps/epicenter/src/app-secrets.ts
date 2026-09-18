/**
 * Opaque credentials scoped by application and caller label.
 * Rust composes the native keychain address from these structured fields.
 * These namespaces prevent collisions among trusted apps; they are not a sandbox.
 */

export type AppSecretOwner = {
	put(appId: string, label: string, value: string): Promise<void>;
	get(appId: string, label: string): Promise<string | null>;
	delete(appId: string, label: string): Promise<void>;
};

/** The native half of this owner: three correlated requests on the Rust pipe. */
export type NativeSecretPort = {
	putAppSecret(appId: string, label: string, value: string): Promise<void>;
	getAppSecret(appId: string, label: string): Promise<string | null>;
	deleteAppSecret(appId: string, label: string): Promise<void>;
};

export function createNativeAppSecrets(port: NativeSecretPort): AppSecretOwner {
	return {
		put: (appId, label, value) => port.putAppSecret(appId, label, value),
		get: (appId, label) => port.getAppSecret(appId, label),
		delete: (appId, label) => port.deleteAppSecret(appId, label),
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
	const key = (appId: string, label: string) => JSON.stringify([appId, label]);
	return {
		async put(appId, label, value) {
			values.set(key(appId, label), value);
		},
		async get(appId, label) {
			return values.get(key(appId, label)) ?? null;
		},
		async delete(appId, label) {
			values.delete(key(appId, label));
		},
	};
}
