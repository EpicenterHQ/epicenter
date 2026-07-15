import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { createQbAccess } from './books/qb-access.ts';
import { resolveCompany } from './commands/context.ts';
import type { CliConfigOverrides } from './config.ts';
import { openBooksDb } from './db.ts';
import { createApiApp, mintToken, type SyncPassResult } from './http/api.ts';
import { acquireSyncLock, syncOwnerBusyMessage } from './lock.ts';
import { dbPath } from './paths.ts';
import { type SyncDeps, syncRealm } from './sync.ts';

/**
 * `local-books app`: one Bun process that serves the books browser SPA and its
 * `/api` over `127.0.0.1`, while the same process keeps the mirror fresh through
 * the sync loop. The security model is `local-mail app`'s loopback shell,
 * condensed:
 *
 * - A single-use bootstrap token rides in the URL fragment (never the query
 *   string, so it never lands in a request line or access log). The SPA reads
 *   it, strips it, and exchanges it at `POST /api/session` for a per-launch
 *   session bearer it keeps in sessionStorage. Every other `/api` call carries
 *   that bearer.
 * - Every request is Host-checked first (the DNS-rebinding kill switch): a
 *   request whose Host is not exactly `127.0.0.1:<port>` is rejected before
 *   routing.
 * - Dev mode (`LOCAL_BOOKS_DEV=1`) never disables auth. The Vite proxy injects a
 *   fixed `LOCAL_BOOKS_TOKEN` bearer and rewrites Host, so the same checks run
 *   against a developer's real books.
 * - `LOCAL_BOOKS_READ_ONLY` still gates the one QuickBooks write end to end: the
 *   `recategorizeExpense` core refuses it, and the SPA hides the flow.
 *
 * Routing, the bearer gate, and request validation live in the Hono app
 * (`http/api.ts`); this module owns realm resolution, the loopback host
 * primitive, static SPA serving, the sync loop, and the process lifecycle,
 * dispatching `/api/*` to `api.fetch`.
 */

const DEV = process.env.LOCAL_BOOKS_DEV === '1';
const SYNC_INTERVAL_MS = 5 * 60_000;

type LockHandle = { db: Database; release(): void };

/**
 * A dedicated `lock.db` held with `BEGIN EXCLUSIVE` for the process lifetime, so
 * a second `app` for the same company is refused instantly. It is a separate file
 * from `books.db`, so it never blocks a concurrent `local-books sync` (which is
 * the whole point: query while sync runs). `flock` has no Bun API and an `O_EXCL`
 * lockfile is stale-on-crash; the fcntl lock a live SQLite transaction holds is
 * released by the kernel on `kill -9`.
 */
function acquireRealmLock(dir: string): LockHandle | null {
	mkdirSync(dir, { recursive: true });
	const db = new Database(join(dir, 'lock.db'), { create: true });
	db.run('PRAGMA busy_timeout = 0;');
	try {
		db.run('BEGIN EXCLUSIVE;');
	} catch {
		db.close();
		return null;
	}
	return {
		db,
		release() {
			try {
				db.run('ROLLBACK;');
			} catch {
				// The process is exiting; the kernel drops the lock regardless.
			}
			db.close();
		},
	};
}

/**
 * One in-process promise chain: the background loop and a "refresh now" request
 * both enqueue here, so at most one sync pass touches the mirror at a time. No
 * coalescing (a refresh may ride a pass that started before the click).
 */
function createSyncGate() {
	let tail: Promise<unknown> = Promise.resolve();
	return function run<T>(fn: () => Promise<T>): Promise<T> {
		const result = tail.then(fn, fn);
		tail = result.catch(() => {});
		return result;
	};
}

/** Serve the built SPA from disk, falling back to index.html for deep links. */
async function serveStatic(
	uiDist: string,
	pathname: string,
): Promise<Response> {
	const rel = pathname === '/' ? '/index.html' : pathname;
	// Reject path traversal before touching the filesystem. `join` collapses `..`,
	// so match on a real separator boundary: a bare `startsWith(uiDist)` would also
	// accept a sibling like `<uiDist>-evil`.
	const target = join(uiDist, rel);
	if (target !== uiDist && !target.startsWith(uiDist + sep)) {
		return new Response('Forbidden', { status: 403 });
	}
	const file = Bun.file(target);
	if (await file.exists()) {
		return new Response(file, {
			headers: { 'referrer-policy': 'no-referrer' },
		});
	}
	const index = Bun.file(join(uiDist, 'index.html'));
	if (await index.exists()) {
		return new Response(index, {
			headers: {
				'content-type': 'text/html',
				'referrer-policy': 'no-referrer',
			},
		});
	}
	return new Response('Not found', { status: 404 });
}

/**
 * The loopback request handler: Host check first (the DNS-rebinding kill switch),
 * then dispatch `/api/*` to the Hono app and everything else to the static SPA.
 * Factored out of `runApp` so the security-critical Host check is tested against
 * the real code path. `expectedHost` is a thunk because the port is only known
 * after `Bun.serve` starts (an ephemeral `0` is assigned late).
 */
export function createRequestHandler({
	api,
	uiDist,
	expectedHost,
}: {
	api: { fetch: (req: Request) => Response | Promise<Response> };
	uiDist: string;
	expectedHost: () => string;
}) {
	return (req: Request): Response | Promise<Response> => {
		const url = new URL(req.url);
		if (req.headers.get('host') !== expectedHost()) {
			return new Response('Forbidden', { status: 403 });
		}
		if (url.pathname.startsWith('/api/')) return api.fetch(req);
		return serveStatic(uiDist, url.pathname);
	};
}

