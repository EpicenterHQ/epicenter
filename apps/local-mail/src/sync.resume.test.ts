/**
 * Full downloads resume from committed pages after interruption. Checkpoints
 * and messages commit together; rejected tokens restart once, while ordinary
 * failures retain progress. Includes killing a process using a real SQLite file.
 */
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import { createTestAppSqlite } from './app-sqlite.test-support.js';
import { GmailApiError, type GmailClient } from './gmail-client.js';
import { openMailbox } from './mailbox.js';
import { openTestSession } from './session.test-support.js';
import { syncMailbox } from './sync.js';

const started = '2026-09-01T00:00:00.000Z';
const now = () => Date.parse('2026-09-02T00:00:00.000Z');
const checkpoint = {
	historyId: '100',
	scanId: started,
	syncedAt: started,
	nextPageToken: 'second',
};
const message = (id: string) => ({ id, threadId: id, labelIds: ['INBOX'] });

function client(): GmailClient {
	const unused = async (): Promise<never> => {
		throw new Error('Unexpected Gmail mutation');
	};
	return {
		listMessageIds: async () => ({ data: { ids: ['second'] }, error: null }),
		getMessage: async (id) => ({ data: message(id), error: null }),
		getProfile: async () => ({ data: { historyId: '200' }, error: null }),
		listHistory: async () => ({ data: { historyId: '201' }, error: null }),
		listLabels: async () => ({ data: [], error: null }),
		modifyMessage: unused,
		trashMessage: unused,
		untrashMessage: unused,
	};
}

