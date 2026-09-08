/**
 * The device-local inference connection registry (ADR-0059): one cohesive object
 * that owns the device's set of custom OpenAI-compatible connections plus the
 * model ids each was discovered to serve, and resolves a conversation's model to a
 * transport. Every chat app instantiates this once instead of re-deriving the same
 * persisted store, so the picker, the engine, and the cross-device banner all
 * read one source.
 *
 * Device-local, never synced: a key is a secret on the plaintext relay and a
 * `localhost` URL is meaningless elsewhere (ADR-0004). The arktype schema here is
 * the single runtime shape; `Connection` (from `@epicenter/client`) is the
 * matching compile-time type.
 *
 * Two axes people conflate. A custom connection here (a base URL + optional key)
 * is device-local and appears the moment it is added; it is unrelated to sign-in
 * or to which Epicenter instance is connected. The injected hosted entry is always
 * present, so its picker group renders regardless of sign-in, but its transport is
 * the audience-scoped `account.fetch` (ADR-0053) against the Cloud gateway, so it only
 * functions when signed into Cloud (signed out it is shown-but-inert; the chat
 * surface's `onSignIn` catches the send). Instance auth (Cloud OAuth vs self-host
 * token) is a separate decision that never gates this picker.
 */

import {
	type Connection,
	type ListModelsError,
	listModels,
	type ResolvedConnection,
	resolveConnection,
} from '@epicenter/client';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { type } from 'arktype';
import type { Result } from 'wellcrafted/result';

/**
 * A reactive persisted-state handle: localStorage (web) or chrome.storage
 * (extension). Both backends expose this identical `{ current }` interface, so
 * the registry binds against the shape and the app injects the mechanism.
 */
export type PersistedState<T> = { current: T };

/**
 * Builds one persisted slice from a key + schema + default value. The app
 * supplies the mechanism (web: `createPersistedState`; extension:
 * `createStorageState`), so `@epicenter/app-shell` depends on neither storage
 * backend.
 */
export type PersistFactory = <S extends StandardSchemaV1>(
	key: string,
	schema: S,
	defaultValue: StandardSchemaV1.InferOutput<S>,
) => PersistedState<StandardSchemaV1.InferOutput<S>>;

/**
 * One hosted catalog entry the app sells. Injected, not imported: the hosted
 * catalog is app-specific (Vocab offers a model the others do not), so the shared
 * registry never reaches into `@epicenter/constants`.
 */
export type HostedModel = { id: string; label: string; credits: number };

/**
 * One stored custom connection: the transport identity (`baseUrl` + optional
 * `apiKey`) plus the model ids it was discovered to serve. A connection and its
 * models are one concept, so they live in one record (not two stores joined by
 * base URL); removing the connection drops its models with it. `models` is
 * optional so a connection persisted before this shape still loads, then
 * re-discovers on next open.
 */
const storedConnectionSchema = type({
	baseUrl: 'string',
	'apiKey?': 'string',
	'models?': 'string[]',
});
type StoredConnection = typeof storedConnectionSchema.infer;

/** The reactive registry object returned by {@link createInferenceConnections}. */
export type InferenceConnections = ReturnType<
	typeof createInferenceConnections
>;

