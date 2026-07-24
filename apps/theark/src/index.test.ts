/**
 * The Ark Public Delivery Plane Tests
 *
 * Pure fetch-handler tests over a stub Env. The stub R2 mirrors the binding
 * semantics this Worker actually relies on (onlyIf preconditions return a
 * body-less object), so these tests pin the
 * routing, key-mapping, and streaming-header invariants without Miniflare.
 *
 * Key behaviors:
 * - URL to R2 key mapping: each artifact owns one page-and-media subtree
 * - Only the closed media vocabulary (video.mp4, narration.mp3, cover.png)
 *   names a file projection; every other filename is 404 before touching R2
 * - Hostile paths (traversal, encoding, uppercase) 404 before touching R2
 * - Trailing slashes 308-redirect to the slashless canonical URL
 * - Only GET and HEAD are allowed; conditional reads behave
 * - The Worker owns cache policy; the publisher owns bytes and content-type
 */
import { describe, expect, test } from 'bun:test';

import { handleRequest, resolveProjection } from './index';

type StoredObject = {
	data: string;
	contentType?: string;
	cacheControl?: string;
};

function setup(objects: Record<string, StoredObject> = {}) {
	const requestedKeys: string[] = [];

	const makeMeta = (key: string, stored: StoredObject) => ({
		key,
		// Test payloads are ASCII, so string length is byte length.
		size: stored.data.length,
		httpEtag: `"etag-${key}"`,
		writeHttpMetadata(headers: Headers) {
			if (stored.contentType) headers.set('content-type', stored.contentType);
			if (stored.cacheControl)
				headers.set('cache-control', stored.cacheControl);
		},
	});

	const env = {
		PROJECTIONS: {
			async head(key: string) {
				requestedKeys.push(key);
				const stored = objects[key];
				return stored ? makeMeta(key, stored) : null;
			},
			async get(key: string, options?: { onlyIf?: Headers }) {
				requestedKeys.push(key);
				const stored = objects[key];
				if (!stored) return null;
				const etag = `"etag-${key}"`;

				const ifNoneMatch = options?.onlyIf?.get('if-none-match');
				const ifMatch = options?.onlyIf?.get('if-match');
				if (ifNoneMatch === etag || (ifMatch && ifMatch !== etag)) {
					return makeMeta(key, stored);
				}

				return {
					...makeMeta(key, stored),
					body: new Response(stored.data).body,
				};
			},
		},
		ASSETS: {
			async fetch(input: Request | { toString(): string } | string) {
				const url = new URL(
					input instanceof Request ? input.url : String(input),
				);
				const shells: Record<string, string> = {
					'/home.html': '<home shell>',
					'/not-found.html': '<not-found shell>',
				};
				const body = shells[url.pathname];
				if (body === undefined)
					return new Response('asset missing', { status: 404 });
				const method = input instanceof Request ? input.method : 'GET';
				return new Response(method === 'HEAD' ? null : body, {
					status: 200,
					headers: { 'content-type': 'text/html; charset=utf-8' },
				});
			},
		},
	};

	const fetch = (path: string, init?: RequestInit) =>
		handleRequest(new Request(`https://theark.so${path}`, init), env as Env);
	return { fetch, requestedKeys, env: env as Env };
}

// ============================================================================
// Key resolution
// ============================================================================