test('a killed downloader resumes its next page without losing the first page or original baseline', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'mail-resume-'));
	const path = join(directory, 'mail.sqlite');
	const moduleUrl = (name: string) => new URL(name, import.meta.url).href;
	const child = Bun.spawn(
		[
			process.execPath,
			'-e',
			`
		import { createTestAppSqlite } from ${JSON.stringify(moduleUrl('./app-sqlite.test-support.ts'))};
		import { MAIL_CACHE_SCHEMA } from ${JSON.stringify(moduleUrl('./storage.ts'))};
		import { openMailbox } from ${JSON.stringify(moduleUrl('./mailbox.ts'))};
		import { syncMailbox } from ${JSON.stringify(moduleUrl('./sync.ts'))};
		const database = createTestAppSqlite(${JSON.stringify(path)});
		for (const sql of MAIL_CACHE_SCHEMA) {
			const result = await database.run(sql);
			if (result.error) throw result.error;
		}
		await syncMailbox({
			mailbox: openMailbox(database), now: () => Date.parse(${JSON.stringify(started)}),
			client: {
				getProfile: async () => ({ data: { historyId: '100' }, error: null }),
				listLabels: async () => ({ data: [], error: null }),
				listMessageIds: async token => {
					if (!token) return { data: { ids: ['first'], nextPageToken: 'second' }, error: null };
					console.log('waiting-for-network');
					await new Promise(resolve => setInterval(() => {}, 1000));
				},
				getMessage: async id => ({ data: { id, threadId: id, labelIds: ['INBOX'] }, error: null })
			}
		});
	`,
		],
		{ stdout: 'pipe', stderr: 'pipe' },
	);
	let database: ReturnType<typeof createTestAppSqlite> | undefined;
	try {
		const reader = child.stdout.getReader();
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toContain(
			'waiting-for-network',
		);
		reader.releaseLock();
		child.kill('SIGKILL');
		await child.exited;
		database = createTestAppSqlite(path);
		const mailbox = openMailbox(database);
		const saved = await mailbox.readFullPullCheckpoint();
		if (!saved) throw new Error('The completed page must leave a checkpoint');
		expect(saved).toEqual({ ...checkpoint, scanId: expect.any(String) });
		const remote = client();
		remote.getProfile = async () => {
			throw new Error('Must retain the original baseline');
		};
		remote.listMessageIds = async (token) => {
			expect(token).toBe('second');
			return { data: { ids: ['second'] }, error: null };
		};
		remote.listHistory = async (cursor) => {
			expect(cursor).toBe('100');
			return {
				data: {
					historyId: '201',
					history: [
						{
							id: '201',
							messagesAdded: [
								{ message: { id: 'arrived-while-closed', threadId: 'new' } },
							],
						},
					],
				},
				error: null,
			};
		};
		expect(
			(await syncMailbox({ mailbox, client: remote, now })).failure,
		).toBeNull();
		expect(
			expectOk(await database.all('SELECT id FROM messages ORDER BY id')),
		).toEqual([
			{ id: 'arrived-while-closed' },
			{ id: 'first' },
			{ id: 'second' },
		]);
		expect(
			expectOk(
				await database.all(
					"SELECT DISTINCT full_pull_id FROM messages WHERE id IN ('first', 'second')",
				),
			),
		).toEqual([{ full_pull_id: saved.scanId }]);
		expect(await mailbox.readFullPullCheckpoint()).toBeNull();
		expect((await mailbox.readCacheState()).historyId).toBe('201');
	} finally {
		child.kill('SIGKILL');
		await child.exited;
		database?.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test('failure writing a checkpoint rolls back its messages and leaves the previous continuation', async () => {
	const session = await openTestSession();
	try {
		await session.mailbox.ingestFullPullPage([message('first')], checkpoint);
		expectOk(
			await session.mailboxDatabase.run(
				`CREATE TRIGGER refuse_checkpoint BEFORE UPDATE ON full_pull_checkpoint BEGIN SELECT RAISE(ABORT, 'disk refused checkpoint'); END`,
			),
		);
		await expect(
			session.mailbox.ingestFullPullPage([message('second')], {
				...checkpoint,
				nextPageToken: 'third',
			}),
		).rejects.toBeDefined();
		expect(await session.mailbox.hasMessage('second')).toBe(false);
		expect(await session.mailbox.readFullPullCheckpoint()).toEqual(checkpoint);
	} finally {
		session.close();
	}
});

test('a committed final page finishes after reopening without fetching any page again', async () => {
	const session = await openTestSession();
	try {
		await session.mailbox.ingestFullPullPage([message('first')], {
			...checkpoint,
			nextPageToken: null,
		});
		const mailbox = openMailbox(session.mailboxDatabase);
		const remote = client();
		remote.getProfile = remote.listMessageIds = async () => {
			throw new Error('Enumeration already finished');
		};
		remote.listHistory = async (cursor) => {
			expect(cursor).toBe('100');
			return { data: { historyId: '201' }, error: null };
		};
		expect(
			(await syncMailbox({ mailbox, client: remote, now })).failure,
		).toBeNull();
		expect(await mailbox.hasMessage('first')).toBe(true);
		expect(await mailbox.readFullPullCheckpoint()).toBeNull();
	} finally {
		session.close();
	}
});

test('a rejected continuation restarts once and replaces the old scan checkpoint', async () => {
	const session = await openTestSession();
	try {
		await session.mailbox.ingestFullPullPage([message('stale')], checkpoint);
		const remote = client();
		const tokens: (string | undefined)[] = [];
		remote.listMessageIds = async (token) => {
			tokens.push(token);
			if (token)
				return GmailApiError.Http({ status: 400, body: 'Invalid page token' });
			return {
				data: { ids: ['fresh'], nextPageToken: 'also-rejected' },
				error: null,
			};
		};
		const result = await syncMailbox({
			mailbox: session.mailbox,
			client: remote,
			now,
		});
		expect(result.failure?.name).toBe('Http');
		expect(tokens).toEqual(['second', undefined, 'also-rejected']);
		expect(await session.mailbox.readFullPullCheckpoint()).toEqual({
			historyId: '200',
			scanId: expect.any(String),
			syncedAt: new Date(now()).toISOString(),
			nextPageToken: 'also-rejected',
		});
		// A failed restart must not sweep previously downloaded mail.
		expect(await session.mailbox.hasMessage('stale')).toBe(true);
		remote.listMessageIds = async (token) => {
			expect(token).toBe('also-rejected');
			return { data: { ids: ['last'] }, error: null };
		};
		expect(
			(await syncMailbox({ mailbox: session.mailbox, client: remote, now }))
				.failure,
		).toBeNull();
		expect(await session.mailbox.hasMessage('stale')).toBe(false);
		expect(await session.mailbox.hasMessage('fresh')).toBe(true);
	} finally {
		session.close();
	}
});

test('a failed restart reports pages already committed in the same pass', async () => {
	const session = await openTestSession();
	try {
		const remote = client();
		let profiles = 0;
		remote.getProfile = async () =>
			++profiles === 1
				? { data: { historyId: '100' }, error: null }
				: GmailApiError.Http({ status: 503, body: 'Unavailable' });
		remote.listMessageIds = async (token) =>
			token
				? GmailApiError.Http({ status: 400, body: 'Invalid page token' })
				: { data: { ids: ['first'], nextPageToken: 'rejected' }, error: null };
		const result = await syncMailbox({
			mailbox: session.mailbox,
			client: remote,
			now,
		});
		expect(result.failure?.name).toBe('Http');
		expect(result.messagesUpserted).toBe(1);
		expect(await session.mailbox.hasMessage('first')).toBe(true);
		expect(
			(await session.mailbox.readFullPullCheckpoint())?.nextPageToken,
		).toBe('rejected');
	} finally {
		session.close();
	}
});

test('temporary listing failures retain the continuation without restarting', async () => {
	const session = await openTestSession();
	try {
		await session.mailbox.ingestFullPullPage([message('first')], checkpoint);
		const remote = client();
		remote.getProfile = async () => {
			throw new Error('Do not restart on a temporary failure');
		};
		remote.listMessageIds = async () =>
			GmailApiError.Http({ status: 503, body: 'Unavailable' });
		expect(
			(await syncMailbox({ mailbox: session.mailbox, client: remote, now }))
				.failure?.name,
		).toBe('Http');
		expect(await session.mailbox.readFullPullCheckpoint()).toEqual(checkpoint);
	} finally {
		session.close();
	}
});

for (const clockMovesBackward of [false, true]) {
	test(`restarting a rejected scan removes messages deleted before its new baseline (${clockMovesBackward ? 'backward' : 'unchanged'} clock)`, async () => {
		const session = await openTestSession();
		try {
			const remote = client();
			let profiles = 0;
			remote.getProfile = async () => ({
				data: { historyId: ++profiles === 1 ? '100' : '200' },
				error: null,
			});
			remote.listMessageIds = async (token) => {
				if (token)
					return GmailApiError.Http({
						status: 400,
						body: 'Invalid page token',
					});
				return {
					data:
						profiles === 1
							? { ids: ['deleted-before-restart'], nextPageToken: 'rejected' }
							: { ids: ['kept'] },
					error: null,
				};
			};
			remote.listHistory = async (cursor) => {
				expect(cursor).toBe('200');
				return { data: { historyId: '201' }, error: null };
			};
			let ticks = 0;
			const result = await syncMailbox({
				mailbox: session.mailbox,
				client: remote,
				now: () => now() - (clockMovesBackward ? ticks++ * 60_000 : 0),
			});
			expect(result.failure).toBeNull();
			expect(result.messagesDeleted).toBe(1);
			expect(await session.mailbox.hasMessage('deleted-before-restart')).toBe(
				false,
			);
			expect(await session.mailbox.hasMessage('kept')).toBe(true);
		} finally {
			session.close();
		}
	});
}
