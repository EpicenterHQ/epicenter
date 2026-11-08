/**
 * Each app reaches this computer's Keychain under epicenter.<name> (ADR-0841).
 * EPICENTER_TEST_SECRETS supplies process-local stores instead: a JSON object
 * shaped as { "epicenter.reading": { "token": "plain value" } }. Values stay
 * as strings, and every call for one service shares the same store.
 */
import type { Secrets } from '@epicenter/app';

const testStores = new Map<string, Secrets>();

function unavailable(message: string): Secrets {
	const refuse = async (): Promise<never> => {
		throw new Error(message);
	};
	return { get: refuse, set: refuse, delete: refuse };
}

/** Name the service shared by every local copy of an app. */
export function keychainService(name: string): string {
	return `epicenter.${name}`;
}

/** Bind this computer's keychain to one app, or a process-local seeded store in tests. */
export function keychain(service: string): Secrets {
	const seed = process.env.EPICENTER_TEST_SECRETS;
	if (seed !== undefined) {
		let entries: Record<string, Record<string, string>>;
		try {
			entries = JSON.parse(seed);
		} catch {
			return unavailable('EPICENTER_TEST_SECRETS is not JSON');
		}
		const existing = testStores.get(service);
		if (existing) return existing;
		const values = new Map(Object.entries(entries?.[service] ?? {}));
		const store: Secrets = {
			async get(name) {
				return values.get(name);
			},
			async set(name, value) {
				values.set(name, value);
			},
			async delete(name) {
				values.delete(name);
			},
		};
		testStores.set(service, store);
		return store;
	}
	const secrets = Bun.secrets;
	if (!secrets)
		return unavailable(
			'This Bun build has no Bun.secrets and cannot reach the system keychain',
		);
	return {
		async get(name) {
			return (await secrets.get({ service, name })) ?? undefined;
		},
		async set(name, value) {
			await secrets.set({ service, name, value });
		},
		async delete(name) {
			await secrets.delete({ service, name });
		},
	};
}
