/**
 * This computer's keychain as Messages' local program reaches it: `Bun.secrets`
 * under Messages' own service. Tests inject an in-memory store, so they
 * never touch the real keychain.
 */

/**
 * Where keychain entries are kept, by entry name. The program binds
 * `Bun.secrets` per service; tests bind {@link createMemorySecrets}. A
 * method may throw.
 */
export type SecretStore = {
	get(name: string): Promise<string | null>;
	set(name: string, value: string): Promise<void>;
	delete(name: string): Promise<boolean>;
};

/** A store that forgets everything with its process, seeded with `entries`, each kept as its JSON. */
export function createMemorySecrets(
	entries: Readonly<Record<string, unknown>> = {},
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

type BunSecrets = {
	get(options: { service: string; name: string }): Promise<string | null>;
	set(options: { service: string; name: string; value: string }): Promise<void>;
	delete(options: { service: string; name: string }): Promise<boolean>;
};

/** A store whose every call fails with why the keychain cannot be used. */
function unavailable(reason: string): SecretStore {
	const refuse = async (): Promise<never> => {
		throw new Error(reason);
	};
	return { get: refuse, set: refuse, delete: refuse };
}

/** The Keychain store for `service`. */
export function keychain(service: string): SecretStore {
	const secrets = (Bun as unknown as { secrets?: BunSecrets }).secrets;
	if (secrets === undefined)
		return unavailable(
			`this build of the epicenter command has no Bun.secrets (Bun ${Bun.version}), so it cannot reach the system keychain`,
		);
	return {
		get: (name) => secrets.get({ service, name }),
		set: (name, value) => secrets.set({ service, name, value }),
		delete: (name) => secrets.delete({ service, name }),
	};
}
