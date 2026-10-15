/**
 * This computer's keychain, as the `epicenter` CLI reaches it (ADR-0556,
 * ADR-0557): `Bun.secrets`, under one service, one entry per AI connection
 * named by its id. The CLI is the only program that reads or writes these
 * entries; the desktop shell and its pages ask it through fixed commands.
 *
 * `EPICENTER_TEST_SECRETS` replaces the keychain with a store held in
 * memory for one process, seeded from its JSON (`{ "<id>": { "endpoint",
 * "key" } }`), so tests and a compiled binary's smoke run never touch the
 * real keychain. Nothing in it is ever written anywhere.
 */

import { createMemorySecrets, type SecretStore } from '@epicenter/ai/send';

/** The keychain service every AI connection's entry is filed under. */
export const KEYCHAIN_SERVICE = 'so.epicenter.connections';

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

/** The store this run uses: the keychain, or the test store `EPICENTER_TEST_SECRETS` seeds. */
export function keychain(): SecretStore {
	const seed = process.env.EPICENTER_TEST_SECRETS;
	if (seed !== undefined) {
		try {
			return createMemorySecrets(JSON.parse(seed));
		} catch {
			return unavailable('EPICENTER_TEST_SECRETS is not JSON');
		}
	}
	const secrets = (Bun as unknown as { secrets?: BunSecrets }).secrets;
	if (secrets === undefined)
		return unavailable(
			`this build of the epicenter command has no Bun.secrets (Bun ${Bun.version}), so it cannot reach the system keychain`,
		);
	return {
		get: (name) => secrets.get({ service: KEYCHAIN_SERVICE, name }),
		set: (name, value) =>
			secrets.set({ service: KEYCHAIN_SERVICE, name, value }),
		delete: (name) => secrets.delete({ service: KEYCHAIN_SERVICE, name }),
	};
}
