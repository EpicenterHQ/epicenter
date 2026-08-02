/**
 * Multi-account `/api` surface tests (`createApiApp`).
 *
 * The desktop host serves every connected mailbox under one loopback origin, so
 * these prove the account-scoped routing: `GET /api/accounts` lists the loaded
 * set, `/api/accounts/:account/*` reads are isolated per account, an unknown
 * `:account` is a 404, the bearer gate refuses a wrong/absent bearer, and a
 * `POST .../sync` on an account whose loop is owned elsewhere yields busy rather
 * than racing a second bulk pull.
 *
 * Only the read/status/list surface and the sync-busy yield are exercised here
 * (a real Gmail client would be needed for modify/trash); that is the smallest
 * surface that proves N accounts compose under one app.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../config.ts';
import { type MailDb, openMailDb } from '../db.ts';
import type { GmailClient } from '../gmail-client.ts';
import { type IntentDb, openIntentDb } from '../intent.ts';
import type { ReconcileDeps } from '../reconcile.ts';
import type { LocalMailRuntime } from '../runtime.ts';
import type { GmailMessage } from '../schema.ts';
import type { TokenStore } from '../token-store.ts';
import { type AccountApi, createApiApp } from './api.ts';

const BEARER = 'test-bearer';

function config(dataDir: string): AppConfig {
	return {
		dataDir,
		apiBase: 'http://localhost:0',
		authorizeUrl: 'http://localhost:0/auth',
		tokenUrl: 'http://localhost:0/token',
		historySafeWindowDays: 5,
		fullBackstopDays: 30,
		pageSize: 100,
		credentialsPath: join(dataDir, 'credentials.json'),
		account: null,
		readOnly: false,
	};
}

// A store that reports no stored token: status still resolves (reads are
// token-free), it just reports `connected: false`, which these tests do not assert.
const store: TokenStore = {
	async get() {
		return null;
	},
	async listAccounts() {
		return [];
	},
	async set() {},
};

function message(id: string, subject: string): GmailMessage {
	return {
		id,
		threadId: `t-${id}`,
		labelIds: ['INBOX'],
		snippet: `snippet ${id}`,
		payload: { headers: [{ name: 'Subject', value: subject }] },
	};
}

/**
 * Build one account's `AccountApi` slice backed by a real on-disk mirror and
 * intent store under the shared data dir (the arrangement the host uses: one
 * dir, one subdir per account). `ownsLoop` defaults true; the gate is a
 * passthrough, and the wake is recorded rather than run.
 */
function account(
	dataDir: string,
	accountEmail: string,
	seed: { messageId: string; subject: string; label: string },
	ownsLoop = true,
): { api: AccountApi; db: MailDb; intent: IntentDb; wakes: number } {
	const db = openMailDb({ dataDir, accountEmail });
	const intent = openIntentDb({ dataDir, accountEmail });
	const syncedAt = '2026-07-08T00:00:00.000Z';
	db.ingestFullPullPage([message(seed.messageId, seed.subject)], syncedAt);
	db.ingestLabels(
		[
			{ id: seed.label, name: seed.label, type: 'user' },
			{ id: 'INBOX', name: 'INBOX', type: 'system' },
		],
		syncedAt,
	);
	db.finishFullPull('1000', syncedAt);
	const runtime: LocalMailRuntime = {
		config: config(dataDir),
		store,
		accountEmail,
	};
	const deps: ReconcileDeps = {
		db,
		intent,
		// No route here calls Gmail: reads answer from the mirror, and an act is a
		// local write. Only a reconcile pass would need a client, and the only
		// reconcile exercised here is the busy yield, which returns before the pass.
		client: {} as unknown as GmailClient,
		config: runtime.config,
		now: () => Date.parse(syncedAt),
	};
	const created = {
		db,
		intent,
		wakes: 0,
		api: {
			runtime,
			deps,
			gate: (fn: () => Promise<unknown>) => fn(),
			requestWake: () => {
				created.wakes += 1;
			},
			ownsLoop,
		} as AccountApi,
	};
	return created;
}

