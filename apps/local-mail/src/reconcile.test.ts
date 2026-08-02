/**
 * The reconciler's drain phase: the only place in Local Mail that writes to
 * Gmail. These pin the delivery contract:
 *
 * - One message's opinions become ONE `messages.modify`, with trash routed to
 *   Gmail's own endpoint at delivery and never smuggled into a label set.
 * - Retirement requires the sequence that was delivered, so an act made while a
 *   delivery is in flight survives it.
 * - A per-target refusal (400/404) resolves that assertion and the loop
 *   continues; a systemic failure stops delivery and keeps every assertion, with
 *   nothing written down about the failure itself.
 * - Read-only skips delivery entirely.
 *
 * The pull phase is `sync.ts`, tested there; the fake client below returns an
 * empty history so a pass ends quickly.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from './config.ts';
import { type MailDb, openMailDb } from './db.ts';
import { GmailApiError, type GmailClient } from './gmail-client.ts';
import { type IntentDb, openIntentDb } from './intent.ts';
import { type ReconcileDeps, reconcileAccount } from './reconcile.ts';
import type { GmailLabel, GmailMessage, HistoryPage } from './schema.ts';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');

function message(id: string, labelIds: string[]): GmailMessage {
	return {
		id,
		threadId: `t-${id}`,
		labelIds,
		snippet: `snippet ${id}`,
		internalDate: '1700000000000',
		payload: { headers: [{ name: 'Subject', value: `Subject ${id}` }] },
	};
}

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

type WriteResult =
	| { data: GmailMessage }
	| {
			error: NonNullable<
				Awaited<ReturnType<GmailClient['modifyMessage']>>['error']
			>;
	  };

type FakeGmail = GmailClient & {
	modifyCalls: {
		id: string;
		addLabelIds: string[];
		removeLabelIds: string[];
	}[];
	trashCalls: string[];
	untrashCalls: string[];
};

/**
 * A Gmail client whose write endpoints are scripted per message id and whose
 * read endpoints report an unchanged mailbox, so the pull phase is a no-op.
 * `onWrite` fires before the scripted result is returned, which is how the
 * mid-flight re-assertion test injects an act into the middle of a delivery.
 */
function fakeGmail(
	results: Map<string, WriteResult>,
	onWrite?: (id: string) => void,
): FakeGmail {
	const modifyCalls: FakeGmail['modifyCalls'] = [];
	const trashCalls: string[] = [];
	const untrashCalls: string[] = [];
	const lookup = (id: string) => {
		onWrite?.(id);
		const result = results.get(id);
		if (!result) return GmailApiError.Http({ status: 404, body: 'not found' });
		return 'error' in result
			? { data: null, error: result.error }
			: { data: result.data, error: null };
	};
	return {
		modifyCalls,
		trashCalls,
		untrashCalls,
		async modifyMessage(id, body) {
			modifyCalls.push({ id, ...body });
			return lookup(id);
		},
		async trashMessage(id) {
			trashCalls.push(id);
			return lookup(id);
		},
		async untrashMessage(id) {
			untrashCalls.push(id);
			return lookup(id);
		},
		async listMessageIds() {
			return { data: { ids: [] }, error: null };
		},
		async getMessage() {
			return GmailApiError.Http({ status: 404, body: 'not found' });
		},
		async listHistory(): Promise<{ data: HistoryPage; error: null }> {
			return { data: { historyId: '1' }, error: null };
		},
		async listLabels(): Promise<{ data: GmailLabel[]; error: null }> {
			return { data: [], error: null };
		},
		async getProfile() {
			return { data: { historyId: '1' }, error: null };
		},
	};
}

