import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { type AppConfig, loadConfig } from './config.ts';
import { type AccountApi, createApiApp, mintBearer } from './http/api.ts';
import { acquireSyncLock, type SyncLock } from './lock.ts';
import { clearPresence, writePresence } from './presence.ts';
import {
	type LocalMailRuntime,
	openSyncSession,
	runtimeForAccount,
	type SyncSession,
} from './runtime.ts';
import { syncMailbox } from './sync.ts';
import { createFileTokenStore, type TokenStore } from './token-store.ts';

/**
 * `local-mail app`: the desktop runtime host. One Bun process serves the triage
 * SPA and its `/api` over `127.0.0.1`, and the same process keeps the mirror
 * fresh through the sync loop, holding the per-account sync lock for its
 * lifetime (the single loop owner). This is a loopback web host; the Tauri
 * desktop shell points a `WebviewUrl::External` window at this origin and owns
 * nothing else. The bearer stays injected into the HTML this engine serves and
 * never transits Rust (ADR-0116).
 *
 * The security model, condensed:
 *
 * - Every request is Host-checked first (the DNS-rebinding kill switch): a
 *   request whose Host is not exactly `127.0.0.1:<port>` is rejected before
 *   routing.
 * - The web UI authenticates with a per-launch local API bearer (a loopback
 *   credential, never a Gmail token). The host mints it and hands it to the SPA
 *   by injecting `window.__LOCAL_MAIL__ = { origin, bearer }` into the served
 *   HTML before the SPA's scripts run. No URL fragment, no exchange endpoint, no
 *   sessionStorage. Every `/api` call carries the bearer.
 * - HTML that carries the bearer is served `no-store` (a rotated bearer is never
 *   read from cache) and frame-denied (`frame-ancestors 'none'` +
 *   `X-Frame-Options: DENY`), so a cross-origin page cannot frame the
 *   auto-authenticated SPA and clickjack a triage write.
 * - While running, the host writes a `0600` presence file (`runtime.json`:
 *   `{ origin, bearer, pid }`) so a same-UID out-of-process reader can find this
 *   bearer. Today that reader is the Vite dev server, whose proxy injects the
 *   bearer on each proxied `/api` request (SvelteKit's dev HTML pipeline cannot
 *   reproduce the prod HTML injection). Presence, not discovery-for-spawn:
 *   nothing starts the host from it.
 *
 * Routing, the bearer gate, and request validation live in the Hono app
 * (`http/api.ts`); this module owns the loopback host primitive, static SPA
 * serving with bearer injection, and the process lifecycle, dispatching
 * `/api/*` to `api.fetch`.
 */

const SYNC_INTERVAL_MS = 30_000;

/** Headers on every HTML response that carries the injected bearer. `no-store`
 * keeps a rotated bearer out of the browser cache; the frame denials stop a
 * cross-origin page from framing the auto-authenticated SPA and clickjacking a
 * triage write; `referrer-policy` keeps the loopback origin out of referrers. */
const INJECTED_HTML_HEADERS: Record<string, string> = {
	'content-type': 'text/html; charset=utf-8',
	'cache-control': 'no-store',
	'referrer-policy': 'no-referrer',
	'content-security-policy': "frame-ancestors 'none'",
	'x-frame-options': 'DENY',
};

/**
 * One in-process promise chain: the background loop and a "refresh now" request
 * both enqueue here, so at most one sync pass touches the mirror at a time. No
 * coalescing (a refresh may ride a pass that started before the click); the
 * spec accepts that for v1.
 */
function createSyncGate() {
	let tail: Promise<unknown> = Promise.resolve();
	return function run<T>(fn: () => Promise<T>): Promise<T> {
		const result = tail.then(fn, fn);
		tail = result.catch(() => {});
		return result;
	};
}

/**
 * Insert `<script>window.__LOCAL_MAIL__=...</script>` right after `<head>` so
 * the global is defined before the SPA's deferred module scripts run. The bearer
 * is base64url and serialized with `JSON.stringify`, so it cannot break out of
 * the inline script string.
 */
function injectBearer(html: string, origin: string, bearer: string): string {
	const script = `<script>window.__LOCAL_MAIL__=${JSON.stringify({ origin, bearer })}</script>`;
	const marker = '<head>';
	const at = html.indexOf(marker);
	if (at === -1) return `${script}${html}`;
	const cut = at + marker.length;
	return html.slice(0, cut) + script + html.slice(cut);
}

