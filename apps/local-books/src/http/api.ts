import { randomBytes } from 'node:crypto';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import { sValidator } from '@hono/standard-validator';
import { type } from 'arktype';
import { Hono } from 'hono';
import type { OpenQbClient } from '../books/qb-access.ts';
import { queryBooks } from '../books/query.ts';
import {
	getTableRow,
	listTables,
	pageTableRows,
} from '../books/read-models.ts';
import {
	RECATEGORIZE_ENTITIES,
	recategorizeExpense,
} from '../books/recategorize.ts';
import { fetchReport, REPORT_NAMES } from '../books/report.ts';
import { readBooksStatus } from '../books/status.ts';
import type { AppConfig } from '../config.ts';
import type { DbFile } from '../db-file.ts';
import type { SyncOutcome } from '../sync.ts';
import type { TokenStore } from '../token-store.ts';
import { ApiError } from './api-errors.ts';

/**
 * The `/api` surface of `local-books app`, as a Hono app. It owns routing, the
 * bearer gate, and request validation; the loopback host primitive around it
 * (`Bun.serve` in `app.ts`) owns the Host-check kill switch and static SPA
 * serving: `/api/*` falls through to this Hono app, `/*` serves `ui/dist`.
 *
 * The app is built by a factory so its per-launch dependencies (the resolved
 * realm, the QB opener, the sync closure, the valid-bearer set) are injected
 * rather than captured at module load, while `export type ApiApp = ReturnType<
 * typeof createApiApp>` still hands the SPA a precise end-to-end typed `hc`
 * client. Every handler returns `c.json(...)`, so the client's response types are
 * inferred from the exact shapes the server returns: the wire contract cannot
 * silently drift.
 *
 * Reads and writes go through the same `src/books/*` cores the CLI and MCP use
 * (`queryBooks`, `fetchReport`, `recategorizeExpense`, the read-models). This
 * module holds no boot or lifecycle code, so the SPA can import its `ApiApp` type
 * without dragging in `Bun.serve`.
 */

/** Bound online guessing by another local user against the exchange endpoint. */
const MAX_FAILED_EXCHANGES = 25;

/** 256 bits of CSPRNG, base64url: well past the loopback shell spec's 128-bit floor. */
export function mintToken(): string {
	return randomBytes(32).toString('base64url');
}

// Request schemas are arktype, the repo's HTTP-boundary validator (paired with
// `@hono/standard-validator`, as in `packages/server` and `local-mail`). typebox
// stays for the QB wire shapes and the verb-core inputs in `src/books/*`; these
// are two different boundaries.

/** `POST /api/session` body: the single-use bootstrap token being exchanged. */
const SessionBody = type({ token: 'string >= 1' });

/** `GET /api/tables/:table` query. Strings arrive raw; clamped in the handler. */
const RowsQuery = type({ 'limit?': 'string', 'offset?': 'string' });

/** `POST /api/query` body: the read-only SQL to run over the mirror. */
const QueryBody = type({ sql: 'string >= 1' });

/** `POST /api/report` body: mirrors the `ReportInput` verb-core shape (arktype side). */
const ReportBody = type({
	report: type.enumerated(...REPORT_NAMES),
	'start_date?': 'string',
	'end_date?': 'string',
	'accounting_method?': type.enumerated('Cash', 'Accrual'),
});

/** `POST /api/recategorize` body: mirrors the `RecategorizeInput` verb-core shape. */
const RecategorizeBody = type({
	entity: type.enumerated(...RECATEGORIZE_ENTITIES),
	id: 'string >= 1',
	account_id: 'string >= 1',
	'account_name?': 'string',
	'line_id?': 'string',
});

/** The result of one background/on-demand sync pass, or why it could not run. */
export type SyncPassResult = { outcome: SyncOutcome } | { failed: string };

type ApiDeps = {
	config: AppConfig;
	realmId: string;
	store: TokenStore;
	/** The company's mirror: the read verbs open its current artifact per call. */
	mirror: DbFile;
	readOnly: boolean;
	/** Reloads the newest token and opens a QB client (report/recategorize). */
	openQb: OpenQbClient;
	/** The one in-process serialize gate: the background loop and `POST /api/sync`
	 * both enqueue here, so at most one pass touches the mirror at a time. */
	gate: <T>(fn: () => Promise<T>) => Promise<T>;
	/** One sync pass, assembled by the launcher; run through `gate`. */
	syncNow: () => Promise<SyncPassResult>;
	/** The valid-bearer set, owned by the launcher so dev can pre-seed the fixed
	 * proxy token. Prod fills it only through the bootstrap exchange below. */
	sessionBearers: Set<string>;
	/** The single-use bootstrap token, or `null` in dev. Consumed at first exchange. */
	bootstrapToken: string | null;
};

/** Clamp a string query param to a bounded non-negative integer. */
function clampInt(
	value: string | undefined,
	fallback: number,
	max: number,
): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(0, Math.min(Math.floor(parsed), max));
}

