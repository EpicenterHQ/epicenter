/**
 * Publisher kernel tests.
 *
 * An in-memory store proves the whole authenticated orchestration without
 * credentials or production resources: atomic reserve-first ownership keyed
 * on artifact id plus expression digest, route-last activation, idempotent
 * retry, collision and changed-expression refusal, and the creation race.
 * The final tests close the seam end to end: bytes
 * written by the kernel are served back through the delivery Worker's real
 * `handleRequest` over the same store.
 */
import { describe, expect, test } from 'bun:test';

import { handleRequest, resolveProjection } from './index';
import {
	type ArkObjectStore,
	type ArkPublication,
	publishProjection,
} from './publish';

type StoredObject = { value: Uint8Array; contentType: string };

function memoryStore() {
	const objects = new Map<string, StoredObject>();
	const putOrder: string[] = [];
	const store: ArkObjectStore = {
		async get(key) {
			return objects.get(key)?.value ?? null;
		},
		async put(key, value, { contentType }) {
			putOrder.push(key);
			objects.set(key, { value, contentType });
		},
		// Mirrors R2 `onlyIf: { etagDoesNotMatch: '*' }`: an existing key makes
		// the write a no-op that resolves unsuccessful.
		async createExclusive(key, value, { contentType }) {
			if (objects.has(key)) return false;
			putOrder.push(key);
			objects.set(key, { value, contentType });
			return true;
		},
	};
	return { store, objects, putOrder };
}

const bytes = (text: string) => new TextEncoder().encode(text);
const DIGEST_A = 'ab'.repeat(32);
const DIGEST_B = 'cd'.repeat(32);
const MARKER_KEY = 'braden/first-artifact/.artifact';

const publication = (
	overrides: Partial<ArkPublication> = {},
): ArkPublication => ({
	artifactId: '01880000-0000-7000-8000-000000000001',
	expressionDigest: DIGEST_A,
	page: {
		identity: 'braden',
		slug: 'first-artifact',
		publishedOn: '2026-07-20',
		body: '# First Artifact\n\nFrozen words.',
	},
	...overrides,
});

// ============================================================================
// Ordering, ownership, and idempotency
// ============================================================================