/** Serve the SPA shell (`index.html`) with the bearer injected. Every path that
 * yields the shell (root, `/index.html`, and the deep-link fallback) routes here,
 * so no SPA entry boots without `window.__LOCAL_MAIL__`. */
async function serveIndex(
	uiDist: string,
	origin: string,
	bearer: string,
): Promise<Response> {
	const index = Bun.file(join(uiDist, 'index.html'));
	if (!(await index.exists())) {
		return new Response('Not found', { status: 404 });
	}
	const html = injectBearer(await index.text(), origin, bearer);
	return new Response(html, { headers: INJECTED_HTML_HEADERS });
}

/** Serve the built SPA from disk. Real asset files are served as-is; the shell
 * (root, `/index.html`, or a missing path that falls back to the SPA) is served
 * with the bearer injected. */
async function serveStatic(
	uiDist: string,
	pathname: string,
	origin: string,
	bearer: string,
): Promise<Response> {
	const rel = pathname === '/' ? '/index.html' : pathname;
	// Reject path traversal before touching the filesystem. `join` collapses
	// `..`, so match on a real separator boundary: a bare `startsWith(uiDist)`
	// would also accept a sibling like `<uiDist>-evil`.
	const target = join(uiDist, rel);
	if (target !== uiDist && !target.startsWith(uiDist + sep)) {
		return new Response('Forbidden', { status: 403 });
	}
	if (rel === '/index.html') return serveIndex(uiDist, origin, bearer);
	const file = Bun.file(target);
	if (await file.exists()) {
		return new Response(file, {
			headers: { 'referrer-policy': 'no-referrer' },
		});
	}
	// Deep-link fallback: an unknown path is a client-side route, so serve the
	// injected shell (not a bare index.html, which would boot without the bearer).
	return serveIndex(uiDist, origin, bearer);
}

/**
 * One account's slice of the running host: its runtime, its open sync session
 * (writer db + Gmail client), its per-account serialize gate, and the sync-owner
 * lock IF this host won it. `lock === null` means another owner (a headless
 * `sync`) holds the loop for that account; the host still serves its reads, it
 * just runs no loop for it.
 *
 * Under ADR-0199 this lock becomes the reconciler lock and covers Gmail writes
 * as well as pulling, so a host without it asserts and yields delivery to the
 * owner. The direct write path this file still exposes is withdrawn; see
 * `specs/20260801T210000-local-mail-intent-and-reconciler-clean-break.md`.
 */
type AccountEngine = {
	runtime: LocalMailRuntime;
	session: SyncSession;
	gate: <T>(fn: () => Promise<T>) => Promise<T>;
	lock: SyncLock | null;
};

/**
 * The accounts `local-mail app` serves: every connected account by default, or
 * only `LOCAL_MAIL_ACCOUNT` when that single-account override is set (the same
 * escape hatch the CLI and tests use, honored here too). Enumerated once at
 * launch from the store, so an account connected later appears on the next
 * restart.
 */
async function selectAppAccounts(
	config: AppConfig,
	store: TokenStore,
): Promise<Result<string[], { message: string }>> {
	const connected = await store.listAccounts();
	if (connected.length === 0) {
		return Err({
			message: 'No Gmail account connected. Run "local-mail connect" first.',
		});
	}
	if (config.account) {
		if (!connected.includes(config.account)) {
			return Err({
				message: `LOCAL_MAIL_ACCOUNT is set to ${config.account}, which is not a connected account (connected: ${connected.join(', ')}).`,
			});
		}
		return Ok([config.account]);
	}
	return Ok(connected);
}

