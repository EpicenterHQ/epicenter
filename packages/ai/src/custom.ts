import {
	type Endpoint,
	type EndpointModel,
	guessCapabilities,
	openAiCompatible,
} from './endpoint.js';

/**
 * An OpenAI-compatible server the person named: a provider they hold a key
 * for, or a server on another machine. `models` are the ids they chose or a
 * discovery found, each able to do what its id suggests unless it says.
 *
 * On the desktop the app passes the shell's `fetch`, which adds the key the
 * shell keeps for this endpoint, and gives no `key`, so the key never
 * reaches the page. On the web the page holds the key and plain fetch sends
 * it.
 */
export function custom({
	id,
	name,
	baseUrl,
	key,
	fetch,
	models = [],
}: {
	/** Defaults to `baseUrl`. */
	id?: string;
	/** Defaults to the base URL's host. */
	name?: string;
	baseUrl: string;
	key?: string;
	fetch?: (input: string, init?: RequestInit) => Promise<Response>;
	models?: readonly (string | EndpointModel)[];
}): Endpoint {
	const listed = models.map((model) =>
		typeof model === 'string'
			? { id: model, can: guessCapabilities(model) }
			: model,
	);
	return openAiCompatible({
		id: id ?? baseUrl,
		name: name ?? hostOf(baseUrl),
		source: 'custom',
		baseUrl,
		key,
		fetch,
		models: () => listed,
	});
}

function hostOf(baseUrl: string) {
	try {
		return new URL(baseUrl).host;
	} catch {
		return baseUrl;
	}
}
