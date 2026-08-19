/**
 * The `local-books app` HTTP surface: the Hono `/api` app driven with
 * `app.request()`, plus the loopback Host-check handler. Proves the security
 * gates (bearer required, single-use session exchange, read-only refuses the
 * write, DNS-rebinding Host check) and the read happy paths against a seeded
 * mirror, without booting `Bun.serve` or touching QuickBooks.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { createRequestHandler } from '../src/app.ts';
import { type OpenQbClient, QbAccessError } from '../src/books/qb-access.ts';
import { booksDbFile, openBooksDb } from '../src/db.ts';
import { entityDef } from '../src/entities.ts';
import { createApiApp } from '../src/http/api.ts';
import { makeConfig, tempDir } from './helpers.ts';

const REALM = 'realm-1';
const BOOT = 'bootstrap-token-abc';

/** An opener that always refuses: report/recategorize live paths are out of scope
 * here (their cores are tested directly), so no test reaches a real QB call. */
const refusingOpenQb: OpenQbClient = async () =>
	QbAccessError.NotAuthenticated({ realmId: 'test-realm' });

/**
 * Seed a mirror with two invoices and one purchase carrying an expense line, and
 * record the realm cursor a clean full pull would have written. Without that
 * cursor the artifact is honestly `building`, and the app surfaces read a corpus
 * a full pull has finished.
 */
function seedMirror(dataDir: string): void {
	const mirror = booksDbFile(dataDir, REALM);
	const db = openBooksDb(mirror);
	const syncedAt = '2026-01-01T00:00:00Z';
	db.ingest(
		[
			{
				def: entityDef('Invoice'),
				objects: [
					{
						Id: 'i1',
						DocNumber: '1001',
						TxnDate: '2026-01-01',
						TotalAmt: 100,
						MetaData: { LastUpdatedTime: '2026-01-01T00:00:00Z' },
					},
					{
						Id: 'i2',
						DocNumber: '1002',
						TxnDate: '2026-01-02',
						TotalAmt: 250,
						MetaData: { LastUpdatedTime: '2026-01-02T00:00:00Z' },
					},
				],
			},
			{
				def: entityDef('Purchase'),
				objects: [
					{
						Id: 'p1',
						TxnDate: '2026-01-03',
						TotalAmt: 42,
						Line: [
							{
								Id: '1',
								Amount: 42,
								AccountBasedExpenseLineDetail: {
									AccountRef: { value: '60', name: 'Uncategorized' },
								},
							},
						],
						MetaData: { LastUpdatedTime: '2026-01-03T00:00:00Z' },
					},
				],
			},
		],
		{
			syncedAt,
			realmState: {
				cdcCursor: syncedAt,
				lastFullPullAt: syncedAt,
				lastSyncedAt: syncedAt,
			},
		},
	);
	db.close();
}

function buildApp({ readOnly = false }: { readOnly?: boolean } = {}) {
	const { dir, cleanup } = tempDir();
	seedMirror(dir);
	const config = makeConfig({
		dataDir: dir,
		entities: ['Invoice', 'Purchase'],
	});
	const store = {
		async get() {
			return null;
		},
		async listRealms() {
			return [];
		},
		async set() {},
	};
	const app = createApiApp({
		config,
		realmId: REALM,
		store,
		mirror: booksDbFile(dir, REALM),
		readOnly,
		openQb: refusingOpenQb,
		gate: (fn) => fn(),
		syncNow: async () => ({ failed: 'no auth in tests' }),
		sessionBearers: new Set<string>(),
		bootstrapToken: BOOT,
	});
	return { app, cleanup };
}

/** Exchange the bootstrap for a bearer and return it. */
async function exchange(
	app: ReturnType<typeof buildApp>['app'],
): Promise<string> {
	const res = await app.request('/api/session', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ token: BOOT }),
	});
	expect(res.status).toBe(200);
	return ((await res.json()) as { token: string }).token;
}

function authed(bearer: string, init: RequestInit = {}): RequestInit {
	return {
		...init,
		headers: { ...(init.headers ?? {}), authorization: `Bearer ${bearer}` },
	};
}

