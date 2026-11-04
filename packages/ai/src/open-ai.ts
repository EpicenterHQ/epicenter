import { createLogger } from 'wellcrafted/logger';
import {
	AiError,
	type ChatRequest,
	createClient,
	type EmbeddingsRequest,
	type TranscriptionRequest,
} from './client.js';
import { type CustomEndpoints, isCustomEndpoints } from './custom-endpoints.js';
import type { Endpoint, EndpointModel, Source } from './endpoint.js';

const log = createLogger('ai');

/** A model as an app sees it: what it can do, and where it runs. */
export type Model = EndpointModel & { endpoint: string; source: Source };

/** Which model a request uses: the endpoint that offers it, and its id there. */
export type ModelChoice = { endpoint: string; model: string };

/**
 * A list of endpoints that changes: the person's connected endpoints
 * (`customEndpoints()`), or another `openAi(...)`, which has this shape, so
 * merges nest. `subscribe` is called when `endpoints()` may answer
 * differently.
 */
export type LiveEndpoints = {
	endpoints(): readonly Endpoint[];
	subscribe(listener: () => void): () => void;
};

/** One entry of the array `openAi` merges: an endpoint, a live list, several, or none (such as `localSpeech()` on the web). */
export type EndpointEntry =
	| Endpoint
	| LiveEndpoints
	| readonly (Endpoint | LiveEndpoints | null | undefined)[]
	| null
	| undefined;

type Options = { signal?: AbortSignal };

const isLive = (entry: Endpoint | LiveEndpoints): entry is LiveEndpoints =>
	'endpoints' in entry;

/**
 * Merge endpoints into one AI capability. `models()` lists every endpoint's
 * models in the array's order, so the app's array is the default order. A
 * request names its endpoint beside the OpenAI fields and goes through that
 * endpoint alone; nothing falls back to another.
 *
 * An entry may be a live list (`customEndpoints()`, or another `openAi`),
 * read again at every use, so a key added or a sign-in reaches the merge
 * without a new one. An app makes its `openAi` once.
 *
 * ```ts
 * export const ai = openAi([hosted(account), customEndpoints(), localServers()]);
 * for await (const { data, error } of ai.chat({ endpoint: 'hosted', model, messages })) …
 * ```
 */
export function openAi(entries: readonly EndpointEntry[]) {
	const flat = entries
		.flat()
		.filter((entry): entry is Endpoint | LiveEndpoints => entry != null);
	const lives = flat.filter(isLive);
	const fixed = flat.filter((entry): entry is Endpoint => !isLive(entry));
	const ids = new Set<string>();
	for (const { id } of fixed) {
		if (ids.has(id)) throw new Error(`Two endpoints share the id "${id}".`);
		ids.add(id);
	}
	/** Ids found twice among live lists, already reported. */
	const reported = new Set<string>();

	/** Every endpoint merged now, in the array's order; a later one with a taken id is left out. */
	function endpoints(): readonly Endpoint[] {
		const seen = new Set<string>();
		const merged: Endpoint[] = [];
		for (const entry of flat)
			for (const endpoint of isLive(entry) ? entry.endpoints() : [entry]) {
				if (seen.has(endpoint.id)) {
					if (!reported.has(endpoint.id)) {
						reported.add(endpoint.id);
						log.error(
							new Error(
								`Two endpoints share the id "${endpoint.id}"; the later is left out.`,
							),
						);
					}
					continue;
				}
				seen.add(endpoint.id);
				merged.push(endpoint);
			}
		return merged;
	}

	function clientFor(id: string) {
		const endpoint = endpoints().find((candidate) => candidate.id === id);
		return endpoint ? createClient(endpoint) : null;
	}

	return {
		/** The endpoints merged now, in the array's order. */
		endpoints,
		/** Every usable model, tagged with its endpoint and source, in the array's order. */
		models(): Model[] {
			return endpoints().flatMap((endpoint) =>
				endpoint.models().map((model) => ({
					...model,
					endpoint: endpoint.id,
					source: endpoint.source,
				})),
			);
		},
		/**
		 * The person's connected endpoints merged here (`customEndpoints()`),
		 * where they add, edit and remove one, or null when none was merged.
		 */
		custom(): CustomEndpoints | null {
			for (const live of lives) {
				if (isCustomEndpoints(live)) return live;
				const nested = (live as { custom?: () => CustomEndpoints | null })
					.custom;
				const found = nested?.();
				if (found) return found;
			}
			return null;
		},
		/**
		 * Call `listener` whenever the endpoints merged, or any one's models,
		 * may have changed. An endpoint a live list adds is subscribed to as it
		 * arrives, and one it drops is let go.
		 */
		subscribe(listener: () => void): () => void {
			const notify = () => {
				try {
					listener();
				} catch (cause) {
					log.error(new Error('An AI models subscriber failed.', { cause }));
				}
			};
			const held = new Map<Endpoint, (() => void) | undefined>();
			function follow() {
				const now = new Set(endpoints());
				for (const [endpoint, stop] of held)
					if (!now.has(endpoint)) {
						stop?.();
						held.delete(endpoint);
					}
				for (const endpoint of now)
					if (!held.has(endpoint))
						held.set(endpoint, endpoint.subscribe?.(notify));
			}
			const stops = lives.map((live) =>
				live.subscribe(() => {
					follow();
					notify();
				}),
			);
			follow();
			return () => {
				for (const stop of stops) stop();
				for (const stop of held.values()) stop?.();
				held.clear();
			};
		},
		/** Ask every endpoint that probes to look again, such as when a picker opens. */
		refresh(): void {
			for (const endpoint of endpoints()) endpoint.refresh?.();
		},
		/** Stream a chat completion from the named endpoint. */
		async *chat(
			{ endpoint, ...request }: ChatRequest & { endpoint: string },
			options: Options = {},
		) {
			const client = clientFor(endpoint);
			if (!client) {
				yield AiError.NoEndpoint({ endpoint });
				return;
			}
			yield* client.chat(request, options);
		},
		/** Transcribe audio at the named endpoint. */
		transcribe(
			{ endpoint, ...request }: TranscriptionRequest & { endpoint: string },
			options: Options = {},
		) {
			const client = clientFor(endpoint);
			if (!client) return Promise.resolve(AiError.NoEndpoint({ endpoint }));
			return client.transcribe(request as TranscriptionRequest, options);
		},
		/** Embed at the named endpoint. */
		embed(
			{ endpoint, ...request }: EmbeddingsRequest & { endpoint: string },
			options: Options = {},
		) {
			const client = clientFor(endpoint);
			if (!client) return Promise.resolve(AiError.NoEndpoint({ endpoint }));
			return client.embed(request, options);
		},
	};
}
export type Ai = ReturnType<typeof openAi>;