describe('publishProjection', () => {
	test('reserves first, writes media, activates the page last', async () => {
		const { store, objects, putOrder } = memoryStore();
		const result = await publishProjection(store, {
			...publication(),
			files: { video: bytes('v'), narration: bytes('n'), cover: bytes('c') },
		});

		expect(putOrder).toEqual([
			MARKER_KEY,
			'braden/first-artifact/video.mp4',
			'braden/first-artifact/narration.mp3',
			'braden/first-artifact/cover.png',
			'braden/first-artifact/index.html',
		]);
		expect(result.url).toBe('https://theark.so/braden/first-artifact');
		expect(result.publishedOn).toBe('2026-07-20');
		expect(objects.get('braden/first-artifact/video.mp4')?.contentType).toBe(
			'video/mp4',
		);
		expect(
			objects.get('braden/first-artifact/narration.mp3')?.contentType,
		).toBe('audio/mpeg');
		expect(objects.get('braden/first-artifact/cover.png')?.contentType).toBe(
			'image/png',
		);
		expect(objects.get('braden/first-artifact/index.html')?.contentType).toBe(
			'text/html; charset=utf-8',
		);
	});

	test('the marker records artifact id and expression digest', async () => {
		const { store, objects } = memoryStore();
		await publishProjection(store, publication());
		const marker = JSON.parse(
			new TextDecoder().decode(objects.get(MARKER_KEY)?.value),
		);
		expect(marker).toEqual({
			artifact: '01880000-0000-7000-8000-000000000001',
			expression: DIGEST_A,
			publishedOn: '2026-07-20',
		});
	});

	test('a text-only publication writes exactly the marker and the page', async () => {
		const { store, putOrder } = memoryStore();
		await publishProjection(store, publication());
		expect(putOrder).toEqual([MARKER_KEY, 'braden/first-artifact/index.html']);
	});

	test('republishing the same artifact and expression converges without re-reserving', async () => {
		const { store, putOrder } = memoryStore();
		await publishProjection(store, publication());
		const retry = await publishProjection(store, publication());
		expect(retry.publishedOn).toBe('2026-07-20');
		// The page was rewritten (theme rebuilds stay free); the marker was not.
		expect(putOrder.filter((key) => key === MARKER_KEY)).toHaveLength(1);
		expect(putOrder.filter((key) => key.endsWith('index.html'))).toHaveLength(
			2,
		);
	});

	test('an exact retry preserves the first reservation date', async () => {
		const { store, objects } = memoryStore();
		await publishProjection(store, publication());
		const retry = await publishProjection(
			store,
			publication({
				page: { ...publication().page, publishedOn: '2026-07-21' },
			}),
		);
		expect(retry.publishedOn).toBe('2026-07-20');
		expect(
			new TextDecoder().decode(
				objects.get('braden/first-artifact/index.html')?.value,
			),
		).toContain('datetime="2026-07-20"');
	});

	test('a different artifact can never take over a frozen permalink', async () => {
		const { store, putOrder } = memoryStore();
		await publishProjection(store, publication());
		const writesBefore = putOrder.length;
		await expect(
			publishProjection(
				store,
				publication({ artifactId: '01880000-0000-7000-8000-000000000002' }),
			),
		).rejects.toThrow('already published by another artifact');
		expect(putOrder).toHaveLength(writesBefore);
	});

	test('the same artifact with a different frozen expression is refused', async () => {
		const { store, putOrder } = memoryStore();
		await publishProjection(store, publication());
		const writesBefore = putOrder.length;
		await expect(
			publishProjection(store, publication({ expressionDigest: DIGEST_B })),
		).rejects.toThrow('different frozen expression');
		expect(putOrder).toHaveLength(writesBefore);
	});

	test('refuses a malformed expression digest before touching the store', async () => {
		const { store, putOrder } = memoryStore();
		for (const expressionDigest of [
			'',
			'not-hex',
			'AB'.repeat(32),
			'ab'.repeat(31),
		]) {
			await expect(
				publishProjection(store, publication({ expressionDigest })),
			).rejects.toThrow('64 lowercase hex');
		}
		expect(putOrder).toEqual([]);
	});

	test('refuses a malformed publication date before touching the store', async () => {
		const { store, putOrder } = memoryStore();
		await expect(
			publishProjection(store, {
				...publication(),
				page: { ...publication().page, publishedOn: 'someday' },
			}),
		).rejects.toThrow('YYYY-MM-DD');
		expect(putOrder).toEqual([]);
	});

	test('refuses to publish over an unrecognized ownership marker', async () => {
		const { store, objects, putOrder } = memoryStore();
		objects.set(MARKER_KEY, {
			value: bytes('legacy-or-corrupt'),
			contentType: 'text/plain',
		});
		await expect(publishProjection(store, publication())).rejects.toThrow(
			'unrecognized ownership marker',
		);
		expect(putOrder).toEqual([]);
	});

	test('refuses addresses the delivery Worker would refuse to serve', async () => {
		const { store, putOrder } = memoryStore();
		for (const [identity, slug] of [
			['Braden', 'ok'],
			['braden', 'Not_A_Slug'],
			['assets', 'theark'],
		] as const) {
			await expect(
				publishProjection(store, {
					...publication(),
					page: { ...publication().page, identity, slug },
				}),
			).rejects.toThrow('not a servable artifact address');
		}
		expect(putOrder).toEqual([]);
	});

	test('the ownership marker is publicly unroutable by construction', () => {
		expect(resolveProjection('/braden/first-artifact/.artifact')).toBeNull();
	});
});

// ============================================================================
// The reservation race
// ============================================================================

/**
 * A store where a competitor lands its marker between this publisher's
 * absence check and its atomic create, so `createExclusive` must lose.
 */
function racingStore(competitorMarker: object) {
	const { store, objects, putOrder } = memoryStore();
	const raced: ArkObjectStore = {
		...store,
		async createExclusive(key, value, options) {
			if (!objects.has(key)) {
				objects.set(key, {
					value: bytes(JSON.stringify(competitorMarker)),
					contentType: 'application/json',
				});
				return false;
			}
			return store.createExclusive(key, value, options);
		},
	};
	return { store: raced, objects, putOrder };
}

