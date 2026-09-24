/** Mail attachment disposal aborts work immediately; account removal keeps its own drain. */
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

test('attachment disposal cancels queries without waiting or closing App resources', async () => {
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
		expect(f.close()).toBeUndefined();
		expect(signal.aborted).toBe(true);
		await expect(f.mail.accounts()).rejects.toThrow('closing');
		release.resolve();
		await reading;
		expect(f.close()).toBeUndefined();
		expect(
			(await f.storage.local.all('SELECT * FROM accounts')).error,
		).toBeNull();
	} finally {
		await f.cleanup();
	}
});

test('attachment disposal aborts consent without waiting for a late callback', async () => {
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
		expect(f.close()).toBeUndefined();
		expect(signal.aborted).toBe(true);
		release.resolve(new URL('http://localhost/connected'));
		await authorizing;
		await expect(f.mail.accounts()).rejects.toThrow('closing');
	} finally {
		await f.cleanup();
	}
});

test('failed triage rejects and attachment disposal does not wait for an admitted write', async () => {
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
		expect(f.close()).toBeUndefined();
		await expect(f.mail.accounts()).rejects.toThrow('closing');
		release.resolve();
		await writing;
		expect(
			(await f.storage.local.all('SELECT want FROM label_intents')).data,
		).toEqual([{ want: 0 }]);
	} finally {
		await f.cleanup();
	}
});

test('a new attachment uses new App storage after the preceding attachment closes', async () => {
	const first = await fixture();
	try {
		await first.close();
		let reads = 0;
		const close = first.attach({
			...first.app,
			sqlite: {
				...first.app.sqlite,
				async open(name) {
					reads++;
					return first.app.sqlite.open(name);
				},
			},
		});
		try {
			expect((await first.mail.accounts())[0]?.sub).toBe('one');
			expect(reads).toBeGreaterThan(0);
		} finally {
			await close();
		}
	} finally {
		await first.cleanup();
	}
});

test('a query awaiting storage keeps the disposed attachment signal after another attachment opens', async () => {
	const f = await fixture();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const originalOpen = f.app.sqlite.open;
	f.app.sqlite.open = async (name) => {
		if (name === 'local') {
			entered.resolve();
			await release.promise;
		}
		return originalOpen(name);
	};
	const database = await f.storage.mail('one');
	let aborted: boolean | undefined;
	database.query = async (_sql, options) => {
		aborted = options.signal?.aborted;
		return Ok({ columns: [], rows: [], truncated: false });
	};
	try {
		const reading = f.mail.query('one', 'select 1');
		await entered.promise;
		f.close();
		const disposeReplacement = f.attach(f.app);
		try {
			release.resolve();
			await reading;
			expect(aborted).toBe(true);
			expect((await f.mail.accounts())[0]?.sub).toBe('one');
		} finally {
			disposeReplacement();
		}
	} finally {
		await f.cleanup();
	}
});