function setup(
	client: GmailClient,
	messages: GmailMessage[] = [message('m1', ['INBOX', 'UNREAD'])],
): { deps: ReconcileDeps; db: MailDb; intent: IntentDb; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), 'local-mail-reconcile-'));
	const db = openMailDb({ dataDir: dir, accountEmail: 'you@example.com' });
	const intent = openIntentDb({
		dataDir: dir,
		accountEmail: 'you@example.com',
	});
	const syncedAt = new Date(NOW).toISOString();
	db.ingestFullPullPage(messages, syncedAt);
	// A cursor plus a recent sync keeps the pull phase INCREMENTAL, so these
	// tests exercise delivery rather than a full backfill.
	db.finishFullPull('1', syncedAt);
	return {
		deps: { db, intent, client, config: config(dir), now: () => NOW },
		db,
		intent,
		cleanup: () => {
			intent.close();
			db.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

const pass = (deps: ReconcileDeps, readOnly = false) =>
	reconcileAccount(deps, { forceFull: false, readOnly });

describe('drain', () => {
	test('one message with several opinions becomes one modify call', async () => {
		const client = fakeGmail(
			new Map([['m1', { data: message('m1', ['STARRED']) }]]),
		);
		const { deps, intent, cleanup } = setup(client);
		try {
			intent.assert([
				{ messageId: 'm1', labelId: 'INBOX', want: false },
				{ messageId: 'm1', labelId: 'UNREAD', want: false },
				{ messageId: 'm1', labelId: 'STARRED', want: true },
			]);

			const { delivery } = await pass(deps);

			expect(client.modifyCalls).toEqual([
				{
					id: 'm1',
					addLabelIds: ['STARRED'],
					removeLabelIds: ['INBOX', 'UNREAD'],
				},
			]);
			expect(delivery).toMatchObject({
				pending: 3,
				delivered: 3,
				retained: 0,
				failure: null,
			});
			expect(intent.pending()).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test("Gmail's response updates the mirror before the assertion is retired", async () => {
		const client = fakeGmail(
			new Map([['m1', { data: message('m1', ['UNREAD']) }]]),
		);
		const { deps, db, cleanup } = setup(client);
		try {
			deps.intent.assert([{ messageId: 'm1', labelId: 'INBOX', want: false }]);
			await pass(deps);
			// The overlay is gone and the fact took its place, so the row never
			// flickers back into the inbox between the two writes.
			expect(db.mirroredLabelIds('m1')).toEqual(['UNREAD']);
			expect(
				db.listMessages({ labelId: 'INBOX', limit: 10, offset: 0 }),
			).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test('a TRASH assertion routes to messages.trash and stays out of the label set', async () => {
		const client = fakeGmail(
			new Map([['m1', { data: message('m1', ['TRASH']) }]]),
		);
		const { deps, intent, cleanup } = setup(client);
		try {
			intent.assert([
				{ messageId: 'm1', labelId: 'UNREAD', want: false },
				{ messageId: 'm1', labelId: 'TRASH', want: true },
			]);

			await pass(deps);

			expect(client.trashCalls).toEqual(['m1']);
			expect(client.untrashCalls).toEqual([]);
			// Labels are delivered first, and TRASH never appears in either set.
			expect(client.modifyCalls).toEqual([
				{ id: 'm1', addLabelIds: [], removeLabelIds: ['UNREAD'] },
			]);
			expect(intent.pending()).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test('a TRASH assertion of want=false routes to messages.untrash', async () => {
		const client = fakeGmail(
			new Map([['m1', { data: message('m1', ['INBOX']) }]]),
		);
		const { deps, intent, cleanup } = setup(client, [message('m1', ['TRASH'])]);
		try {
			intent.assert([{ messageId: 'm1', labelId: 'TRASH', want: false }]);
			await pass(deps);
			expect(client.untrashCalls).toEqual(['m1']);
			expect(client.modifyCalls).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test('an act made mid-delivery survives the delivery it raced', async () => {
		let intent: IntentDb | undefined;
		const client = fakeGmail(
			new Map([['m1', { data: message('m1', ['UNREAD']) }]]),
			// The user un-archives while the archive is on the wire.
			() => intent?.assert([{ messageId: 'm1', labelId: 'INBOX', want: true }]),
		);
		const created = setup(client);
		intent = created.intent;
		try {
			intent.assert([{ messageId: 'm1', labelId: 'INBOX', want: false }]);

			const { delivery } = await pass(created.deps);

			// The delivery proved the OLD sequence, so it retired nothing, and the
			// newer wish is still owed.
			expect(delivery).toMatchObject({ pending: 1, delivered: 0, retained: 1 });
			expect(intent.pending()).toMatchObject([
				{ messageId: 'm1', labelId: 'INBOX', want: true },
			]);
		} finally {
			created.cleanup();
		}
	});

	test('a per-target refusal resolves that assertion and delivery continues', async () => {
		const client = fakeGmail(
			new Map<string, WriteResult>([
				[
					'm1',
					{ error: GmailApiError.Http({ status: 404, body: 'gone' }).error },
				],
				['m2', { data: message('m2', []) }],
			]),
		);
		const { deps, intent, cleanup } = setup(client, [
			message('m1', ['INBOX']),
			message('m2', ['INBOX']),
		]);
		try {
			intent.assert([
				{ messageId: 'm1', labelId: 'INBOX', want: false },
				{ messageId: 'm2', labelId: 'INBOX', want: false },
			]);

			const { delivery } = await pass(deps);

			expect(client.modifyCalls.map((call) => call.id)).toEqual(['m1', 'm2']);
			expect(delivery).toMatchObject({
				pending: 2,
				delivered: 1,
				unachievable: 1,
				retained: 0,
				failure: null,
			});
			// Nothing about the refusal is written down: the store holds wishes, not
			// a dead-letter queue.
			expect(intent.pending()).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test('a systemic failure stops delivery and keeps every undelivered assertion', async () => {
		const client = fakeGmail(
			new Map<string, WriteResult>([
				['m1', { error: GmailApiError.Throttled({ retries: 5 }).error }],
				['m2', { data: message('m2', []) }],
			]),
		);
		const { deps, intent, cleanup } = setup(client, [
			message('m1', ['INBOX']),
			message('m2', ['INBOX']),
		]);
		try {
			intent.assert([
				{ messageId: 'm1', labelId: 'INBOX', want: false },
				{ messageId: 'm2', labelId: 'INBOX', want: false },
			]);

			const { delivery, pull } = await pass(deps);

			// m2 was never attempted: the connection, not the target, is the problem.
			expect(client.modifyCalls.map((call) => call.id)).toEqual(['m1']);
			expect(delivery).toMatchObject({
				pending: 2,
				delivered: 0,
				unachievable: 0,
				retained: 2,
			});
			expect(delivery.failure?.name).toBe('Throttled');
			expect(intent.pending()).toHaveLength(2);
			// The pull still runs: a failure to write is not a reason to stop reading.
			expect(pull.failure).toBeNull();
		} finally {
			cleanup();
		}
	});

	test('read-only mode delivers nothing and keeps every assertion', async () => {
		const client = fakeGmail(new Map([['m1', { data: message('m1', []) }]]));
		const { deps, intent, cleanup } = setup(client);
		try {
			intent.assert([{ messageId: 'm1', labelId: 'INBOX', want: false }]);

			const { delivery, pull } = await pass(deps, true);

			expect(client.modifyCalls).toEqual([]);
			expect(client.trashCalls).toEqual([]);
			expect(delivery).toMatchObject({
				pending: 1,
				delivered: 0,
				retained: 1,
				failure: null,
			});
			expect(intent.pending()).toHaveLength(1);
			// Reads keep working in read-only mode, so the pull still happens.
			expect(pull.failure).toBeNull();
		} finally {
			cleanup();
		}
	});

	test('a pass with nothing pending calls no write endpoint at all', async () => {
		const client = fakeGmail(new Map());
		const { deps, cleanup } = setup(client);
		try {
			const { delivery } = await pass(deps);
			expect(delivery).toEqual({
				pending: 0,
				delivered: 0,
				unachievable: 0,
				retained: 0,
				failure: null,
			});
			expect(client.modifyCalls).toEqual([]);
		} finally {
			cleanup();
		}
	});
});