export async function runApp(options: { port?: number }): Promise<number> {
	const config = loadConfig();
	const store = createFileTokenStore(config.credentialsPath);

	const { data: accountEmails, error: accountsError } = await selectAppAccounts(
		config,
		store,
	);
	if (accountsError || !accountEmails) {
		console.error(accountsError?.message ?? 'No account to serve.');
		return 1;
	}

	const controller = new AbortController();
	// One engine per account, all under this one origin. A per-account gate keeps
	// each mirror single-writer while letting distinct accounts sync concurrently.
	const engines: AccountEngine[] = [];
	for (const accountEmail of accountEmails) {
		const runtime = runtimeForAccount(config, store, accountEmail);
		const { data: session, error: sessionError } = await openSyncSession(
			runtime,
			{
				gmailLog: (m) => console.error(`[gmail ${accountEmail}] ${m}`),
				syncLog: (m) => console.error(`[sync ${accountEmail}] ${m}`),
			},
		);
		if (sessionError || !session) {
			// One account failing to open (e.g. its token vanished between the store
			// listing and now) must not sink the whole host; log it and serve the rest.
			console.error(
				`Skipping ${accountEmail}: ${sessionError?.message ?? 'failed to open sync session.'}`,
			);
			continue;
		}
		const lock = acquireSyncLock({ dataDir: config.dataDir, accountEmail });
		engines.push({ runtime, session, gate: createSyncGate(), lock });
	}

	if (engines.length === 0) {
		console.error(
			'No account could be served. Run "local-mail connect" first.',
		);
		return 1;
	}

	const accounts = new Map<string, AccountApi>(
		engines.map((engine) => [
			engine.runtime.accountEmail,
			{
				runtime: engine.runtime,
				syncDeps: engine.session.deps,
				gate: engine.gate,
				ownsLoop: engine.lock !== null,
			},
		]),
	);

	const readOnly = config.readOnly;
	const bearer = mintBearer();
	// Where the built SPA lives. In dev (and headless `bun src/bin.ts app`) it
	// sits beside the source at `../ui/dist`. A packaged desktop build ships the
	// engine as a compiled sidecar whose `import.meta.dir` is a virtual path with
	// no `ui/dist` sibling, so the Tauri shell points `LOCAL_MAIL_UI_DIST` at the
	// SPA it bundled as a resource. Same serving code either way; only the root
	// differs (ADR-0116: one engine entrypoint, one loopback contract).
	const uiDist =
		process.env.LOCAL_MAIL_UI_DIST ?? join(import.meta.dir, '..', 'ui', 'dist');

	const api = createApiApp({ accounts, readOnly, bearer });

	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: options.port ?? (Number(process.env.LOCAL_MAIL_PORT) || 0),
		fetch(req): Response | Promise<Response> {
			const url = new URL(req.url);

			// Host check first: the DNS-rebinding kill switch. Every request must
			// name this exact loopback origin (the Vite proxy rewrites Host to
			// match via changeOrigin, so dev passes too).
			const expectedHost = `127.0.0.1:${server.port}`;
			if (req.headers.get('host') !== expectedHost) {
				return new Response('Forbidden', { status: 403 });
			}

			if (url.pathname.startsWith('/api/')) return api.fetch(req);
			const origin = `http://127.0.0.1:${server.port}`;
			return serveStatic(uiDist, url.pathname, origin, bearer);
		},
	});

	// One background sync loop per account this host won the lock for, each
	// serialized through its own gate (the same gate its POST .../sync rides).
	// An account whose loop is owned elsewhere is still served; that other owner
	// keeps its mirror fresh.
	for (const engine of engines) {
		if (!engine.lock) {
			console.error(
				`[sync ${engine.runtime.accountEmail}] loop owned elsewhere; serving reads only.`,
			);
			continue;
		}
		const { session, gate, runtime } = engine;
		(async () => {
			while (!controller.signal.aborted) {
				await gate(() => syncMailbox(session.deps, { forceFull: false })).catch(
					(cause) =>
						console.error(
							`[sync ${runtime.accountEmail}] loop pass failed: ${cause}`,
						),
				);
				if (controller.signal.aborted) break;
				await Bun.sleep(SYNC_INTERVAL_MS);
			}
		})();
	}

	const origin = `http://127.0.0.1:${server.port}`;
	// Publish presence so the Vite dev server (and, later, a routed one-shot
	// `sync`) can find this host's origin and bearer. Presence, not spawn.
	writePresence({ origin, bearer, pid: process.pid }, config.dataDir);
	// stdout carries only the origin, so a caller can capture it; the hint goes
	// to stderr. No browser is launched: opening the window is the host's job
	// (a terminal today, Tauri later), not the engine's.
	console.log(origin);
	console.error(
		`Local Mail runtime host listening on ${origin} for ${engines.length} account(s): ${engines
			.map((engine) => engine.runtime.accountEmail)
			.join(', ')}. Open it in your browser.`,
	);
	if (!existsSync(uiDist)) {
		console.error(
			`Note: ${uiDist} does not exist yet. Build the SPA with "bun run --cwd apps/local-mail/ui build".`,
		);
	}

	await new Promise<void>((resolve) => {
		process.on('SIGINT', () => {
			controller.abort();
			server.stop();
			for (const engine of engines) {
				engine.session.close();
				engine.lock?.release();
			}
			clearPresence(config.dataDir);
			resolve();
		});
	});
	return 0;
}
