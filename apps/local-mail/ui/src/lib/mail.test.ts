/**
 * Mail page closure waits for admitted work and permanently refuses new work.
 * A pending open or consent operation cannot escape the desktop close barrier,
 * including when that operation fails while the page is closing.
 */
import { expect, test } from 'bun:test';
import type { Device } from '@epicenter/device';
import { openTestSession } from '../../../src/session.test-support.ts';
import { GmailApiError } from '../../../src/gmail-client.ts';
import { createMailApp, type MailApp } from '@epicenter/local-mail/accounts';
import { createMail } from './create-mail.js';

const request = {
	authorizeUrl: 'https://accounts.google.com/',
	state: 'state',
	codeVerifier: 'verifier',
	redirectUri: 'http://localhost/connected',
};

test('close waits for an admitted open to settle and refuses later operations', async () => {
	const opening = Promise.withResolvers<MailApp>();
	const releasing = Promise.withResolvers<void>();
	const releaseEntered = Promise.withResolvers<void>();
	let opens = 0;
	const mail = createMail({
		closeStorage: async () => {
			releaseEntered.resolve();
			await releasing.promise;
		},
		openApp: () => {
			opens++;
			return opening.promise;
		},
		authorization: {
			authorize: async () => new URL('http://localhost/connected'),
		},
	});
	const accounts = mail.accounts();
	const failedAccounts = accounts.catch((error: unknown) => error);
	let closed = false;
	const closing = mail.close();
	void closing.then(() => {
		closed = true;
	});
	await Promise.resolve();
	expect(opens).toBe(1);
	expect(closed).toBe(false);
	await expect(mail.accounts()).rejects.toThrow('Local Mail is closing.');
	expect(opens).toBe(1);
	opening.reject(new Error('open failed'));
	expect(await failedAccounts).toEqual(new Error('open failed'));
	await releaseEntered.promise;
	expect(closed).toBe(false);
	releasing.resolve();
	await closing;
	expect(closed).toBe(true);
	expect(mail.close()).toBe(closing);
});

test('close aborts consent but waits for the authorization owner to finish', async () => {
	const consent = Promise.withResolvers<URL>();
	const entered = Promise.withResolvers<AbortSignal>();
	const mail = createMail({
		closeStorage: async () => {},
		openApp: async () => {
			throw new Error('must not open');
		},
		authorization: {
			authorize: (_request, signal) => {
				entered.resolve(signal);
				return consent.promise;
			},
		},
	});
	const authorizing = mail.authorize(request);
	const failure = authorizing.catch((error: unknown) => error);
	const signal = await entered.promise;
	let closed = false;
	const closing = mail.close();
	void closing.then(() => {
		closed = true;
	});
	await Promise.resolve();
	expect(signal.aborted).toBe(true);
	expect(closed).toBe(false);
	consent.reject(new Error('consent stopped'));
	expect(await failure).toEqual(new Error('consent stopped'));
	await closing;
	expect(closed).toBe(true);
});

test('close waits for an admitted durable write before acknowledging closure', async () => {
	const committed = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const unused = async (): Promise<never> => {
		throw new Error('unexpected storage operation');
	};
	const app = createMailApp({
		identity: { clientId: 'test', clientSecret: 'test' },
		device: {
			close: async () => {},
			sqlite: { open: unused, delete: unused },
			secrets: { get: unused, put: unused, delete: unused },
		},
		storage: {
			local: {
				run: unused,
				all: unused,
				batch: async () => {
					entered.resolve();
					await committed.promise;
					return { data: { changes: [3] }, error: null };
				},
			},
			mail: unused,
			forgetMail: unused,
		},
	});
	const mail = createMail({
		closeStorage: async () => {},
		openApp: async () => app,
		authorization: { authorize: unused },
	});
	const discarded = mail.discard('account');
	await entered.promise;
	let closed = false;
	const closing = mail.close();
	void closing.then(() => {
		closed = true;
	});
	await Promise.resolve();
	expect(closed).toBe(false);
	committed.resolve();
	expect(await discarded).toBe(3);
	await closing;
	expect(closed).toBe(true);
});