describe('resolveProjection', () => {
	test('artifact permalink maps to its index.html object', () => {
		expect(resolveProjection('/braden/first-artifact')).toEqual({
			key: 'braden/first-artifact/index.html',
			isPage: true,
		});
	});

	test('single-segment person route maps to its index.html object', () => {
		expect(resolveProjection('/braden')).toEqual({
			key: 'braden/index.html',
			isPage: true,
		});
	});

	test('the closed media vocabulary resolves beside its human-readable permalink', () => {
		for (const file of ['video.mp4', 'narration.mp3', 'cover.png']) {
			expect(resolveProjection(`/braden/first-artifact/${file}`)).toEqual({
				key: `braden/first-artifact/${file}`,
				isPage: false,
			});
		}
	});

	test('filenames outside the closed media vocabulary are refused', () => {
		for (const file of [
			'blob.bin',
			'notes.txt',
			'cover.jpg',
			'video.mp4.bak',
			'poster.png',
		]) {
			expect(resolveProjection(`/braden/first-artifact/${file}`)).toBeNull();
		}
	});

	test('rejects uppercase, underscores, dotfiles, double dots, and empty segments', () => {
		expect(resolveProjection('/Braden/foo')).toBeNull();
		expect(resolveProjection('/braden/some_slug')).toBeNull();
		expect(resolveProjection('/braden/first-artifact/.hidden')).toBeNull();
		expect(resolveProjection('/braden/first-artifact/a..b')).toBeNull();
		expect(resolveProjection('/braden//foo')).toBeNull();
		expect(resolveProjection('/assets/theark')).toBeNull();
	});

	test('rejects route file aliases, extensionless outputs, and arbitrary depth', () => {
		expect(resolveProjection('/braden/first-artifact/index.html')).toBeNull();
		expect(resolveProjection('/braden/first-artifact/extra')).toBeNull();
		expect(resolveProjection('/braden/first-artifact/video/mp4')).toBeNull();
		expect(resolveProjection('/_artifacts/anything/video.mp4')).toBeNull();
	});

	test('rejects percent-encoded aliases', () => {
		expect(resolveProjection('/braden/%zz')).toBeNull();
		expect(resolveProjection('/br%61den/first-artifact')).toBeNull();
	});

	test('rejects syntactically valid paths that exceed the R2 key limit', () => {
		expect(resolveProjection(`/braden/${'a'.repeat(1010)}`)).toBeNull();
		expect(
			resolveProjection(`/braden/${'a'.repeat(1010)}/video.mp4`),
		).toBeNull();
	});
});

// ============================================================================
// Methods, root, and redirects
// ============================================================================

test('POST, PUT, and DELETE get 405 with an Allow header', async () => {
	const { fetch } = setup();
	for (const method of ['POST', 'PUT', 'DELETE']) {
		const response = await fetch('/braden/foo', { method });
		expect(response.status).toBe(405);
		expect(response.headers.get('allow')).toBe('GET, HEAD');
	}
});

test('root serves the deploy-time home shell', async () => {
	const { fetch } = setup();
	const response = await fetch('/');
	expect(response.status).toBe(200);
	expect(await response.text()).toBe('<home shell>');
});

test('deploy-time shell filenames are not alternate public page URLs', async () => {
	const { fetch, requestedKeys } = setup();
	for (const path of ['/home.html', '/not-found.html']) {
		const response = await fetch(path);
		expect(response.status).toBe(404);
	}
	expect(requestedKeys).toEqual([]);
});

test('HEAD on root returns the shell headers without a body', async () => {
	const { fetch } = setup();
	const response = await fetch('/', { method: 'HEAD' });
	expect(response.status).toBe(200);
	expect(await response.text()).toBe('');
});

test('trailing slash 308-redirects to the slashless canonical URL', async () => {
	const { fetch, requestedKeys } = setup();
	const response = await fetch('/braden/foo/');
	expect(response.status).toBe(308);
	expect(response.headers.get('location')).toBe('https://theark.so/braden/foo');
	expect(requestedKeys).toEqual([]);
});

test('canonical redirects stay HTTPS when Cloudflare presents an internal HTTP URL', async () => {
	const { env, requestedKeys } = setup();
	const response = await handleRequest(
		new Request('http://theark.epicenter.workers.dev/braden/foo/'),
		env,
	);
	expect(response.status).toBe(308);
	expect(response.headers.get('location')).toBe(
		'https://theark.epicenter.workers.dev/braden/foo',
	);
	expect(requestedKeys).toEqual([]);
});

test('encoded traversal 404s without ever touching the bucket', async () => {
	// Plain `%2e%2e` is normalized away by the WHATWG URL parser before the
	// Worker runs; double encoding survives parsing and must die in the
	// allowlist, never as an R2 key.
	const { fetch, requestedKeys } = setup();
	const doubleEncoded = await fetch('/braden/%252e%252e/secrets');
	expect(doubleEncoded.status).toBe(404);
	const encodedSlash = await fetch('/braden%2f..%2fsecrets');
	expect(encodedSlash.status).toBe(404);
	expect(requestedKeys).toEqual([]);
});