export async function runApp(
	options: CliConfigOverrides & { noOpen?: boolean; port?: number },
): Promise<number> {
	// Resolve the company the same way `sync`/`status` do: config from flags/env,
	// then the realm (explicit flag, recorded default, or the sole authenticated
	// one). Ambiguity is an error, not a silent guess.
	const { data: company, error } = resolveCompany(options);
	if (error !== null) {
		console.error(error);
		return 1;
	}
	const { config, realmId, store } = company;
	const readOnly = config.readOnly;
	const mirrorPath = dbPath(config.dataDir, realmId);

	const appLock = acquireRealmLock(join(config.dataDir, realmId));
	if (!appLock) {
		console.error(
			`local-books app is already running for company ${realmId}. Stop it first, or open the URL it printed.`,
		);
		return 1;
	}
	const syncLock = acquireSyncLock({ dataDir: config.dataDir, realmId });
	if (!syncLock) console.error(syncOwnerBusyMessage(realmId));

	// The valid-bearer set. Dev pre-seeds the fixed proxy token; prod fills it only
	// through the bootstrap exchange handled inside the Hono app.
	const sessionBearers = new Set<string>();
	let bootstrapToken: string | null = null;
	if (DEV) {
		const devToken = process.env.LOCAL_BOOKS_TOKEN;
		if (!devToken) {
			syncLock?.release();
			appLock.release();
			console.error(
				'LOCAL_BOOKS_DEV=1 requires LOCAL_BOOKS_TOKEN so the Vite proxy can authenticate.',
			);
			return 1;
		}
		sessionBearers.add(devToken);
	} else {
		bootstrapToken = mintToken();
	}

	const now = () => Date.now();
	// The same opener report/recategorize/sync/MCP use: it reloads the token and
	// builds the client, or returns a "run auth" reason. One way to open a client.
	const openQb = createQbAccess({
		config,
		realmId,
		store,
		now,
		log: (m) => console.error(`[qb] ${m}`),
	});

	/**
	 * One sync pass, stateless like the CLI verb: open a fresh client and writer db,
	 * run the realm pass, close. Serialized through the gate below. A missing or
	 * expired token is a soft failure (the UI still browses the existing mirror),
	 * not a boot failure, so `app` opens the books even when auth has lapsed.
	 */
	async function syncNow(): Promise<SyncPassResult> {
		if (!syncLock) return { failed: syncOwnerBusyMessage(realmId) };
		const { data: client, error: openError } = await openQb();
		if (openError !== null) return { failed: openError.message };
		const db = openBooksDb(mirrorPath);
		try {
			const deps: SyncDeps = {
				db,
				client,
				config,
				now,
				log: (m) => console.error(`[sync] ${m}`),
			};
			return { outcome: await syncRealm(deps, { forceFull: false }) };
		} finally {
			db.close();
		}
	}

	const uiDist = join(import.meta.dir, '..', 'ui', 'dist');
	const gate = createSyncGate();
	const controller = new AbortController();

	const api = createApiApp({
		config,
		realmId,
		store,
		dbPath: mirrorPath,
		readOnly,
		openQb,
		gate,
		syncNow,
		sessionBearers,
		bootstrapToken,
	});

	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: options.port ?? (Number(process.env.LOCAL_BOOKS_PORT) || 0),
		// The Vite proxy rewrites Host to match via changeOrigin, so dev passes too.
		fetch: createRequestHandler({
			api,
			uiDist,
			expectedHost: (): string => `127.0.0.1:${server.port}`,
		}),
	});

	// The background sync loop, serialized through the same gate as POST /api/sync.
	if (syncLock) {
		(async () => {
			while (!controller.signal.aborted) {
				await gate(syncNow).catch((cause) =>
					console.error(`[sync] loop pass failed: ${cause}`),
				);
				if (controller.signal.aborted) break;
				await Bun.sleep(SYNC_INTERVAL_MS);
			}
		})();
	}

	const origin = `http://127.0.0.1:${server.port}`;
	if (DEV) {
		console.error(`local-books app (dev API) listening on ${origin}`);
		console.error('Run the SPA with: bun run --cwd apps/local-books/ui dev');
	} else {
		const noOpen = options.noOpen || process.env.LOCAL_BOOKS_NO_OPEN === '1';
		const launchUrl = `${origin}/#token=${bootstrapToken}`;
		console.log(launchUrl);
		if (!existsSync(uiDist)) {
			console.error(
				`Note: ${uiDist} does not exist yet. Build the SPA with "bun run --cwd apps/local-books/ui build".`,
			);
		}
		// `--no-open` prints the URL without launching a browser; the env fallback
		// supports headless hosts, CI, and "copy the URL into the browser I want".
		if (!noOpen) {
			Bun.spawn(['open', launchUrl]).exited.catch(() => {});
		}
	}

	await new Promise<void>((resolve) => {
		let stopping = false;
		const stop = () => {
			if (stopping) return;
			stopping = true;
			process.off('SIGINT', stop);
			process.off('SIGTERM', stop);
			controller.abort();
			server.stop();
			syncLock?.release();
			appLock.release();
			resolve();
		};
		process.on('SIGINT', stop);
		process.on('SIGTERM', stop);
	});
	return 0;
}