function tempDir(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), 'local-mail-api-test-'));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function get(
	app: ReturnType<typeof createApiApp>,
	path: string,
	bearer = BEARER,
) {
	return app.fetch(
		new Request(`http://127.0.0.1${path}`, {
			headers: { authorization: `Bearer ${bearer}` },
		}),
	);
}

describe('createApiApp multi-account routing', () => {
	test('GET /api/accounts lists every loaded account, sorted', async () => {
		const tmp = tempDir();
		const a = account(tmp.dir, 'b@example.com', {
			messageId: 'mb',
			subject: 'B',
			label: 'LB',
		});
		const b = account(tmp.dir, 'a@example.com', {
			messageId: 'ma',
			subject: 'A',
			label: 'LA',
		});
		const app = createApiApp({
			accounts: new Map([
				['b@example.com', a.api],
				['a@example.com', b.api],
			]),
			readOnly: false,
			bearer: BEARER,
		});

		const res = await get(app, '/api/accounts');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			accounts: ['a@example.com', 'b@example.com'],
		});

		a.db.close();
		a.intent.close();
		b.db.close();
		b.intent.close();
		tmp.cleanup();
	});

	test('account-scoped reads are isolated to the named account', async () => {
		const tmp = tempDir();
		const a = account(tmp.dir, 'a@example.com', {
			messageId: 'ma',
			subject: 'Alpha',
			label: 'LA',
		});
		const b = account(tmp.dir, 'b@example.com', {
			messageId: 'mb',
			subject: 'Beta',
			label: 'LB',
		});
		const app = createApiApp({
			accounts: new Map([
				['a@example.com', a.api],
				['b@example.com', b.api],
			]),
			readOnly: false,
			bearer: BEARER,
		});

		const statusA = (await (
			await get(app, '/api/accounts/a@example.com/status')
		).json()) as {
			accountEmail: string;
			mirror: string;
			rows: { messages: number };
			pending: { assertions: number; oldestAssertedAt: string | null };
		};
		expect(statusA.accountEmail).toBe('a@example.com');
		expect(statusA.mirror).toBe('ready');
		expect(statusA.rows.messages).toBe(1);
		expect(statusA.pending).toEqual({ assertions: 0, oldestAssertedAt: null });

		const messagesB = (await (
			await get(app, '/api/accounts/b@example.com/messages')
		).json()) as { messages: { id: string }[] };
		expect(messagesB.messages.map((m) => m.id)).toEqual(['mb']);

		const labelsA = (await (
			await get(app, '/api/accounts/a@example.com/labels')
		).json()) as { labels: { id: string }[] };
		expect(labelsA.labels.map((l) => l.id)).toContain('LA');
		expect(labelsA.labels.map((l) => l.id)).not.toContain('LB');

		a.db.close();
		a.intent.close();
		b.db.close();
		b.intent.close();
		tmp.cleanup();
	});

	test('an unknown account is a 404 AccountNotFound', async () => {
		const tmp = tempDir();
		const a = account(tmp.dir, 'a@example.com', {
			messageId: 'ma',
			subject: 'A',
			label: 'LA',
		});
		const app = createApiApp({
			accounts: new Map([['a@example.com', a.api]]),
			readOnly: false,
			bearer: BEARER,
		});

		const res = await get(app, '/api/accounts/nobody@example.com/status');
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { name: string } };
		expect(body.error.name).toBe('AccountNotFound');

		a.db.close();
		a.intent.close();
		tmp.cleanup();
	});

	test('a wrong or absent bearer is a 401 before any account lookup', async () => {
		const tmp = tempDir();
		const a = account(tmp.dir, 'a@example.com', {
			messageId: 'ma',
			subject: 'A',
			label: 'LA',
		});
		const app = createApiApp({
			accounts: new Map([['a@example.com', a.api]]),
			readOnly: false,
			bearer: BEARER,
		});

		const wrong = await get(app, '/api/accounts', 'nope');
		expect(wrong.status).toBe(401);

		const absent = await app.fetch(
			new Request('http://127.0.0.1/api/accounts'),
		);
		expect(absent.status).toBe(401);

		a.db.close();
		a.intent.close();
		tmp.cleanup();
	});

	test('POST reconcile yields busy when this host does not own the account loop', async () => {
		const tmp = tempDir();
		const a = account(
			tmp.dir,
			'a@example.com',
			{ messageId: 'ma', subject: 'A', label: 'LA' },
			false,
		);
		const app = createApiApp({
			accounts: new Map([['a@example.com', a.api]]),
			readOnly: false,
			bearer: BEARER,
		});

		const res = await app.fetch(
			new Request('http://127.0.0.1/api/accounts/a@example.com/reconcile', {
				method: 'POST',
				headers: { authorization: `Bearer ${BEARER}` },
			}),
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			reconciled: false,
			reason: 'reconcile-owner-active',
		});

		a.db.close();
		a.intent.close();
		tmp.cleanup();
	});
});

