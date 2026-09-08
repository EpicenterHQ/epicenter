/**
 * The inference connection: a device-local, capability-orthogonal endpoint
 * (ADR-0060, amending ADR-0059). A connection is just where + how to authenticate
 * to one OpenAI-compatible server; it carries no model and no capability, so one
 * connection can drive chat, transcription, or embeddings alike. The model is the
 * conversation's (ADR-0055), paired with the transport by the caller per turn.
 *
 * There is no `kind` discriminant and no auth-strategy union. A connection is the
 * static data a human types into a form: a base URL and an optional bearer key.
 * `resolveConnection` turns that into a transport with a single, branchless rule
 * (`apiKey` -> `Authorization: Bearer`). Anything that is NOT static data, the
 * hosted Epicenter gateway (an injected session fetch) and any future
 * signing/refresh auth (Bedrock SigV4, Vertex OAuth), never enters this shape: the
 * caller composes it into a {@link ResolvedConnection} and injects it. Hosted is
 * therefore not a member of this type; it is the registry's injected fallback
 * transport (see `@epicenter/app-shell` `createInferenceConnections`).
 *
 * The leak guard is structural (ADR-0053): the Epicenter bearer is attached only by
 * `account.fetch`, and only to the origin it signed into. A connection here is always
 * a third-party URL reached with a plain fetch carrying only the user's own key and
 * headers, so a custom turn can never reach its URL with the Epicenter bearer. The
 * origin check lives in the account transport, not in this
 * resolver, so this resolver needs no hosted argument to stay safe.
 */

import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { EngineFetch } from './agent-engine.js';

/** A canonical OpenAI-compatible provider we pre-fill as a preset (ADR-0060). */
export type PresetId = 'ollama' | 'lmstudio' | 'openai' | 'openrouter' | 'groq';

/**
 * The data that distinguishes one OpenAI-compatible provider from another. The
 * key is always `Authorization: Bearer`, so a preset is pure data with no
 * matching code path: only the base URL and whether a key is needed differ. The
 * local-vs-cloud facet is derived from the base URL (is it `localhost`?), not
 * stored, so it cannot drift from the URL and a user-entered custom URL gets the
 * same treatment as a preset.
 */
export type ConnectionPreset = {
	id: PresetId;
	label: string;
	/** The base URL with `/v1` included, so the user never appends it. */
	baseUrl: string;
	/** Whether the endpoint needs a Bearer key; local servers do not. */
	requiresKey: boolean;
};

/**
 * The shipped presets (ADR-0060). Anthropic (its compat layer is "for testing"
 * and loses prompt caching and thinking) and a bring-your-own Gemini (its compat
 * layer 400s on tools and JSON together, which the agent loops use) are
 * deliberately absent; both are reachable as a raw custom URL. Self-hosted
 * Epicenter is also a raw custom URL, not a preset.
 */
export const CONNECTION_PRESETS = [
	{
		id: 'ollama',
		label: 'Ollama',
		baseUrl: 'http://localhost:11434/v1',
		requiresKey: false,
	},
	{
		id: 'lmstudio',
		label: 'LM Studio',
		baseUrl: 'http://localhost:1234/v1',
		requiresKey: false,
	},
	{
		id: 'openai',
		label: 'OpenAI',
		baseUrl: 'https://api.openai.com/v1',
		requiresKey: true,
	},
	{
		id: 'openrouter',
		label: 'OpenRouter',
		baseUrl: 'https://openrouter.ai/api/v1',
		requiresKey: true,
	},
	{
		id: 'groq',
		label: 'Groq',
		baseUrl: 'https://api.groq.com/openai/v1',
		requiresKey: true,
	},
] as const satisfies readonly ConnectionPreset[];

/**
 * A device-local inference connection (ADR-0060): one OpenAI-compatible server
 * plus the optional bearer key to reach it. The device holds a set of these (see
 * `createInferenceConnections`); the conversation's model selects which one serves
 * a turn. `apiKey` is sent as `Authorization: Bearer <key>`; absent means a keyless
 * local server (Ollama, LM Studio).
 *
 * This is the whole shape on purpose. Two widenings are deliberately deferred until
 * a real consumer exists, and both are non-breaking to add then:
 * - additive static `headers` (AI-gateway auth like Helicone's `Helicone-Auth` or
 *   Cloudflare's `cf-aig-authorization`; Azure's `api-key`; OpenRouter attribution),
 *   for the few static non-Bearer cases; and
 * - more than one injected transport, for non-static auth (Bedrock SigV4, Vertex
 *   OAuth refresh), which the caller composes as a {@link ResolvedConnection} and
 *   never becomes connection data.
 */
export type Connection = {
	baseUrl: string;
	apiKey?: string;
};

/** What one turn drives: the transport only. The model is paired by the caller. */
export type ResolvedConnection = {
	fetch: EngineFetch;
	baseURL: string;
};

