/**
 * The outbox is durable state, so these tests are mostly about what survives.
 *
 * A pass writes what it did and then the surface that ran it goes away. Every
 * test below models that literally: the record is written through one set of
 * handles and read back through a second set over the same database, which is
 * exactly what a window closing and reopening is (ADR-0327). A test that read
 * back through the same handle would pass over an in-memory cache and prove
 * nothing.
 *
 * The other half is the projection: which of the four things a person can be
 * told follows from a count and a last pass. Those are the cases where a wrong
 * answer is silent, so they are enumerated rather than sampled.
 */

import { expect, test } from 'bun:test';
import { createTestAppSqlite } from './app-sqlite.test-support.ts';
import { GmailApiError } from './gmail-client.ts';
import { openIntentStore } from './intent-store.ts';
import { openMailbox } from './mailbox.ts';
import { OAuthError } from './oauth.ts';
import { openPassRecord, readBlockedAccounts, readOutbox } from './outbox.ts';
import type { GmailMessage } from './schema.ts';
import { openTestSession } from './session.test-support.ts';
import { MAIL_CACHE_SCHEMA } from './storage.ts';
import { CacheWriteError, type SyncFailure } from './sync.ts';

const AT = '2026-09-04T12:00:00.000Z';
const LATER = '2026-09-04T12:05:00.000Z';
const SUB = 'account-one';

const failure = (result: { error: SyncFailure | null }): SyncFailure => {
	if (result.error === null) throw new Error('expected an error variant');
	return result.error;
};

const reauth = () =>
	failure(OAuthError.ReauthRequired({ reason: 'the grant was revoked' }));
const offline = () => failure(GmailApiError.Network({ cause: 'no route' }));
const refused = () =>
	failure(GmailApiError.Http({ status: 400, body: 'invalid label id' }));

function message(id: string, subject: string): GmailMessage {
	return {
		id,
		threadId: `t-${id}`,
		labelIds: ['INBOX'],
		snippet: `snippet ${id}`,
		payload: { headers: [{ name: 'Subject', value: subject }] },
	} as GmailMessage;
}

const report = (
	over: Partial<
		Parameters<ReturnType<typeof openPassRecord>['record']>[0]
	> = {},
) => ({
	finishedAt: AT,
	discarded: [],
	failure: null,
	...over,
});

test('nothing has ever run, so the outbox says so rather than guessing', async () => {
	const session = await openTestSession(SUB);
	try {
		const outbox = await readOutbox(session);
		expect(outbox.status).toBe('clear');
		// The absence is the point: an account whose first pass has not happened
		// is not an account whose last pass succeeded.
		expect(outbox.lastPass).toBeNull();
		expect(outbox.waiting).toBe(0);
	} finally {
		session.close();
	}
});

test('a sign-in failure is still there after the surface that saw it is gone', async () => {
	const session = await openTestSession(SUB);
	try {
		await session.intents.assert(
			[{ messageId: 'm1', labelId: 'INBOX', want: false }],
			AT,
		);
		await session.passes.record(report({ failure: reauth() }));

		// A second window, over the same durable file. Nothing in memory carries
		// across, which is the whole claim being tested.
		const reopened = {
			intents: openIntentStore(session.localDatabase, SUB),
			mailbox: openMailbox(session.mailboxDatabase),
			passes: openPassRecord(session.localDatabase, SUB),
		};
		const outbox = await readOutbox(reopened);
		expect(outbox.status).toBe('signin');
		expect(outbox.lastPass?.failure).toMatchObject({
			kind: 'signin',
			name: 'ReauthRequired',
		});
		expect(outbox.waiting).toBe(1);
	} finally {
		session.close();
	}
});

test('an expired sign-in is reported even with nothing waiting behind it', async () => {
	const session = await openTestSession(SUB);
	try {
		await session.passes.record(report({ failure: reauth() }));
		// Every act made from now on would pile up silently, so this is the one
		// failure that outranks an empty outbox (ADR-0320).
		expect((await readOutbox(session)).status).toBe('signin');
	} finally {
		session.close();
	}
});

test('work clears only when Gmail agreed, not when a pass merely ended', async () => {
	const session = await openTestSession(SUB);
	try {
		await session.intents.assert(
			[{ messageId: 'm1', labelId: 'INBOX', want: false }],
			AT,
		);
		await session.passes.record(report({ failure: offline() }));
		expect((await readOutbox(session)).status).toBe('failed');

		// The delivery is what clears the row, and the record only describes it.
		// Recording a clean pass while the assertion is still owed must not read
		// as finished, because the assertion is the truth about what is owed.
		await session.passes.record(report({}));
		expect((await readOutbox(session)).status).toBe('waiting');

		await session.intents.retire(await session.intents.pending());
		await session.passes.record(report({}));
		const settled = await readOutbox(session);
		expect(settled.status).toBe('clear');
		expect(settled.waiting).toBe(0);
		expect(settled.entries).toEqual([]);
	} finally {
		session.close();
	}
});

test('a failure Gmail will repeat is named as one, so Retry is not offered', async () => {
	const session = await openTestSession(SUB);
	try {
		await session.intents.assert(
			[{ messageId: 'm1', labelId: 'Label_gone', want: true }],
			AT,
		);
		const recorded = await session.passes.record(
			report({ failure: refused() }),
		);
		// The status is the same either way; the kind is what decides whether the
		// panel invites a person to press Retry.
		expect(recorded.failure?.kind).toBe('refused');
		expect((await readOutbox(session)).status).toBe('failed');
	} finally {
		session.close();
	}
});