describe('local-books app /api', () => {
	let ctx: ReturnType<typeof buildApp>;
	afterEach(() => ctx?.cleanup());

	test('every route but the exchange requires a bearer', async () => {
		ctx = buildApp();
		for (const path of ['/api/status', '/api/tables', '/api/tables/invoices']) {
			const res = await ctx.app.request(path);
			expect(res.status).toBe(401);
		}
		const post = await ctx.app.request('/api/query', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ sql: 'SELECT 1' }),
		});
		expect(post.status).toBe(401);
	});

	test('the bootstrap exchange is single-use', async () => {
		ctx = buildApp();
		const bearer = await exchange(ctx.app);
		expect(bearer.length).toBeGreaterThan(20);
		// The bootstrap is consumed; a second exchange with it is refused.
		const again = await ctx.app.request('/api/session', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ token: BOOT }),
		});
		expect(again.status).toBe(401);
		// The minted bearer works on a gated route.
		const ok = await ctx.app.request('/api/status', authed(bearer));
		expect(ok.status).toBe(200);
	});

	test('a wrong bootstrap token is rejected without minting a bearer', async () => {
		ctx = buildApp();
		const res = await ctx.app.request('/api/session', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ token: 'wrong' }),
		});
		expect(res.status).toBe(401);
	});

	test('status returns the realm and read-only flag', async () => {
		ctx = buildApp({ readOnly: true });
		const bearer = await exchange(ctx.app);
		const res = await ctx.app.request('/api/status', authed(bearer));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			realmId: string;
			readOnly: boolean;
			mirror: string;
		};
		expect(body.realmId).toBe(REALM);
		expect(body.readOnly).toBe(true);
		expect(body.mirror).toBe('ready');
	});

	test('tables lists what the database holds, with counts and pragma columns', async () => {
		ctx = buildApp();
		const bearer = await exchange(ctx.app);
		const res = await ctx.app.request('/api/tables', authed(bearer));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			mirrorBuilt: boolean;
			tables: { name: string; rowCount: number; pk: string | null }[];
		};
		expect(body.mirrorBuilt).toBe(true);
		// The list is sqlite_master, so it is the whole artifact: every corpus
		// table (pulled or not) and the sync bookkeeping, not a curated subset.
		const invoices = body.tables.find((t) => t.name === 'invoices');
		expect(invoices?.rowCount).toBe(2);
		expect(invoices?.pk).toBe('id');
		expect(body.tables.some((t) => t.name === '_meta')).toBe(true);
		expect(body.tables.some((t) => t.name === 'transfers')).toBe(true);
	});

	test('a table page returns rows and columns; an unknown table is 404', async () => {
		ctx = buildApp();
		const bearer = await exchange(ctx.app);
		const ok = await ctx.app.request('/api/tables/invoices', authed(bearer));
		expect(ok.status).toBe(200);
		const page = (await ok.json()) as {
			rows: { id: string }[];
			columns: { name: string; generated: boolean }[];
		};
		expect(page.rows.length).toBe(2);
		// pragma_table_xinfo sees the generated columns table_info hides.
		expect(
			page.columns.some((c) => c.name === 'total_amt' && c.generated),
		).toBe(true);

		// A name sqlite_master does not hold never reaches SQL.
		const bad = await ctx.app.request('/api/tables/DROP_TABLE', authed(bearer));
		expect(bad.status).toBe(404);
	});

	test('a row detail carries every column verbatim; a missing row is 404', async () => {
		ctx = buildApp();
		const bearer = await exchange(ctx.app);
		const ok = await ctx.app.request('/api/tables/invoices/i1', authed(bearer));
		expect(ok.status).toBe(200);
		const detail = (await ok.json()) as {
			pk: string | null;
			values: { id: string; raw: string };
		};
		expect(detail.pk).toBe('id');
		expect(detail.values.id).toBe('i1');
		// The blob ships verbatim; presentation-side parsing is the UI's job.
		expect((JSON.parse(detail.values.raw) as { Id: string }).Id).toBe('i1');

		const missing = await ctx.app.request(
			'/api/tables/invoices/nope',
			authed(bearer),
		);
		expect(missing.status).toBe(404);
	});

	test('query runs read-only SELECTs and rejects writes, capped', async () => {
		ctx = buildApp();
		const bearer = await exchange(ctx.app);

		const read = await ctx.app.request(
			'/api/query',
			authed(bearer, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ sql: 'SELECT id FROM invoices ORDER BY id' }),
			}),
		);
		expect(read.status).toBe(200);
		expect((await read.json()) as { rowCount: number }).toMatchObject({
			rowCount: 2,
		});

		// A write is rejected by the read-only connection (the integrity boundary).
		const write = await ctx.app.request(
			'/api/query',
			authed(bearer, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ sql: "DELETE FROM invoices WHERE id = 'i1'" }),
			}),
		);
		expect(write.status).toBe(400);

		// The row cap is a real bound: a 2000-row generator returns exactly 1000.
		const capped = await ctx.app.request(
			'/api/query',
			authed(bearer, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 2000) SELECT x FROM c',
				}),
			}),
		);
		expect(
			(await capped.json()) as { rowCount: number; truncated: boolean },
		).toMatchObject({
			rowCount: 1000,
			truncated: true,
		});
	});

	test('read-only mode refuses recategorize with 403', async () => {
		ctx = buildApp({ readOnly: true });
		const bearer = await exchange(ctx.app);
		const res = await ctx.app.request(
			'/api/recategorize',
			authed(bearer, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					entity: 'Purchase',
					id: 'p1',
					account_id: '61',
				}),
			}),
		);
		expect(res.status).toBe(403);
		expect((await res.json()) as { error: { message: string } }).toMatchObject({
			error: { message: expect.stringContaining('read-only') },
		});
	});

	test('an invalid recategorize body is rejected by validation', async () => {
		ctx = buildApp();
		const bearer = await exchange(ctx.app);
		const res = await ctx.app.request(
			'/api/recategorize',
			authed(bearer, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ entity: 'Invoice', id: 'i1', account_id: '61' }),
			}),
		);
		// `Invoice` is not a recategorize target: arktype refuses the enum.
		expect(res.status).toBe(400);
	});
});

describe('loopback request handler', () => {
	const okApi = { fetch: () => new Response('api', { status: 200 }) };

	test('rejects a request whose Host is not the loopback origin', async () => {
		const handler = createRequestHandler({
			api: okApi,
			uiDist: '/nonexistent',
			expectedHost: () => '127.0.0.1:4178',
		});
		const res = await handler(
			new Request('http://127.0.0.1:4178/api/status', {
				headers: { host: 'evil.example.com' },
			}),
		);
		expect(res.status).toBe(403);
	});

	test('passes an /api request with the exact loopback Host through to the app', async () => {
		const handler = createRequestHandler({
			api: okApi,
			uiDist: '/nonexistent',
			expectedHost: () => '127.0.0.1:4178',
		});
		const res = await handler(
			new Request('http://127.0.0.1:4178/api/status', {
				headers: { host: '127.0.0.1:4178' },
			}),
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('api');
	});
});