/**
 * Resolve a connection to its transport. One branchless rule: attach the user's
 * key as `Authorization: Bearer` when present; a keyless local server gets a bare
 * fetch. It is never the Epicenter bearer (this resolver only ever sees a
 * third-party connection; the hosted transport is injected elsewhere, never built
 * here), so a custom turn cannot leak the Epicenter session (ADR-0053).
 *
 * `baseFetch` is the transport the Bearer wraps, defaulting to `globalThis.fetch`.
 * A native app passes its platform fetch: Whispering hands in Tauri's
 * `@tauri-apps/plugin-http` fetch so a desktop request reaches a third-party
 * provider from the native side, not the webview, where the provider's absent CORS
 * headers would block it. On the web the platform fetch is undefined, so the
 * default applies and behavior is unchanged.
 */
export function resolveConnection(
	connection: Connection,
	baseFetch: EngineFetch = globalThis.fetch.bind(globalThis),
): ResolvedConnection {
	const apiKey = connection.apiKey?.trim();
	if (!apiKey) return { fetch: baseFetch, baseURL: connection.baseUrl };
	const fetch: EngineFetch = (input, init) => {
		const headers = new Headers(init?.headers);
		headers.set('Authorization', `Bearer ${apiKey}`);
		return baseFetch(input, { ...init, headers });
	};
	return { fetch, baseURL: connection.baseUrl };
}

/**
 * Join a resolved `baseURL` to a wire subpath. The one place a path is appended,
 * so the seam is always exactly one slash, whichever producer built the
 * {@link ResolvedConnection} (this resolver, or the injected hosted transport).
 * The trailing-slash strip is the load-bearing case: a user pastes the base, so
 * `https://host/v1/` is real input. The leading-slash strip on the path is
 * defensive (every caller passes a bare literal like `'models'`); together they
 * mean no `//path` some servers 404. Every wire client (`complete`, `transcribe`,
 * `listModels`, the agent engine) routes through here so none re-derives the rule.
 *
 * Deliberately a string join, not `new URL(path, baseURL)`. WHATWG relative
 * resolution treats a base with no trailing slash as a file and drops its last
 * segment, so `new URL('chat/completions', 'https://api.openai.com/v1')` becomes
 * `https://api.openai.com/chat/completions` and silently eats the `/v1` every
 * preset carries (Groq's `/openai/v1` mangles worse). A query string or fragment
 * on the base is a non-goal: inference bases never carry one, and a provider that
 * needs query params (Azure's `?api-version`) is a different join altogether.
 */
export function joinUrl(baseURL: string, path: string): string {
	return `${baseURL.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export const ListModelsError = defineErrors({
	Unreachable: ({ cause }: { cause: unknown }) => ({
		message: `Could not reach the endpoint to list models: ${extractErrorMessage(cause)}`,
		cause,
	}),
	RequestFailed: ({ status }: { status: number }) => ({
		message: `The endpoint returned ${status} for /models.`,
		status,
	}),
	Malformed: () => ({
		message: 'The /models response was not an OpenAI { data: [{ id }] } list.',
	}),
});
export type ListModelsError = InferErrors<typeof ListModelsError>;

/**
 * List the model ids an OpenAI-compatible endpoint serves (ADR-0060). Best
 * effort: the caller degrades to the free-text model floor on any error. Reads
 * the OpenAI `{ data: [{ id }] }` shape, which Ollama, LM Studio, OpenRouter, and
 * OpenAI all return, so there is no per-provider branch and no `/api/tags`
 * fallback. `/v1/models` carries no capability tag, so the list mixes chat,
 * transcription, and embedding ids; filtering by capability is the caller's job.
 */
export async function listModels(
	resolved: ResolvedConnection,
): Promise<Result<string[], ListModelsError>> {
	const { data: response, error: requestError } = await tryAsync({
		try: () =>
			resolved.fetch(joinUrl(resolved.baseURL, 'models'), { method: 'GET' }),
		catch: (cause) => ListModelsError.Unreachable({ cause }),
	});
	if (requestError) return Err(requestError);
	if (!response.ok)
		return ListModelsError.RequestFailed({ status: response.status });

	const { data: body, error: parseError } = await tryAsync({
		try: () => response.json() as Promise<unknown>,
		catch: () => ListModelsError.Malformed(),
	});
	if (parseError) return Err(parseError);

	const ids = extractModelIds(body);
	if (!ids) return ListModelsError.Malformed();
	return Ok(ids);
}

/** Pull `id` strings out of an OpenAI `{ data: [{ id }] }` body, or null if the shape is wrong. */
function extractModelIds(body: unknown): string[] | null {
	if (typeof body !== 'object' || body === null || !('data' in body))
		return null;
	const { data } = body as { data: unknown };
	if (!Array.isArray(data)) return null;
	return data.flatMap((entry) =>
		typeof entry === 'object' &&
		entry !== null &&
		'id' in entry &&
		typeof (entry as { id: unknown }).id === 'string'
			? [(entry as { id: string }).id]
			: [],
	);
}
