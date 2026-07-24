/**
 * The Ark public delivery plane.
 *
 * One responsibility: resolve a public URL to a rebuildable projection object
 * in R2 and stream it. The Vault initiates Publish through an injected port;
 * an authenticated Epicenter publisher writes the objects. A publication
 * appears by writing R2 keys, never by redeploying this Worker.
 *
 * URL contract (the canonical artifact permalink is
 * `https://theark.so/braden/<artifact-slug>`):
 *
 *   /                              deploy-time home shell from static assets
 *   /<identity>[/<slug-or-facet>]         R2 `<path>/index.html`
 *   /<identity>/<artifact-slug>/<file>    R2 `<path>/<file>`
 *
 * A pretty segment is lowercase-hyphenated ([a-z0-9-]); a file segment must be
 * exactly one of the three generated media names (the closed vocabulary
 * below). Anything else is 404 before R2 is consulted, so traversal, encoded
 * surprises, or a stray bucket object never become public addresses. Trailing
 * slashes 308-redirect to the slashless canonical form.
 *
 * Only GET and HEAD exist. There is no write route, no auth, no API: the
 * bucket binding's write capability is deliberately unused (see the ADR).
 */

/**
 * One delivery-owned cache policy for every projection. Bytes at a key can be
 * regenerated (a theme rebuild rewrites disposable HTML, per the Vault's
 * ADR-0064), so nothing is `immutable`; a short shared TTL plus ETag
 * revalidation keeps rebuilds visible within minutes while edge caches absorb
 * repeat reads. The publisher owns content bytes and content-type; this
 * Worker owns delivery policy, so any publisher-set cache-control is
 * overwritten.
 */
const PROJECTION_CACHE_CONTROL = 'public, max-age=300, must-revalidate';

const PRETTY_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/**
 * The complete generated-media vocabulary. There is no general upload
 * pipeline, so no other filename can ever name a projection; refusing the
 * rest here means even a stray object at another key is publicly unroutable.
 * The publisher kernel derives every key it writes through
 * `resolveProjection`, so this set and the kernel's media list cannot drift
 * apart without publishing failing loudly.
 */
const MEDIA_FILES = new Set(['video.mp4', 'narration.mp3', 'cover.png']);
const RESERVED_IDENTITIES = new Set(['assets']);
// The Assets binding resolves by pathname. A deliberately non-public host
// prevents its internal fetch from re-entering this Worker's workers.dev or
// custom-domain route (Cloudflare error 1042).
const ASSET_ORIGIN = 'https://theark-assets.internal';

type ResolvedProjection = {
	key: string;
	/** True when the URL is a page address served from a `.../index.html` object. */
	isPage: boolean;
};

/**
 * Map a slashless pathname to its R2 object key, or null when the path can
 * never name a projection. Every artifact owns one public subtree: its page
 * lives at `/<identity>/<slug>` and its generated files live immediately
 * beneath that permalink. Percent-encoded aliases are refused so every
 * accepted pathname is already its one canonical ASCII spelling.
 */
export function resolveProjection(pathname: string): ResolvedProjection | null {
	if (!pathname.startsWith('/') || pathname.includes('%')) return null;
	const segments = pathname.slice(1).split('/');
	if (RESERVED_IDENTITIES.has(segments[0] ?? '')) return null;

	if (
		segments.length === 3 &&
		PRETTY_SEGMENT.test(segments[0] ?? '') &&
		PRETTY_SEGMENT.test(segments[1] ?? '') &&
		MEDIA_FILES.has(segments[2] ?? '')
	) {
		const key = segments.join('/');
		if (key.length > 1024) return null;
		return {
			key,
			isPage: false,
		};
	}

	if (
		(segments.length === 1 || segments.length === 2) &&
		segments.every((segment) => PRETTY_SEGMENT.test(segment))
	) {
		const key = `${segments.join('/')}/index.html`;
		if (key.length > 1024) return null;
		return {
			key,
			isPage: true,
		};
	}

	return null;
}

function projectionHeaders(
	object: R2Object,
	{ isPage }: ResolvedProjection,
): Headers {
	const headers = new Headers();
	object.writeHttpMetadata(headers);
	if (!headers.has('content-type')) {
		headers.set(
			'content-type',
			isPage ? 'text/html; charset=utf-8' : 'application/octet-stream',
		);
	}
	headers.set('etag', object.httpEtag);
	headers.set('cache-control', PROJECTION_CACHE_CONTROL);
	headers.set(
		'content-security-policy',
		"default-src 'none'; style-src 'self'; img-src 'self' data:; media-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	);
	headers.set('x-content-type-options', 'nosniff');
	return headers;
}

async function serveNotFound(request: Request, env: Env): Promise<Response> {
	const page = await env.ASSETS.fetch(
		new Request(`${ASSET_ORIGIN}/not-found.html`, {
			method: request.method,
		}),
	);
	return new Response(request.method === 'HEAD' ? null : page.body, {
		status: 404,
		headers: {
			'content-type': 'text/html; charset=utf-8',
			// Never cache absence: the moment the publisher writes the object,
			// the address must start serving it.
			'cache-control': 'no-store',
			'x-content-type-options': 'nosniff',
		},
	});
}

export async function handleRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return new Response('Method Not Allowed', {
			status: 405,
			headers: { allow: 'GET, HEAD' },
		});
	}

	const url = new URL(request.url);

	// The home shell is a deploy-time design asset, not a projection: before
	// any artifact exists, R2 is empty but the network root must still answer.
	if (url.pathname === '/') {
		return env.ASSETS.fetch(
			new Request(`${ASSET_ORIGIN}/home.html`, {
				method: request.method,
			}),
		);
	}

	if (url.pathname.endsWith('/')) {
		const canonical = new URL(url);
		// The Ark is HTTPS-only. Cloudflare may present an internal `http:` URL
		// to the Worker even when the public request arrived over TLS, so never
		// let that implementation detail become a downgrade redirect.
		canonical.protocol = 'https:';
		canonical.pathname = url.pathname.replace(/\/+$/, '') || '/';
		return Response.redirect(canonical.toString(), 308);
	}

	const projection = resolveProjection(url.pathname);
	if (!projection) return serveNotFound(request, env);

	if (request.method === 'HEAD') {
		const object = await env.PROJECTIONS.head(projection.key);
		if (!object) return serveNotFound(request, env);
		const headers = projectionHeaders(object, projection);
		headers.set('content-length', String(object.size));
		return new Response(null, { status: 200, headers });
	}

	const object = await env.PROJECTIONS.get(projection.key, {
		onlyIf: request.headers,
	});
	if (!object) return serveNotFound(request, env);

	const headers = projectionHeaders(object, projection);

	if (!('body' in object)) {
		// A precondition from `onlyIf` failed. Reads send If-None-Match or
		// If-Modified-Since (304); anything stricter is a 412.
		const wantsNotModified =
			request.headers.has('if-none-match') ||
			request.headers.has('if-modified-since');
		return new Response(null, {
			status: wantsNotModified ? 304 : 412,
			headers,
		});
	}

	headers.set('content-length', String(object.size));
	return new Response(object.body, { status: 200, headers });
}

export default {
	fetch: handleRequest,
} satisfies ExportedHandler<Env>;
