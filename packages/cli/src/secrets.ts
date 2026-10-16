/**
 * This computer's keychain, as the `epicenter` CLI reaches it (ADR-0556):
 * `Bun.secrets`, one entry per AI connection named by its id under
 * {@link KEYCHAIN_SERVICE} (ADR-0557), and one entry per sign-in under
 * {@link AUTH_KEYCHAIN_SERVICE} (ADR-0558). The CLI is the only program that
 * reads or writes these entries; the desktop shell and its pages ask it
 * through fixed commands.
 *
 * `EPICENTER_TEST_SECRETS` replaces the keychain with stores held in memory
 * for one process, the AI connections' seeded from its JSON (`{ "<id>": {
 * "endpoint", "key" } }`) and the sign-ins' seeded from its `$auth` member
 * (`{ "$auth": { "<entry name>": <stored grant> } }`, empty by default), so
 * tests and a compiled binary's smoke run never touch the real keychain.
 * Nothing in them is ever written anywhere.
 */

import { createMemorySecrets, type SecretStore } from '@epicenter/ai/send';

/** The keychain service every AI connection's entry is filed under. */
export const KEYCHAIN_SERVICE = 'so.epicenter.connections';
/** The keychain service each grant's refresh token and cached access tokens are filed under. */
export const AUTH_KEYCHAIN_SERVICE = 'so.epicenter.auth';

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

/** One test store per service, so every call in a process sees the same one. */
const testStores = new Map<string, SecretStore>();

/**
 * The store this run uses for `service`: the keychain, or the test store
 * `EPICENTER_TEST_SECRETS` stands up.
 */
export function keychain(service: string = KEYCHAIN_SERVICE): SecretStore {
	const seed = process.env.EPICENTER_TEST_SECRETS;
	if (seed !== undefined) {
		let store = testStores.get(service);
		if (store === undefined) {
			try {
				const { $auth, ...connections } = JSON.parse(seed);
				store = createMemorySecrets(
					service === KEYCHAIN_SERVICE ? connections : ($auth ?? {}),
				);
			} catch {
				return unavailable('EPICENTER_TEST_SECRETS is not JSON');
			}
			testStores.set(service, store);
		}
		return store;
	}
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
