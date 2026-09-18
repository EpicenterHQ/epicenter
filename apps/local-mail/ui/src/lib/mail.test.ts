import { expect, test } from 'bun:test';
import type { ScopedSqlite } from '@epicenter/device/owner';
import { Ok } from 'wellcrafted/result';
import { createTestAppSqlite } from '../../../src/app-sqlite.test-support.js';
import { openLocalMailStorage } from '../../../src/storage.js';
import { openMailDocument } from './mail.test-support.js';

async function fixture() {
	const files = new Map<string, ReturnType<typeof createTestAppSqlite>>();
	const app = {
		sqlite: {
			async open(name: string) {
				let database = files.get(name);
				if (!database) {
					database = createTestAppSqlite();
					files.set(name, database);
				}
				return Ok(database);
			},
			async delete(name: string) {
				files.get(name)?.close();
				files.delete(name);
				return Ok(undefined);
			},
		} satisfies ScopedSqlite,
		secrets: {
			get: async () => {
				throw new Error('No credential access');
			},
			put: async () => Ok(undefined),
			delete: async () => Ok(undefined),
		},
	};
	const storage = await openLocalMailStorage(app);
	await storage.local.run(
		"INSERT INTO accounts VALUES ('one', 'one@example.com', '2026-09-09')",
	);
	const document = await openMailDocument({ app });
	return {
		...document,
		app,
		storage,
		async cleanup() {
			await document.cleanup();
			for (const database of files.values()) database.close();
		},
	};
}

test('local reads and durable triage do not require Gmail credentials or identity', async () => {
	const f = await fixture();
	try {
		expect((await f.mail.accounts())[0]?.sub).toBe('one');
		expect(await f.mail.messages('one')).toEqual([]);
		await f.mail.assert('one', {
			messageId: 'message',
			labelId: 'INBOX',
			want: false,
		});
		expect(await f.mail.remove('one')).toEqual({ removed: false, pending: 1 });
		await f.mail.assert('one', {
			messageId: 'message',
			labelId: 'INBOX',
			want: true,
		});
		expect(await f.mail.discard('one')).toBe(1);
		expect(await f.mail.remove('one')).toEqual({ removed: true });
	} finally {
		await f.cleanup();
	}
});

test('a failed document storage open can be retried without recreating the document', async () => {
	const f = await fixture();
	const open = f.app.sqlite.open;
	let attempts = 0;
	f.app.sqlite.open = async (name) => {
		if (++attempts === 1) throw new Error('Storage temporarily unavailable');
		return open(name);
	};
	try {
		await expect(f.mail.accounts()).rejects.toThrow(
			'Storage temporarily unavailable',
		);
		expect((await f.mail.accounts())[0]?.sub).toBe('one');
		expect((await f.mail.accounts())[0]?.sub).toBe('one');
		expect(attempts).toBe(2);
	} finally {
		await f.cleanup();
	}
});

test('account removal drains restricted queries and query policy is fixed by Local Mail', async () => {
	const f = await fixture();
	try {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const database = await f.storage.mail('one');
		database.query = async (sql, options) => {
			expect(sql).toBe('select * from messages');
			expect(options.tables).toEqual(['messages', 'labels']);
			entered.resolve();
			await release.promise;
			return Ok({ columns: [], rows: [], truncated: false });
		};
		const reading = f.mail.query('one', 'select * from messages');
		await entered.promise;
		let removed = false;
		const removing = f.mail.remove('one').then((result) => {
			removed = true;
			return result;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(removed).toBe(false);
		await expect(f.mail.query('one', 'select 1')).rejects.toThrow(
			'being removed',
		);
		release.resolve();
		await reading;
		expect(await removing).toEqual({ removed: true });
	} finally {
		await f.cleanup();
	}
});

test('document closure cancels queries and drains admitted work without closing App resources', async () => {
	const f = await fixture();
	try {
		const entered = Promise.withResolvers<AbortSignal>();
		const release = Promise.withResolvers<void>();
		const database = await f.storage.mail('one');
		database.query = async (_sql, options) => {
			entered.resolve(options.signal!);
			await release.promise;
			return Ok({ columns: [], rows: [], truncated: false });
		};
		const reading = f.mail.query('one', 'select 1');
		const signal = await entered.promise;
		let closed = false;
		const closing = f.mail.close();
		void closing.then(() => {
			closed = true;
		});
		expect(signal.aborted).toBe(true);
		expect(closed).toBe(false);
		await expect(f.mail.accounts()).rejects.toThrow('closing');
		release.resolve();
		await reading;
		await closing;
		expect(f.mail.close()).toBe(closing);
		expect(
			(await f.storage.local.all('SELECT * FROM accounts')).error,
		).toBeNull();
	} finally {
		await f.cleanup();
	}
});

test('document closure aborts consent and waits for its owner to settle', async () => {
	const entered = Promise.withResolvers<AbortSignal>();
	const release = Promise.withResolvers<URL>();
	const f = await openMailDocument({
		app: {
			get sqlite(): never {
				throw new Error('Consent must not access SQLite.');
			},
			get secrets(): never {
				throw new Error('Consent must not access credentials.');
			},
		},
		authorization: {
			authorize: (_request, signal) => {
				entered.resolve(signal);
				return release.promise;
			},
		},
	});
	try {
		const authorizing = f.mail.authorize({
			authorizeUrl: 'https://accounts.google.com/',
			state: 'state',
			codeVerifier: 'code',
			redirectUri: 'http://localhost/connected',
		});
		const signal = await entered.promise;
		let closed = false;
		const closing = f.mail.close().then(() => {
			closed = true;
		});
		expect(signal.aborted).toBe(true);
		expect(closed).toBe(false);
		release.resolve(new URL('http://localhost/connected'));
		await authorizing;
		await closing;
		expect(closed).toBe(true);
	} finally {
		await f.cleanup();
	}
});

test('failed triage rejects and closure waits for a durable assertion before releasing the document', async () => {
	const f = await fixture();
	try {
		await f.mail.accounts();
		const original = f.storage.local.batch;
		f.storage.local.batch = async () => {
			throw new Error('disk full');
		};
		await expect(
			f.mail.assert('one', {
				messageId: 'message',
				labelId: 'INBOX',
				want: false,
			}),
		).rejects.toThrow('disk full');
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		f.storage.local.batch = async (statements) => {
			entered.resolve();
			await release.promise;
			return original(statements);
		};
		const writing = f.mail.assert('one', {
			messageId: 'message',
			labelId: 'INBOX',
			want: false,
		});
		await entered.promise;
		let closed = false;
		const closing = f.mail.close().then(() => {
			closed = true;
		});
		await Promise.resolve();
		expect(closed).toBe(false);
		release.resolve();
		await writing;
		await closing;
		expect(
			(await f.storage.local.all('SELECT want FROM label_intents')).data,
		).toEqual([{ want: 0 }]);
	} finally {
		await f.cleanup();
	}
});
