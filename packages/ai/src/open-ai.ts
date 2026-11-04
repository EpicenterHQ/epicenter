import { createLogger } from 'wellcrafted/logger';
import {
	AiError,
	type ChatRequest,
	createClient,
	type EmbeddingsRequest,
	type TranscriptionRequest,
} from './client.js';
import type { Endpoint, EndpointModel, Source } from './endpoint.js';

const log = createLogger('ai');

/** A model as an app sees it: what it can do, and where it runs. */
export type Model = EndpointModel & { endpoint: string; source: Source };

/** Which model a request uses: the endpoint that offers it, and its id there. */
export type ModelChoice = { endpoint: string; model: string };

/** One entry of the array `openAi` merges: an endpoint, several, or none (such as `localSpeech()` on the web). */
export type EndpointEntry =
	| Endpoint
	| readonly (Endpoint | null | undefined)[]
	| null
	| undefined;

type Options = { signal?: AbortSignal };

/**
 * Merge endpoints into one AI capability. `models()` lists every endpoint's
 * models in the array's order, so the app's array is the default order (local,
 * hosted, custom when an app passes them so). A request names its endpoint
 * beside the OpenAI fields and goes through that endpoint alone; nothing
 * falls back to another.
 *
 * ```ts
 * const ai = openAi([localServers(), hosted(account), ...keys.map(custom)]);
 * for await (const { data, error } of ai.chat({ endpoint: 'hosted', model, messages })) …
 * ```
 *
 * `openAi` holds no resources: an app whose endpoints change (a key added)
 * merges again, and endpoints that own a lifecycle are made once and passed
 * to each merge.
 */
export function openAi(entries: readonly EndpointEntry[]) {
	const endpoints = entries
		.flat()
		.filter((entry): entry is Endpoint => entry != null);
	const byId = new Map<string, Endpoint>();
	for (const endpoint of endpoints) {
		if (byId.has(endpoint.id))
			throw new Error(`Two endpoints share the id "${endpoint.id}".`);
		byId.set(endpoint.id, endpoint);
	}
	function clientFor(id: string) {
		const endpoint = byId.get(id);
		return endpoint ? createClient(endpoint) : null;
	}

	return {
		/** The merged endpoints, in the array's order. */
		endpoints(): readonly Endpoint[] {
			return endpoints;
		},
		/** Every usable model, tagged with its endpoint and source, in the array's order. */
		models(): Model[] {
			return endpoints.flatMap((endpoint) =>
				endpoint.models().map((model) => ({
					...model,
					endpoint: endpoint.id,
					source: endpoint.source,
				})),
			);
		},
		/** Call `listener` whenever any endpoint's models may have changed. */
		subscribe(listener: () => void): () => void {
			const notify = () => {
				try {
					listener();
				} catch (cause) {
					log.error(new Error('An AI models subscriber failed.', { cause }));
				}
			};
			const stops = endpoints.map((endpoint) => endpoint.subscribe?.(notify));
			return () => {
				for (const stop of stops) stop?.();
			};
		},
		/** Ask every endpoint that probes to look again, such as when a picker opens. */
		refresh(): void {
			for (const endpoint of endpoints) endpoint.refresh?.();
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
