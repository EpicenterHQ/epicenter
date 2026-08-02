import { randomBytes } from 'node:crypto';
import { sValidator } from '@hono/standard-validator';
import { type } from 'arktype';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { assertMessageLabels } from '../assert.ts';
import type { MailDb } from '../db.ts';
import { reconcileOwnerBusy } from '../lock.ts';
import {
	type ReconcileDeps,
	type ReconcileOutcome,
	reconcileAccount,
} from '../reconcile.ts';
import type { LocalMailRuntime } from '../runtime.ts';
import { readMailStatus } from '../status.ts';
import { ApiError } from './api-errors.ts';

/**
 * The `/api` surface of `local-mail app`, as a Hono app. It owns routing, the
 * bearer gate, and request validation; the loopback host primitive around it
 * (`Bun.serve` in `app.ts`) owns the Host-check kill switch and static SPA
 * serving: `/api/*` falls through to this Hono app, `/*` serves `ui/dist`.
 *
 * The app is built by a factory so its per-launch dependencies (the per-account
 * writer db + sync gate, the per-launch bearer) are injected rather than
 * captured at module load, while `export type ApiApp = ReturnType<typeof
 * createApiApp>` still hands the SPA a precise end-to-end typed `hc` client.
 * Every handler returns `c.json(...)`, so the client's response types are
 * inferred from the exact shapes the server returns: the wire contract cannot
 * silently drift.
 *
 * The surface is multi-account. `GET /api/accounts` lists the accounts the host
 * loaded at launch, and every read/write route is scoped under
 * `/api/accounts/:account/*`: one loopback origin serves all connected mailboxes
 * (`app.ts` holds one sync session, one gate, and one per-account sync lock for
 * each). An unknown `:account` is a 404 (`AccountNotFound`); the set is frozen at
 * launch, matching the MCP one-session-per-account rule.
 *
 * Auth is one per-launch bearer, minted by the host and handed to the SPA out of
 * band (an injected `window.__LOCAL_MAIL__` global, never the URL). Every `/api`
 * request must present it; there is no bootstrap-token exchange endpoint.
 *
 * No route here writes to Gmail. Every triage act, archive, read, star, label,
 * and trash alike, desugars into one `POST /messages/assert` that records a
 * durable local assertion and asks the host's reconciler to wake; the reconciler
 * delivers it (`POST /reconcile` is the explicit, synchronous form of the same
 * pass). Reads answer from the mirror WITH those assertions overlaid, so the
 * list a caller gets back already reflects the act it just made.
 */

/** The per-launch local API bearer: 256 bits of CSPRNG, base64url. Minted once
 * by the host, never a Gmail token, never carried in a URL. */
export function mintBearer(): string {
	return randomBytes(32).toString('base64url');
}

// Request schemas are arktype, the repo's HTTP-boundary validator (paired with
// `@hono/standard-validator`, as in `packages/server`). typebox stays for the
// Gmail wire shapes in `schema.ts`; these are two different boundaries.

/** `POST /api/messages/assert` body: the concrete ids the caller acted on, plus
 * the label sets every triage intent desugars into. Trash is not special here:
 * moving to trash adds `TRASH`, and Undo removes it. */
const AssertBody = type({
	ids: 'string[]',
	'addLabels?': 'string[]',
	'removeLabels?': 'string[]',
});

/** `GET /api/messages` query. Values arrive as strings; `limit`/`offset` are
 * parsed and clamped in the handler, matching the original bounds. */
const MessageQuery = type({
	'label?': 'string',
	'q?': 'string',
	'limit?': 'string',
	'offset?': 'string',
});

/**
 * Everything the `/api` surface needs to serve one account: its runtime (for
 * `status`), its mirror + intent store + Gmail client (`deps`), its per-account
 * serialize gate, the wake it asks for after an act, and whether THIS host owns
 * that account's reconcile loop (holds the `lock.ts` lock). Reads and acts never
 * take the lock, so they work regardless; only `POST .../reconcile` cares,
 * yielding busy when the loop is owned elsewhere.
 */
export type AccountApi = {
	runtime: LocalMailRuntime;
	deps: ReconcileDeps;
	/** The per-account serialize gate: this account's background loop and its
	 * `POST .../reconcile` both enqueue here, so at most one pass touches its
	 * mirror at a time. Distinct accounts reconcile concurrently. */
	gate: <T>(fn: () => Promise<T>) => Promise<T>;
	/** Ask the host's loop for a coalesced pass, so a local assertion is
	 * delivered shortly after it is made rather than at the next poll. A no-op
	 * when this host does not own the loop; that owner's poll picks it up. */
	requestWake: () => void;
	/** Whether this host holds the account's reconcile-owner lock (runs its
	 * loop). A false value means another owner has it, so an explicit reconcile
	 * yields `reconcileOwnerBusy` rather than racing a second writer. */
	ownsLoop: boolean;
};

type ApiDeps = {
	/** The connected accounts this host loaded at launch, keyed by email. */
	accounts: Map<string, AccountApi>;
	/** Global mutation kill switch (`LOCAL_MAIL_READ_ONLY`), not per-account. */
	readOnly: boolean;
	/** The per-launch local API bearer every `/api` request must present. The
	 * host mints it (`mintBearer`) and hands it to the SPA out of band (an
	 * injected `window.__LOCAL_MAIL__` global), never a Gmail token. */
	bearer: string;
};

