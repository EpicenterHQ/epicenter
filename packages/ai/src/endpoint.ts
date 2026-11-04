/**
 * An endpoint is a place that answers OpenAI-compatible requests: Epicenter's
 * hosted inference, a provider the person holds a key for, a server on this
 * computer, or an engine inside the app. It is a value, not a connection: an
 * id, a `fetch` rooted at the endpoint, and the models it offers now
 * (ADR-0757).
 *
 * Every HTTP endpoint is one implementation, `openAiCompatible`, configured by
 * a base URL, an optional key, and the `fetch` that sends it. `hosted`,
 * `custom` and `localServers` are configurations of it, and `openAi` merges
 * any number of endpoints into one value.
 */

/** What a model can do, named by the request that does it. */
export type Capability = 'chat' | 'transcribe' | 'embed';

/** Where a model runs, from the person's point of view. */
export type Source = 'local' | 'hosted' | 'custom';

/** A model as its endpoint declares it. */
export type EndpointModel = {
	id: string;
	can: readonly Capability[];
	/** A display name, when the id is not one. */
	label?: string;
};

/**
 * The Fetch API's call shape, rooted at an endpoint: `path` is relative to
 * the endpoint (`chat/completions`, `audio/transcriptions`, `models`), and
 * the endpoint decides where it goes and with what credential.
 */
export type EndpointFetch = (
	path: string,
	init?: RequestInit,
) => Promise<Response>;

export type Endpoint = {
	/** Unique among the endpoints an app merges; a model choice names it. */
	id: string;
	/** What a person calls it: `Epicenter`, a provider's name, `Ollama`. */
	name: string;
	source: Source;
	/**
	 * Where its requests go, for an endpoint reached over HTTP: the base URL
	 * every path is under. Absent for an engine inside the app and for an
	 * endpoint that cannot send now (hosted while signed out). An app shows it,
	 * and compares it to tell an endpoint that moved from one that did not.
	 */
	baseUrl?: string;
	fetch: EndpointFetch;
	/** The models usable now. Never blocks; an endpoint that probes answers what it last found. */
	models(): readonly EndpointModel[];
	/** Called when `models()` may answer differently. Absent when it never changes. */
	subscribe?(listener: () => void): () => void;
	/** Look again for models, such as when a picker opens. Never blocks. */
	refresh?(): void;
};

/**
 * What a model id says it can do, for a server that lists only ids. An id
 * naming embeddings or a speech recognizer does that; any other id chats.
 */
export function guessCapabilities(id: string): Capability[] {
	const name = id.toLowerCase();
	if (name.includes('embed')) return ['embed'];
	if (name.includes('whisper') || name.includes('transcribe'))
		return ['transcribe'];
	return ['chat'];
}

/** A base URL an endpoint may send to: http or https, no credentials, query, or fragment. */
function baseUrlOf(value: string): string {
	const url = new URL(value);
	if (
		!['http:', 'https:'].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw new Error(`Not an endpoint base URL: ${value}`);
	return url.href.replace(/\/+$/, '');
}

/** `baseUrl` as an endpoint names it: canonical when it reads, else as given. */
function shownBaseUrl(value: string): string {
	try {
		return baseUrlOf(value);
	} catch {
		return value.trim();
	}
}

/**
 * An answer that refused the request, with `key` replaced wherever its body
 * repeats it, so a provider that echoes the key cannot carry it into an error
 * the app shows or logs. Any other answer passes through unread.
 */
async function withoutKey(response: Response, key: string): Promise<Response> {
	if (response.ok) return response;
	const text = await response.text();
	return new Response(text.split(key).join('[key removed]'), {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

/**
 * An OpenAI-compatible HTTP endpoint at `baseUrl`. Each request goes to a
 * path under it and never elsewhere, through `fetch` (the page's own by
 * default; on the desktop, the shell's), with `key` as a bearer token when
 * there is one. Cookies and an `Authorization` header from the caller are
 * dropped, a redirect fails the request, and a refusal's body never repeats
 * the key.
 */
export function openAiCompatible({
	id,
	name,
	source,
	baseUrl,
	key,
	fetch = globalThis.fetch.bind(globalThis),
	models,
}: {
	id: string;
	name: string;
	source: Source;
	baseUrl: string;
	key?: string;
	fetch?: (input: string, init?: RequestInit) => Promise<Response>;
	models: () => readonly EndpointModel[];
}): Endpoint {
	const bearer = key?.trim();
	return {
		id,
		name,
		source,
		baseUrl: shownBaseUrl(baseUrl),
		models,
		// A saved base URL that does not parse fails each request, not the app.
		async fetch(path, init) {
			const base = baseUrlOf(baseUrl);
			const url = new URL(path, `${base}/`).href;
			if (!url.startsWith(`${base}/`))
				throw new Error(`A request cannot leave its endpoint: ${path}`);
			const headers = new Headers(init?.headers);
			headers.delete('authorization');
			headers.delete('cookie');
			if (bearer) headers.set('authorization', `Bearer ${bearer}`);
			const response = await fetch(url, {
				...init,
				headers,
				credentials: 'omit',
				redirect: 'error',
			});
			return bearer ? withoutKey(response, bearer) : response;
		},
	};
}