// ============================================================================
// Projection reads
// ============================================================================

const PAGE_KEY = 'braden/first-artifact/index.html';

test('published page serves with html content-type, etag, and delivery cache policy', async () => {
	const { fetch } = setup({
		[PAGE_KEY]: { data: '<article>frozen words</article>' },
	});
	const response = await fetch('/braden/first-artifact');
	expect(response.status).toBe(200);
	expect(await response.text()).toBe('<article>frozen words</article>');
	expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
	expect(response.headers.get('etag')).toBe(`"etag-${PAGE_KEY}"`);
	expect(response.headers.get('cache-control')).toBe(
		'public, max-age=300, must-revalidate',
	);
	expect(response.headers.get('content-security-policy')).toContain(
		"default-src 'none'",
	);
});

test('query strings do not change the resolved object', async () => {
	const { fetch } = setup({ [PAGE_KEY]: { data: 'page' } });
	const response = await fetch('/braden/first-artifact?utm_source=x');
	expect(response.status).toBe(200);
	expect(await response.text()).toBe('page');
});

test('publisher-set cache-control is overwritten by the delivery policy', async () => {
	const { fetch } = setup({
		[PAGE_KEY]: {
			data: 'page',
			cacheControl: 'public, max-age=31536000, immutable',
		},
	});
	const response = await fetch('/braden/first-artifact');
	expect(response.headers.get('cache-control')).toBe(
		'public, max-age=300, must-revalidate',
	);
});

test('missing projection serves the not-found shell with no-store', async () => {
	const { fetch } = setup();
	const response = await fetch('/braden/unpublished');
	expect(response.status).toBe(404);
	expect(await response.text()).toBe('<not-found shell>');
	expect(response.headers.get('cache-control')).toBe('no-store');
});

test('HEAD on a missing projection has a 404 status and empty body', async () => {
	const { fetch } = setup();
	const response = await fetch('/braden/unpublished', { method: 'HEAD' });
	expect(response.status).toBe(404);
	expect(await response.text()).toBe('');
});

test('media without stored content-type falls back to octet-stream', async () => {
	const key = 'braden/first-artifact/video.mp4';
	const { fetch } = setup({ [key]: { data: 'binary' } });
	const response = await fetch('/braden/first-artifact/video.mp4');
	expect(response.headers.get('content-type')).toBe('application/octet-stream');
});

test('media outside the closed vocabulary 404s even when a stray object exists', async () => {
	const { fetch, requestedKeys } = setup({
		'braden/first-artifact/blob.bin': { data: 'stray' },
	});
	const response = await fetch('/braden/first-artifact/blob.bin');
	expect(response.status).toBe(404);
	expect(requestedKeys).toEqual([]);
});

test('stored content-type wins over the fallback', async () => {
	const key = 'braden/first-artifact/cover.png';
	const { fetch } = setup({
		[key]: { data: 'png-bytes', contentType: 'image/png' },
	});
	const response = await fetch('/braden/first-artifact/cover.png');
	expect(response.headers.get('content-type')).toBe('image/png');
});

test('HEAD on a projection reports size without a body', async () => {
	const { fetch } = setup({ [PAGE_KEY]: { data: '0123456789' } });
	const response = await fetch('/braden/first-artifact', { method: 'HEAD' });
	expect(response.status).toBe(200);
	expect(response.headers.get('content-length')).toBe('10');
	expect(await response.text()).toBe('');
});

// ============================================================================
// Conditional reads
// ============================================================================

test('matching If-None-Match returns 304 with the etag and no body', async () => {
	const { fetch } = setup({ [PAGE_KEY]: { data: 'page' } });
	const response = await fetch('/braden/first-artifact', {
		headers: { 'if-none-match': `"etag-${PAGE_KEY}"` },
	});
	expect(response.status).toBe(304);
	expect(response.headers.get('etag')).toBe(`"etag-${PAGE_KEY}"`);
	expect(await response.text()).toBe('');
});

test('failing If-Match returns 412', async () => {
	const { fetch } = setup({ [PAGE_KEY]: { data: 'page' } });
	const response = await fetch('/braden/first-artifact', {
		headers: { 'if-match': '"some-other-etag"' },
	});
	expect(response.status).toBe(412);
});