describe('POST /messages/assert', () => {
	function post(
		app: ReturnType<typeof createApiApp>,
		path: string,
		body: unknown,
	) {
		return app.fetch(
			new Request(`http://127.0.0.1${path}`, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${BEARER}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify(body),
			}),
		);
	}

	test('an act is recorded, wakes the reconciler, and shows up in the very next read', async () => {
		const tmp = tempDir();
		const a = account(tmp.dir, 'a@example.com', {
			messageId: 'ma',
			subject: 'Alpha',
			label: 'LA',
		});
		const app = createApiApp({
			accounts: new Map([['a@example.com', a.api]]),
			readOnly: false,
			bearer: BEARER,
		});

		const before = (await (
			await get(app, '/api/accounts/a@example.com/messages?label=INBOX')
		).json()) as { messages: { id: string }[] };
		expect(before.messages.map((m) => m.id)).toEqual(['ma']);

		const res = await post(app, '/api/accounts/a@example.com/messages/assert', {
			ids: ['ma'],
			removeLabels: ['INBOX'],
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ asserted: 1 });
		expect(a.wakes).toBe(1);

		// The same act is now visible as undelivered work on the status surface,
		// in aggregate: how much, and how long the oldest has waited.
		const status = (await (
			await get(app, '/api/accounts/a@example.com/status')
		).json()) as {
			pending: { assertions: number; oldestAssertedAt: string | null };
		};
		expect(status.pending.assertions).toBe(1);
		expect(status.pending.oldestAssertedAt).not.toBeNull();
		expect(a.intent.pending()).toMatchObject([
			{ messageId: 'ma', labelId: 'INBOX', want: false },
		]);

		// No Gmail call happened (the client is a stub that would throw), and the
		// inbox is already empty: the read model composed the act before filtering.
		const after = (await (
			await get(app, '/api/accounts/a@example.com/messages?label=INBOX')
		).json()) as { messages: { id: string }[] };
		expect(after.messages).toEqual([]);

		a.db.close();
		a.intent.close();
		tmp.cleanup();
	});

	test('read-only refuses the act, records nothing, and asks for no wake', async () => {
		const tmp = tempDir();
		const a = account(tmp.dir, 'a@example.com', {
			messageId: 'ma',
			subject: 'Alpha',
			label: 'LA',
		});
		const app = createApiApp({
			accounts: new Map([['a@example.com', a.api]]),
			readOnly: true,
			bearer: BEARER,
		});

		const res = await post(app, '/api/accounts/a@example.com/messages/assert', {
			ids: ['ma'],
			removeLabels: ['INBOX'],
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { name: string } };
		expect(body.error.name).toBe('AssertFailed');
		expect(a.intent.pending()).toEqual([]);
		expect(a.wakes).toBe(0);

		a.db.close();
		a.intent.close();
		tmp.cleanup();
	});
});