test('a lock another writer held reads as worth trying again', async () => {
	const session = await openTestSession(SUB);
	try {
		const recorded = await session.passes.record(
			report({
				failure: failure(
					CacheWriteError.CacheBusy({ cause: { code: 'SQLITE_BUSY' } }),
				),
			}),
		);
		expect(recorded.failure?.kind).toBe('retry');
	} finally {
		session.close();
	}
});

test('an assertion Gmail refused outright survives the pass that discovered it', async () => {
	const session = await openTestSession(SUB);
	try {
		await session.passes.record(
			report({
				discarded: [
					{
						messageId: 'm1',
						labelId: 'Label_gone',
						want: true,
						status: 400,
						reason: 'invalid label id',
					},
				],
			}),
		);
		// It used to be announced in a toast and then be gone, which stops being
		// honest the moment the pass runs anywhere but in front of a person.
		const reopened = openPassRecord(session.localDatabase, SUB);
		expect((await reopened.read())?.discarded).toEqual([
			{
				messageId: 'm1',
				labelId: 'Label_gone',
				want: true,
				status: 400,
				reason: 'invalid label id',
			},
		]);
	} finally {
		session.close();
	}
});

test('the outbox names each waiting act with the message it is about', async () => {
	const session = await openTestSession(SUB);
	try {
		await session.mailbox.ingestFullPullPage(
			[message('m1', 'Re: budget review')],
			AT,
		);
		await session.intents.assert(
			[{ messageId: 'm1', labelId: 'INBOX', want: false }],
			AT,
		);
		const outbox = await readOutbox(session);
		expect(outbox.entries).toEqual([
			{
				messageId: 'm1',
				labelId: 'INBOX',
				want: false,
				assertedAt: AT,
				subject: 'Re: budget review',
			},
		]);
		expect(outbox.oldestAssertedAt).toBe(AT);
	} finally {
		session.close();
	}
});

test('undelivered work stays counted after the cache is thrown away', async () => {
	const session = await openTestSession(SUB);
	try {
		await session.mailbox.ingestFullPullPage([message('m1', 'Standup')], AT);
		await session.intents.assert(
			[{ messageId: 'm1', labelId: 'INBOX', want: false }],
			AT,
		);

		// The cache is thrown away by unlinking its file, so what a person sees
		// afterwards is an outbox read against a fresh empty one (ADR-0319).
		const replacement = createTestAppSqlite();
		for (const statement of MAIL_CACHE_SCHEMA) await replacement.run(statement);
		const outbox = await readOutbox({
			intents: session.intents,
			passes: session.passes,
			mailbox: openMailbox(replacement),
		});
		// Reporting zero here would hide a person's own work at exactly the moment
		// it is most easily lost. The subject is what is missing, and it is the
		// part Gmail can send again.
		expect(outbox.waiting).toBe(1);
		expect(outbox.status).toBe('waiting');
		expect(outbox.entries[0]?.subject).toBeNull();
		replacement.close();
	} finally {
		session.close();
	}
});

test('the record is the latest attempt, not a history of them', async () => {
	const session = await openTestSession(SUB);
	try {
		await session.passes.record(report({ failure: offline() }));
		await session.passes.record(report({ finishedAt: LATER }));

		// One row per account: the question it answers is "can my triage reach
		// Gmail", and only the latest attempt answers it.
		const reopened = openPassRecord(session.localDatabase, SUB);
		expect(await reopened.read()).toEqual({
			finishedAt: LATER,
			discarded: [],
			failure: null,
		});
	} finally {
		session.close();
	}
});

test('the switcher marks only the accounts a person has to answer for', async () => {
	// One durable file, several accounts: the mark is read from it alone, so
	// asking about every account must not open every account's mail file.
	const session = await openTestSession('expired');
	const local = session.localDatabase;
	try {
		const owe = (sub: string) =>
			openIntentStore(local, sub).assert(
				[{ messageId: 'm1', labelId: 'INBOX', want: false }],
				AT,
			);

		// Blocks even with nothing behind it: every act from now on piles up.
		await openPassRecord(local, 'expired').record(
			report({ failure: reauth() }),
		);
		// Blocks, because a person's own work is stuck behind a refusal that
		// pressing Retry will reproduce.
		await owe('refused-with-work');
		await openPassRecord(local, 'refused-with-work').record(
			report({ failure: refused() }),
		);
		// Does not block: what was refused was a pull, and the next open repeats
		// it with nobody's triage waiting on it.
		await openPassRecord(local, 'refused-clear').record(
			report({ failure: refused() }),
		);
		// Does not block: the same request later succeeds, so this is waiting
		// rather than stuck.
		await owe('offline-with-work');
		await openPassRecord(local, 'offline-with-work').record(
			report({ failure: offline() }),
		);

		const blocked = await readBlockedAccounts(local, [
			'expired',
			'refused-with-work',
			'refused-clear',
			'offline-with-work',
			// Never ran, so there is nothing to be surprised by.
			'never-opened',
		]);
		expect([...blocked].sort()).toEqual(['expired', 'refused-with-work']);
	} finally {
		session.close();
	}
});