describe('reservation race', () => {
	test('losing the atomic create to another artifact refuses with zero public writes', async () => {
		const { store, putOrder } = racingStore({
			artifact: '01880000-0000-7000-8000-00000000beef',
			expression: DIGEST_B,
			publishedOn: '2026-07-20',
		});
		await expect(publishProjection(store, publication())).rejects.toThrow(
			'already published by another artifact',
		);
		expect(putOrder).toEqual([]);
	});

	test('losing the atomic create to our own duplicate retry converges', async () => {
		const { store, putOrder } = racingStore({
			artifact: '01880000-0000-7000-8000-000000000001',
			expression: DIGEST_A,
			publishedOn: '2026-07-19',
		});
		const result = await publishProjection(store, publication());
		expect(result.publishedOn).toBe('2026-07-19');
		expect(putOrder).toEqual(['braden/first-artifact/index.html']);
	});

	test('createExclusive never overwrites an existing key', async () => {
		const { store, objects } = memoryStore();
		await store.createExclusive(MARKER_KEY, bytes('first'), {
			contentType: 'application/json',
		});
		const second = await store.createExclusive(MARKER_KEY, bytes('second'), {
			contentType: 'application/json',
		});
		expect(second).toBe(false);
		expect(new TextDecoder().decode(objects.get(MARKER_KEY)?.value)).toBe(
			'first',
		);
	});
});

// ============================================================================
// End to end: kernel writes, the public Worker serves
// ============================================================================

/** Adapt the in-memory store to the R2 read surface handleRequest uses. */
function workerEnvOver(objects: Map<string, StoredObject>) {
	const meta = (key: string, stored: StoredObject) => ({
		key,
		size: stored.value.length,
		httpEtag: `"etag-${key}"`,
		writeHttpMetadata(headers: Headers) {
			headers.set('content-type', stored.contentType);
		},
	});
	return {
		PROJECTIONS: {
			async head(key: string) {
				const stored = objects.get(key);
				return stored ? meta(key, stored) : null;
			},
			async get(key: string) {
				const stored = objects.get(key);
				return stored
					? { ...meta(key, stored), body: new Response(stored.value).body }
					: null;
			},
		},
		ASSETS: {
			async fetch() {
				return new Response('<not-found shell>', {
					status: 200,
					headers: { 'content-type': 'text/html; charset=utf-8' },
				});
			},
		},
	} as unknown as Env;
}

describe('publish-to-read round trip', () => {
	test('a published artifact serves through the delivery plane under its CSP', async () => {
		const { store, objects } = memoryStore();
		const { url } = await publishProjection(store, {
			...publication({
				page: {
					identity: 'braden',
					slug: 'first-artifact',
					subtitle: 'The words as released',
					publishedOn: '2026-07-20',
					resonant: true,
					body: '# First Artifact\n\nFrozen words with a [link](https://example.com).\n\n> Kept exactly.',
				},
			}),
			files: { video: bytes('vvv'), cover: bytes('ccc') },
		});
		const env = workerEnvOver(objects);

		const pageResponse = await handleRequest(new Request(url), env);
		expect(pageResponse.status).toBe(200);
		expect(pageResponse.headers.get('content-type')).toBe(
			'text/html; charset=utf-8',
		);
		expect(pageResponse.headers.get('content-security-policy')).toContain(
			"default-src 'none'",
		);
		const html = await pageResponse.text();
		expect(html).toContain('<h1>First Artifact</h1>');
		expect(html).toContain('<a href="https://example.com">link</a>');
		expect(html).toContain('poster="/braden/first-artifact/cover.png"');

		const video = await handleRequest(new Request(`${url}/video.mp4`), env);
		expect(video.status).toBe(200);
		expect(video.headers.get('content-type')).toBe('video/mp4');
		expect(await video.text()).toBe('vvv');
	});

	test('the ownership marker never serves publicly even though it exists', async () => {
		const { store, objects } = memoryStore();
		const { url } = await publishProjection(store, publication());
		expect(objects.has(MARKER_KEY)).toBe(true);
		const response = await handleRequest(
			new Request(`${url}/.artifact`),
			workerEnvOver(objects),
		);
		expect(response.status).toBe(404);
	});
});