export function createApiApp(deps: ApiDeps) {
	const { config, realmId, store, mirror, readOnly, openQb, gate, syncNow } =
		deps;
	const { sessionBearers } = deps;

	// Per-launch auth state, mutated in place across requests.
	let bootstrapToken = deps.bootstrapToken;
	let failedExchanges = 0;

	const app = new Hono()
		// The bearer gate on every `/api` route except the one public exchange. The
		// skip is an explicit path check, not a registration-order trick, so it stays
		// correct wherever this middleware sits in the chain.
		.use('/api/*', async (c, next) => {
			if (
				c.req.path === API_ROUTES.session.pattern &&
				c.req.method === 'POST'
			) {
				return next();
			}
			const header = c.req.header('authorization');
			const bearer = header?.startsWith('Bearer ')
				? header.slice('Bearer '.length)
				: null;
			if (!bearer || !sessionBearers.has(bearer)) {
				const err = ApiError.Unauthorized();
				return c.json(err, err.error.status);
			}
			return next();
		})
		// The one unauthenticated mutation: exchange the bootstrap for a bearer.
		.post(API_ROUTES.session.pattern, sValidator('json', SessionBody), (c) => {
			if (bootstrapToken === null) {
				const err = ApiError.NoBootstrapToken();
				return c.json(err, err.error.status);
			}
			if (failedExchanges >= MAX_FAILED_EXCHANGES) {
				const err = ApiError.TooManyExchanges();
				return c.json(err, err.error.status);
			}
			const { token } = c.req.valid('json');
			if (token !== bootstrapToken) {
				failedExchanges += 1;
				const err = ApiError.InvalidBootstrapToken();
				return c.json(err, err.error.status);
			}
			const bearer = mintToken();
			sessionBearers.add(bearer);
			bootstrapToken = null; // single use: invalidate at exchange
			return c.json({ token: bearer });
		})
		.get('/api/status', async (c) => {
			const status = await readBooksStatus({ config, realmId, mirror, store });
			return c.json({ ...status, readOnly });
		})
		.get('/api/tables', (c) => c.json(listTables({ mirror })))
		.get('/api/tables/:table', sValidator('query', RowsQuery), (c) => {
			const table = c.req.param('table');
			const { limit, offset } = c.req.valid('query');
			// The read-model resolves the name against sqlite_master before any
			// interpolation, so an unknown string ends here as a 404, never in SQL.
			const page = pageTableRows({
				mirror,
				table,
				limit: clampInt(limit, 100, 500),
				offset: clampInt(offset, 0, Number.MAX_SAFE_INTEGER),
			});
			if (page === null) {
				const err = ApiError.UnknownTable({ table });
				return c.json(err, err.error.status);
			}
			return c.json(page);
		})
		.get('/api/tables/:table/:id', (c) => {
			const detail = getTableRow({
				mirror,
				table: c.req.param('table'),
				id: c.req.param('id'),
			});
			if (!detail) {
				const err = ApiError.RowNotFound();
				return c.json(err, err.error.status);
			}
			return c.json(detail);
		})
		.post('/api/query', sValidator('json', QueryBody), (c) => {
			const { sql } = c.req.valid('json');
			const { data, error } = queryBooks({ mirror, sql });
			if (error) {
				const err = ApiError.QueryFailed({ message: error.message });
				return c.json(err, err.error.status);
			}
			return c.json(data);
		})
		.post('/api/sync', async (c) => {
			const result = await gate(syncNow);
			if ('failed' in result) {
				const err = ApiError.SyncFailed({ message: result.failed });
				return c.json(err, err.error.status);
			}
			return c.json(result.outcome);
		})
		.post('/api/report', sValidator('json', ReportBody), async (c) => {
			const { data, error } = await fetchReport({
				openQb,
				input: c.req.valid('json'),
			});
			if (error) {
				const err = ApiError.ReportFailed({ message: error.message });
				return c.json(err, err.error.status);
			}
			return c.json(data);
		})
		.post(
			'/api/recategorize',
			sValidator('json', RecategorizeBody),
			async (c) => {
				// `readOnly` is a required core argument: `recategorizeExpense` is the
				// single owner of the gate and refuses the write itself, so the boundary
				// only maps that refusal to a 403 rather than re-implementing it.
				const { data, error } = await recategorizeExpense({
					openQb,
					mirror,
					input: c.req.valid('json'),
					readOnly,
				});
				if (error) {
					const status =
						error.name === 'ReadOnly'
							? 403
							: error.name === 'NotInMirror'
								? 404
								: 400;
					const err = ApiError.RecategorizeFailed({
						message: error.message,
						status,
					});
					return c.json(err, err.error.status);
				}
				return c.json(data);
			},
		)
		.notFound((c) => {
			const err = ApiError.NotFound();
			return c.json(err, err.error.status);
		});

	return app;
}

/** The typed shape of the `/api` app, for the SPA's `hc<ApiApp>` client. */
export type ApiApp = ReturnType<typeof createApiApp>;
