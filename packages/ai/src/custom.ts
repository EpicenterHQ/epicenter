import {
	type Endpoint,
	type EndpointKey,
	type EndpointModel,
	guessCapabilities,
	openAiCompatible,
} from './endpoint.js';

/**
 * An OpenAI-compatible server the person named: a provider they hold a key
 * for, or a server on another machine. `models` are the ids they chose or a
 * discovery found, each able to do what its id suggests unless it says.
 *
 * `key` may be read as each request leaves (the desktop's Keychain), and
 * `fetch` is the page's own unless the app passes another (the desktop's
 * Tauri HTTP plugin, which no endpoint's CORS refuses).
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
	key?: EndpointKey;
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
