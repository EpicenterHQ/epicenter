/**
 * Each app reaches this computer's Keychain under epicenter.<root id>.<name>.
 * Secrets belong to an app in one Epicenter. Moving an app to another
 * Epicenter means entering them again. Deleting epicenter.root.json orphans
 * the secrets for that root.
 * EPICENTER_TEST_SECRETS supplies process-local stores instead: a JSON object
 * shaped as { "epicenter.root-id.reading": { "token": "plain value" } }. Values stay
 * as strings. Each run is its own process and binds its app's store once, so
 * a store lives as long as the run.
 */
import type { Secrets } from '@epicenter/app';

function unavailable(message: string): Secrets {
	const refuse = async (): Promise<never> => {
		throw new Error(message);
	};
	return { get: refuse, set: refuse, delete: refuse };
}

/** Name the service for one app in one Epicenter. */
export function keychainService(rootId: string, name: string): string {
	return `epicenter.${rootId}.${name}`;
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
		const values = new Map(Object.entries(entries?.[service] ?? {}));
		return {
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