export function createInferenceConnections({
	storageKey,
	hostedModels,
	hosted,
	persist,
}: {
	/** Namespace for the persisted-state keys, e.g. the app name. */
	storageKey: string;
	/** The hosted catalog this app sells (app-specific subset). */
	hostedModels: HostedModel[];
	/** The hosted transport (`account.fetch` + gateway base URL). */
	hosted: ResolvedConnection;
	/** The persistence mechanism (web: localStorage; extension: chrome.storage). */
	persist: PersistFactory;
}) {
	const stored = persist(
		`${storageKey}.inference-connections`,
		storedConnectionSchema.array(),
		[],
	);

	/** The candidates a model resolves against, in priority order: every custom
	 * connection (the user's own key) BEFORE hosted. The hosted catalog sells real
	 * upstream ids (e.g. `gpt-5.5`), so a user who adds their own OpenAI key serves a
	 * colliding id; matching custom first resolves that turn to the user's key
	 * instead of silently metering it against Epicenter credits. Hosted is the last
	 * resort, serving only ids no custom connection on this device claims.
	 *
	 * Each candidate carries its own `resolve` thunk, so matching never branches on
	 * what a candidate is: a custom connection closes over `resolveConnection`
	 * (static data -> transport); hosted closes over the injected transport. The
	 * `kind` discriminant is gone (ADR-0060). */
	function candidates(): {
		resolve: () => ResolvedConnection;
		models: readonly string[];
	}[] {
		return [
			...stored.current.map((connection) => ({
				resolve: () => resolveConnection(connection),
				models: connection.models ?? [],
			})),
			{ resolve: () => hosted, models: hostedModels.map((m) => m.id) },
		];
	}

	/** Resolve a conversation's model (ADR-0055) to its transport, or `null` when no
	 * connection on this device serves it. Internal: the served/unserved predicate
	 * has one definition here, exposed as `resolveOrHosted` (transport) and
	 * `canServe` (boolean) so neither the engine nor the UI re-derives it. */
	function resolve(model: string): ResolvedConnection | null {
		return (
			candidates()
				.find((c) => c.models.includes(model))
				?.resolve() ?? null
		);
	}

	return {
		/** The hosted catalog this app sells (for the picker's Epicenter group). */
		hostedModels,
		/**
		 * The device's custom connections, in display order. Each carries its own
		 * discovered `models` (see {@link StoredConnection}), so the picker reads one
		 * list instead of joining a connection to a separate models map by base URL.
		 */
		get custom(): readonly StoredConnection[] {
			return stored.current;
		},

		/** Add (or replace by base URL) a connection, optionally caching its models. */
		add(connection: Connection, models?: string[]) {
			const existing = stored.current.find(
				(c) => c.baseUrl === connection.baseUrl,
			);
			stored.current = [
				...stored.current.filter((c) => c.baseUrl !== connection.baseUrl),
				{ ...connection, models: models ?? existing?.models ?? [] },
			];
		},
		/** Forget a connection and its discovered models by base URL. */
		remove(baseUrl: string) {
			stored.current = stored.current.filter((c) => c.baseUrl !== baseUrl);
		},

		/** Discover the models a candidate endpoint serves (best effort, never throws). */
		discover(
			baseUrl: string,
			apiKey?: string,
		): Promise<Result<string[], ListModelsError>> {
			return listModels(
				resolveConnection({ baseUrl, apiKey: apiKey || undefined }),
			);
		},

		/** Re-discover an already-added connection's models and update its cached
		 * list, for when a user pulled a new model at the endpoint after connecting.
		 * Best effort by design: on failure the previously discovered ids stand, so a
		 * transient outage never empties the group, and nothing is returned because the
		 * caller has nothing to surface (unlike `discover`, whose error builds the
		 * connect-form hint). Connect-time `add` still owns first discovery; this is the
		 * one path that refreshes a stale list in place. */
		async refresh(baseUrl: string): Promise<void> {
			const connection = stored.current.find((c) => c.baseUrl === baseUrl);
			if (!connection) return;
			const { data, error } = await listModels(resolveConnection(connection));
			if (error) return;
			stored.current = stored.current.map((c) =>
				c.baseUrl === baseUrl ? { ...c, models: data } : c,
			);
		},

		/**
		 * The transport for a conversation's model, falling back to the hosted
		 * connection when no device connection serves it. The fallback ships the
		 * unservable model id to the gateway, which errors loudly; callers gate
		 * sending via {@link canServe}, so this fires only on a path the UI blocks and
		 * never silently substitutes a different model.
		 */
		resolveOrHosted(model: string): ResolvedConnection {
			return resolve(model) ?? hosted;
		},
		/**
		 * Whether a connection on this device serves the model. The single predicate
		 * behind both the cross-device banner and the send gate; never rewrites the
		 * synced model column.
		 */
		canServe(model: string): boolean {
			return resolve(model) !== null;
		},
	};
}