export function createApiApp(deps: ApiDeps) {
	const { accounts, readOnly, bearer } = deps;

	// Look up the account named by the `:account` segment, or undefined. The
	// caller emits the 404 inline via `c.json`, NOT this helper: a helper that
	// returned a bare `Response` would widen `c.json`'s `TypedResponse` and break
	// `hc<ApiApp>` response inference for the whole route. `Context` is the
	// untyped base, so `param('account')` is `string | undefined`; a missing
	// segment can never key the map, so `?? ''` folds it into the same 404.
	const accountFor = (c: Context): AccountApi | undefined =>
		accounts.get(c.req.param('account') ?? '');

	// The account-scoped surface, mounted under `/api/accounts/:account`. It is
	// its own sub-app combined via `.route()` (not seven sibling `:account`
	// routes on one chain) so `hc<ApiApp>` infers every route: Hono merges a
	// mounted sub-schema under the param in one step, where a long chain of
	// param-prefixed siblings degrades the generated client type. `:account`
	// resolves from the mount path, so handlers read it via `accountFor(c)`.
	const accountApp = new Hono()
		.get('/status', async (c) => {
			const account = accountFor(c);
			if (!account) {
				const err = ApiError.AccountNotFound();
				return c.json(err, err.error.status);
			}
			const status = await readMailStatus(account.runtime);
			return c.json({
				accountEmail: status.accountEmail,
				connected: status.connected,
				mirror: status.mirror,
				historyId: status.historyId,
				lastSyncedAt: status.lastSyncedAt,
				lastFullPullAt: status.lastFullPullAt,
				rows: status.rows,
				readOnly,
			});
		})
		.get('/labels', (c) => {
			const account = accountFor(c);
			if (!account) {
				const err = ApiError.AccountNotFound();
				return c.json(err, err.error.status);
			}
			return c.json({ labels: account.deps.db.listLabels() });
		})
		.get('/messages', sValidator('query', MessageQuery), (c) => {
			const account = accountFor(c);
			if (!account) {
				const err = ApiError.AccountNotFound();
				return c.json(err, err.error.status);
			}
			const { label, q, limit, offset } = c.req.valid('query');
			const db: MailDb = account.deps.db;
			return c.json({
				messages: db.listMessages({
					labelId: label,
					search: q?.trim() || undefined,
					limit: Math.min(Number(limit) || 100, 200),
					offset: Math.max(Number(offset) || 0, 0),
				}),
			});
		})
		// Hono already URL-decodes path params, so no manual decodeURIComponent.
		.get('/messages/:id', (c) => {
			const account = accountFor(c);
			if (!account) {
				const err = ApiError.AccountNotFound();
				return c.json(err, err.error.status);
			}
			const detail = account.deps.db.getMessageDetail(c.req.param('id'));
			if (!detail) {
				const err = ApiError.MessageNotFound();
				return c.json(err, err.error.status);
			}
			return c.json(detail);
		})
		.post('/reconcile', async (c) => {
			const account = accountFor(c);
			if (!account) {
				const err = ApiError.AccountNotFound();
				return c.json(err, err.error.status);
			}
			const { runtime, deps, gate, ownsLoop } = account;
			// This host owns the loop only when it holds the lock. Without it,
			// another owner delivers and pulls, so yield busy instead of becoming a
			// second writer (the same contract the headless pass uses).
			if (!ownsLoop) return c.json(reconcileOwnerBusy(runtime.accountEmail));
			const outcome: ReconcileOutcome = await gate(() =>
				reconcileAccount(deps, { forceFull: false, readOnly }),
			);
			return c.json(outcome);
		})
		.post('/messages/assert', sValidator('json', AssertBody), (c) => {
			const account = accountFor(c);
			if (!account) {
				const err = ApiError.AccountNotFound();
				return c.json(err, err.error.status);
			}
			const { ids, addLabels, removeLabels } = c.req.valid('json');
			const { data, error } = assertMessageLabels({
				deps: account.deps,
				input: {
					ids,
					addLabels: addLabels ?? [],
					removeLabels: removeLabels ?? [],
				},
				readOnly,
			});
			if (error) {
				const err = ApiError.AssertFailed({ message: error.message });
				return c.json(err, err.error.status);
			}
			// The act is already durable and already visible to every read; the wake
			// only decides how soon Gmail hears about it, so it is fired and not
			// awaited.
			account.requestWake();
			return c.json(data);
		});

	const app = new Hono()
		// The bearer gate on every `/api` route: present the one per-launch bearer
		// or get 401. There is no unauthenticated route (the bootstrap exchange is
		// gone; the SPA already holds the bearer via the injected global).
		.use('/api/*', async (c, next) => {
			const header = c.req.header('authorization');
			const provided = header?.startsWith('Bearer ')
				? header.slice('Bearer '.length)
				: null;
			if (!provided || provided !== bearer) {
				const err = ApiError.Unauthorized();
				return c.json(err, err.error.status);
			}
			return next();
		})
		// The connected accounts this host serves, sorted, for the switcher. The
		// set is frozen at launch (a newly connected account appears on restart).
		.get('/api/accounts', (c) =>
			c.json({ accounts: [...accounts.keys()].sort() }),
		)
		.route('/api/accounts/:account', accountApp)
		.notFound((c) => {
			const err = ApiError.NotFound();
			return c.json(err, err.error.status);
		});

	return app;
}

/** The typed shape of the `/api` app, for the SPA's `hc<ApiApp>` client. */
export type ApiApp = ReturnType<typeof createApiApp>;