async function outboxFixture() {
	const session = await openTestSession();
	await session.localDatabase.run(
		`INSERT INTO accounts (sub, email, connected_at) VALUES (?, 'test@example.com', 'now')`,
		[session.sub],
	);
	let cacheOpens = 0;
	const app = createMailApp({
		identity: { clientId: 'test', clientSecret: 'test' },
		device: {
			secrets: { delete: async () => ({ data: undefined, error: null }) },
		} as unknown as Device,
		storage: {
			local: session.localDatabase,
			mail: async () => {
				cacheOpens++;
				throw new Error('cache cannot open');
			},
			forgetMail: async () => {},
		},
	});
	const mail = createMail({
		openApp: async () => app,
		closeStorage: async () => {},
		authorization: {
			authorize: async () => {
				throw new Error('unexpected consent');
			},
		},
	});
	return { session, app, mail, cacheOpens: () => cacheOpens };
}

test('the public outbox remains usable when the cache cannot open and recovers subject enrichment', async () => {
	const { session, app, mail, cacheOpens } = await outboxFixture();
	try {
		expect((await mail.outbox(session.sub)).waiting).toBe(0);
		expect(cacheOpens()).toBe(0);
		await session.intents.assert(
			[{ messageId: 'm1', labelId: 'TRASH', want: true }],
			'now',
		);
		await session.passes.record({
			finishedAt: 'now',
			discarded: [],
			failure: GmailApiError.Network({ cause: 'offline' }).error,
		});
		const owed = await mail.outbox(session.sub);
		expect(owed.waiting).toBe(1);
		expect(owed.entries[0]?.subject).toBeNull();
		expect(owed.lastPass?.failure?.name).toBe('Network');
		expect(cacheOpens()).toBe(1);
		app.storage.mail = async () => session.mailboxDatabase;
		await session.mailbox.ingestFullPullPage(
			[
				{
					id: 'm1',
					threadId: 't1',
					payload: { headers: [{ name: 'Subject', value: 'Receipt' }] },
				},
			],
			'now',
		);
		expect((await mail.outbox(session.sub)).entries[0]?.subject).toBe(
			'Receipt',
		);
		const database = session.mailboxDatabase;
		app.storage.mail = async () => ({
			...database,
			all: async () => {
				throw new Error('cache query failed');
			},
		});
		expect((await mail.outbox(session.sub)).waiting).toBe(1);
		app.storage.local = {
			...session.localDatabase,
			all: async () => {
				throw new Error('durable read failed');
			},
		};
		await expect(mail.outbox(session.sub)).rejects.toThrow(
			'durable read failed',
		);
	} finally {
		await mail.close();
		session.close();
	}
});

test('removal waits for optional cache reads, refuses pending work, and needs no working cache after discard', async () => {
	const { session, app, mail } = await outboxFixture();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	try {
		await session.intents.assert(
			[{ messageId: 'm1', labelId: 'TRASH', want: true }],
			'now',
		);
		app.storage.mail = async () => {
			entered.resolve();
			await release.promise;
			throw new Error('cache unavailable');
		};
		const reading = mail.outbox(session.sub);
		await entered.promise;
		const removing = mail.remove(session.sub);
		let removed = false;
		void removing.then(() => {
			removed = true;
		});
		await Promise.resolve();
		await expect(mail.outbox(session.sub)).rejects.toThrow('being removed');
		expect(removed).toBe(false);
		release.resolve();
		expect((await reading).waiting).toBe(1);
		expect(await removing).toEqual({ removed: false, pending: 1 });
		expect(await mail.discard(session.sub)).toBe(1);
		expect(await mail.remove(session.sub)).toEqual({ removed: true });
		app.storage.mail = async () => {
			throw new Error('must not attempt a removed cache');
		};
		await expect(mail.outbox(session.sub)).rejects.toThrow(
			'No account is connected',
		);
	} finally {
		release.resolve();
		await mail.close();
		session.close();
	}
});
