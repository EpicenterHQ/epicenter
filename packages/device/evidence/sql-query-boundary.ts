import { openSqlite } from '../../app/src/sqlite.js';
/**
 * Characterize the existing trusted SQL operation before adding saved queries.
 * Run from the repository root: bun packages/device/evidence/sql-query-boundary.ts
 * Add --webkit to exercise WebKit instead of Chromium.
 * These are gap observations, not a passing restricted-query contract suite.
 * Every database and browser profile belongs to a temporary synthetic fixture.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { build } from 'vite';
import { createBunDevice } from '../../../apps/epicenter/src/test-sqlite.js';
import { createDesktopSqliteOwner } from '../src/desktop.js';
import { createDeviceDispatcher } from '../src/owner.js';
import { installTestLocks } from '../src/test-locks.js';

const temporary = await mkdtemp(join(tmpdir(), 'local-mail-sql-boundary-'));
const engine = process.argv.includes('--webkit') ? webkit : chromium;
const appId = 'so.epicenter.sql-evidence';
type Observation = { ok: boolean; value?: unknown; error?: string };
type Call = (verb: 'run' | 'all', sql: string) => Promise<Observation>;

async function characterize(runtime: string, call: Call) {
	const observations: Record<string, Observation> = {};
	for (const sql of [
		'CREATE TABLE messages(id TEXT PRIMARY KEY, subject TEXT)',
		"INSERT INTO messages VALUES ('same-id', 'Synthetic mail')",
	]) {
		const answer = await call('run', sql);
		if (!answer.ok)
			throw new Error(`${runtime} fixture failed: ${answer.error}`);
	}
	for (const [name, sql] of Object.entries({
		version: 'SELECT sqlite_version() AS version',
		zeroRows: 'SELECT id, subject FROM messages WHERE 0',
		duplicateColumns: 'SELECT 1 AS value, 2 AS value',
		multipleStatements: 'SELECT 1 AS first; SELECT 2 AS second',
		invalidSql: 'SELECT * FROM missing_relation',
		deleteReturning: 'DELETE FROM messages RETURNING id',
		rowsAfterDelete: 'SELECT count(*) AS remaining FROM messages',
		attach: "ATTACH DATABASE ':memory:' AS escaped",
		databaseList: 'PRAGMA database_list',
		transaction: 'BEGIN',
		rollback: 'ROLLBACK',
	})) {
		observations[name] = await call('all', sql);
	}
	observations.trustedWriteAfterward = await call(
		'run',
		"INSERT INTO messages VALUES ('after', 'Still writable')",
	);
	console.log(
		JSON.stringify({ runtime, bun: Bun.version, observations }, null, 2),
	);
}

try {
	// The native fixture includes the real desktop WebSocket client, dispatcher,
	// lifetime owner, and file-backed Bun adapter. Only hosting/auth is synthetic.
	const owner = createBunDevice(join(temporary, 'native'));
	// Bun has no Web Locks; this fixture supplies only the client's page lock.
	installTestLocks();
	const dispatch = createDeviceDispatcher(owner);
	const native = Bun.serve({
		port: 0,
		fetch(request, server) {
			return server.upgrade(request)
				? undefined
				: new Response('fixture', { status: 404 });
		},
		websocket: {
			async message(socket, message) {
				const { id, request } = JSON.parse(String(message));
				try {
					socket.send(
						JSON.stringify({ id, response: await dispatch.request(request) }),
					);
				} catch (cause) {
					socket.send(
						JSON.stringify({
							id,
							failure: cause instanceof Error ? cause.message : String(cause),
						}),
					);
				}
			},
		},
	});
	const device = await openSqlite({
		owner: createDesktopSqliteOwner({
			baseURL: `http://localhost:${native.port}`,
		}),
		id: appId,
	});
	try {
		const opened = await device.open('mail-synthetic');
		if (opened.error) throw opened.error;
		await characterize('desktop WebSocket / Bun file', async (verb, sql) => {
			const answer = await opened.data[verb](sql);
			return answer.error
				? { ok: false, error: answer.error.message }
				: { ok: true, value: answer.data };
		});
	} finally {
		try {
			await device.close();
		} finally {
			try {
				await dispatch.close();
			} finally {
				native.stop(true);
			}
		}
	}

	const outDir = join(temporary, 'web');
	await build({
		configFile: false,
		root: new URL('./browser/opfs-sqlite/', import.meta.url).pathname,
		logLevel: 'warn',
		optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
		worker: { format: 'es' },
		build: { target: 'esnext', outDir, emptyOutDir: true },
	});
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const path = new URL(request.url).pathname;
			const file = Bun.file(join(outDir, path === '/' ? 'index.html' : path));
			return (await file.exists())
				? new Response(file)
				: new Response('not found', { status: 404 });
		},
	});
	let browser:
		| Awaited<ReturnType<typeof engine.launchPersistentContext>>
		| undefined;
	try {
		browser = await engine.launchPersistentContext(join(temporary, 'profile'));
		const page = await browser.newPage();
		await page.goto(`http://localhost:${server.port}`);
		await page.waitForFunction('typeof globalThis.run === "function"');
		await characterize(`${engine.name()} / OPFS worker`, (verb, sql) =>
			page.evaluate(
				async ({ verb, sql }) => {
					const api = globalThis as unknown as Record<
						'run' | 'all',
						(name: string, sql: string) => Promise<Observation>
					>;
					return api[verb]('mail-synthetic', sql);
				},
				{ verb, sql },
			),
		);
	} finally {
		await browser?.close();
		server.stop(true);
	}
} finally {
	await rm(temporary, { recursive: true, force: true });
}
