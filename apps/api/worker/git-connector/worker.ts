/**
 * Cloudflare adapter for the GitHub connector: one Durable Object per
 * Epicenter principal. The object runs the portable connection core over its
 * own storage, so every operation for one principal, including token refresh
 * requested from any Worker isolate, is serialized in one place.
 */
import { DurableObject } from 'cloudflare:workers';
import { Err } from 'wellcrafted/result';
import type {
	ConnectionDirectory,
	ConnectionPort,
	GitHubConnectorRuntime,
} from './app.js';
import {
	type GitConnectorBindings,
	gitHubConnectorCallbacks,
	readGitConnectorSecrets,
} from './config.js';
import {
	type BeginInput,
	type CallbackInput,
	type CompleteInput,
	type Connection,
	createGitHubConnection,
	type PairInput,
	type RepositoryAddress,
} from './connection.js';
import { createGitHubClient } from './github.js';

/** Bindings the Worker adds for the connector, including the object namespace. */
export type GitConnectorWorkerBindings = GitConnectorBindings & {
	GIT_GITHUB_CONNECTIONS?: DurableObjectNamespace<GitHubConnection>;
};

const NOT_CONFIGURED = Err({ code: 'not_configured' } as const);

export class GitHubConnection extends DurableObject<GitConnectorBindings> {
	#connection: Promise<Connection | undefined> | undefined;

	#open(): Promise<Connection | undefined> {
		this.#connection ??= readGitConnectorSecrets(this.env).then((secrets) => {
			if (!secrets) {
				// Retry configuration on the next call instead of caching absence.
				this.#connection = undefined;
				return undefined;
			}
			const storage = this.ctx.storage;
			return createGitHubConnection({
				id: this.ctx.id.toString(),
				sealKey: secrets.sealKey,
				github: createGitHubClient({
					app: secrets.app,
					fetch: (input, init) => fetch(input, init),
					now: Date.now,
				}),
				storage: {
					get: (key) => storage.get(key),
					put: (key, value) => storage.put(key, value),
					async delete(key) {
						await storage.delete(key);
					},
					list: (prefix) => storage.list({ prefix }),
					async schedule(at) {
						if (at === undefined) await storage.deleteAlarm();
						else await storage.setAlarm(at);
					},
				},
			});
		});
		return this.#connection;
	}

	async begin(principalId: string, input: BeginInput) {
		return (await this.#open())?.begin(principalId, input) ?? NOT_CONFIGURED;
	}
	async callback(input: CallbackInput) {
		return (await this.#open())?.callback(input);
	}
	async complete(principalId: string, input: CompleteInput) {
		return (await this.#open())?.complete(principalId, input) ?? NOT_CONFIGURED;
	}
	async repositories(principalId: string) {
		return (await this.#open())?.repositories(principalId) ?? NOT_CONFIGURED;
	}
	async pair(principalId: string, input: PairInput) {
		return (await this.#open())?.pair(principalId, input) ?? NOT_CONFIGURED;
	}
	async pairings(principalId: string) {
		return (await this.#open())?.pairings(principalId) ?? NOT_CONFIGURED;
	}
	async unpair(principalId: string, folderId: string) {
		return (
			(await this.#open())?.unpair(principalId, folderId) ?? NOT_CONFIGURED
		);
	}
	async authorizeTransfer(
		principalId: string,
		folderId: string,
		revision: string,
	) {
		return (
			(await this.#open())?.authorizeTransfer(
				principalId,
				folderId,
				revision,
			) ?? NOT_CONFIGURED
		);
	}
	async authorizeRepositoryTransfer(
		principalId: string,
		repository: RepositoryAddress,
	) {
		return (
			(await this.#open())?.authorizeRepositoryTransfer(
				principalId,
				repository,
			) ?? NOT_CONFIGURED
		);
	}

	/** Scheduled at the next transaction or grant expiry. Pairings never expire. */
	override async alarm() {
		await (await this.#open())?.sweep();
	}
}

/**
 * Address connection objects. A principal's object is named from its
 * verified principal id; callback state carries that object's id string,
 * which `idFromString` refuses when it cannot parse it. A well-formed forged
 * id reaches an empty object, which reads nothing and writes nothing.
 */
export function durableConnections(
	namespace: DurableObjectNamespace<GitHubConnection>,
): ConnectionDirectory {
	// RPC stubs return the same plain results the core does.
	const port = (id: DurableObjectId) =>
		namespace.get(id) as unknown as ConnectionPort;
	return {
		forPrincipal(principalId) {
			const id = namespace.idFromName(`principal:${principalId}`);
			return { id: id.toString(), connection: port(id) };
		},
		open(id) {
			if (!/^[0-9a-f]{64}$/.test(id)) return undefined;
			try {
				return port(namespace.idFromString(id));
			} catch {
				return undefined;
			}
		},
	};
}

/**
 * Runtime for the Worker edge, or undefined (503 `not_configured`) when the
 * namespace, client credentials, or grant key are missing or malformed.
 */
export async function resolveWorkerGitHubConnector(
	env: GitConnectorWorkerBindings,
	apiOrigin: string,
): Promise<GitHubConnectorRuntime | undefined> {
	if (!env.GIT_GITHUB_CONNECTIONS) return undefined;
	if (!(await readGitConnectorSecrets(env))) return undefined;
	return {
		apiOrigin,
		callbacks: gitHubConnectorCallbacks(apiOrigin),
		connections: durableConnections(env.GIT_GITHUB_CONNECTIONS),
		gitFetch: (input, init) => fetch(input, init),
	};
}
