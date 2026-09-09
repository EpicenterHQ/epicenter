import { accountWorkflow } from './accounts.test-support.js';
/**
 * Connecting and removing, and what happens when the secret owner refuses.
 *
 * The registry, the credential, and the two SQLite files are addressed by one
 * `sub`, which nothing here allocates, so the tests that matter are the ones
 * about identity (a reconnected subject lands on its own rows by arithmetic)
 * and about an owner refusing (a row without a credential must not read as
 * connected, and a removal that cannot finish must leave everything standing).
 */

import { expect, test } from 'bun:test';
import type { AppSqliteDatabase, Device, SecretStore } from '@epicenter/device';
import { Ok } from 'wellcrafted/result';
import {
	assertAccountLabel,
	discardPending,
	finishConnect,
	listAccounts,
	removeAccount,
	withMailbox,
} from './accounts.ts';
import { createTestAppSqlite } from './app-sqlite.test-support.ts';
import { DEFAULT_MAIL_CONFIG } from './config.ts';
import { openIntentStore } from './intent-store.ts';
import type { AuthorizationRequest } from './oauth.ts';
import {
	LOCAL_MAIL_APP_ID,
	LOCAL_SCHEMA,
	MAIL_CACHE_SCHEMA,
	requireAccountFiling,
} from './storage.ts';

const IDENTITY = { clientId: 'client-id-123', clientSecret: 'client-secret' };
const NOW = () => Date.parse('2026-07-01T00:00:00.000Z');

/** An id_token the way a client reads one back from the token endpoint. */
function idToken(sub: string, email: string): string {
	const encode = (value: unknown) =>
		Buffer.from(JSON.stringify(value)).toString('base64url');
	const issued = Math.floor(Date.now() / 1000);
	return `${encode({ alg: 'RS256' })}.${encode({
		iss: 'https://accounts.google.com',
		aud: IDENTITY.clientId,
		exp: issued + 3600,
		iat: issued,
		sub,
		email,
	})}.signature`;
}

function secretStore(options: { refuse?: 'put' | 'delete' } = {}) {
	const held = new Map<string, string>();
	const refused = () =>
		({
			data: null,
			error: {
				name: 'StorageFailed',
				message: 'The secret owner failed.',
				cause: 'test',
			},
		}) as ReturnType<SecretStore['put']> extends Promise<infer R> ? R : never;
	const secrets: SecretStore = {
		put: async (accountId, value) => {
			if (options.refuse === 'put') return refused();
			held.set(accountId, value);
			return Ok(undefined);
		},
		get: async (accountId) => Ok(held.get(accountId) ?? null),
		delete: async (accountId) => {
			if (options.refuse === 'delete') return refused();
			held.delete(accountId);
			return Ok(undefined);
		},
	};
	return { secrets, held };
}

/**
 * The application over in-memory databases, with one mail file per subject.
 *
 * `deleted` records what `forgetMail` unlinked, because on this fixture the
 * unlink is the only observable half of it: an in-memory database has no path,
 * so what a test can check is that the application asked for the right name and
 * stopped holding the handle.
 */
async function openApp(options: { refuse?: 'put' | 'delete' } = {}) {
	const local = createTestAppSqlite();
	for (const sql of LOCAL_SCHEMA) await local.run(sql);
	const mailboxes = new Map<string, ReturnType<typeof createTestAppSqlite>>();
	const deleted: string[] = [];
	async function mail(sub: string): Promise<AppSqliteDatabase> {
		const existing = mailboxes.get(sub);
		if (existing !== undefined) return existing;
		const opened = createTestAppSqlite();
		for (const sql of MAIL_CACHE_SCHEMA) await opened.run(sql);
		mailboxes.set(sub, opened);
		return opened;
	}

	const { secrets, held } = secretStore(options);
	const device = {
		appId: LOCAL_MAIL_APP_ID,
		secrets,
	} as unknown as Device;

	const app = accountWorkflow({
		device,
		storage: {
			local,
			mail,
			forgetMail: async (sub) => {
				deleted.push(requireAccountFiling(sub).database);
				mailboxes.get(sub)?.close();
				mailboxes.delete(sub);
			},
		},
		identity: IDENTITY,
		config: DEFAULT_MAIL_CONFIG,
		now: NOW,
	});
	return {
		app,
		held,
		local,
		deleted,
		mail,
		close: () => {
			local.close();
			for (const database of mailboxes.values()) database.close();
		},
	};
}

/** A token endpoint that answers one authorization with `sub` and `email`. */
function googleServing(sub: string, email: string, refreshToken: string) {
	return Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: () =>
			Response.json({
				token_type: 'Bearer',
				access_token: 'access-token',
				refresh_token: refreshToken,
				expires_in: 3600,
				id_token: idToken(sub, email),
			}),
	});
}

function authorization(tokenUrl: string): {
	request: AuthorizationRequest;
	callbackUrl: URL;
} {
	const redirectUri = 'http://127.0.0.1:39130/apps/mail/connected';
	const callbackUrl = new URL(redirectUri);
	callbackUrl.searchParams.set('code', 'auth-code');
	callbackUrl.searchParams.set('state', 'state-value');
	return {
		request: {
			authorizeUrl: `${tokenUrl}?x=1`,
			state: 'state-value',
			codeVerifier: 'verifier-'.padEnd(48, 'x'),
			redirectUri,
		},
		callbackUrl,
	};
}

test('reconnecting one Google subject lands on the row it already has', async () => {
	const opened = await openApp();
	const server = googleServing('google-sub-1', 'you@example.com', 'refresh-1');
	const tokenUrl = `http://127.0.0.1:${server.port}/token`;
	opened.app.config = { ...DEFAULT_MAIL_CONFIG, tokenUrl };
	try {
		const first = await finishConnect(opened.app, authorization(tokenUrl));
		if (first.error !== null) throw first.error;

		// The person's address changed at Google; the subject did not.
		server.stop(true);
		const second = googleServing(
			'google-sub-1',
			'new@example.com',
			'refresh-2',
		);
		opened.app.config = {
			...DEFAULT_MAIL_CONFIG,
			tokenUrl: `http://127.0.0.1:${second.port}/token`,
		};
		const again = await finishConnect(
			opened.app,
			authorization(`http://127.0.0.1:${second.port}/token`),
		);
		second.stop(true);
		if (again.error !== null) throw again.error;

		// One row, not two, and the key is Google's subject rather than anything
		// this application allocated, so a second row is not expressible.
		expect(again.data.sub).toBe(first.data.sub);
		expect(again.data.sub).toBe('google-sub-1');
		expect(await listAccounts(opened.app)).toHaveLength(1);
		expect((await listAccounts(opened.app))[0]?.email).toBe('new@example.com');
		expect(opened.held.get(first.data.sub)).toBe('refresh-2');
	} finally {
		opened.close();
	}
});

test('a credential that did not store is a failed connection', async () => {
	const opened = await openApp({ refuse: 'put' });
	const server = googleServing('google-sub-1', 'you@example.com', 'refresh-1');
	const tokenUrl = `http://127.0.0.1:${server.port}/token`;
	opened.app.config = { ...DEFAULT_MAIL_CONFIG, tokenUrl };
	try {
		const result = await finishConnect(opened.app, authorization(tokenUrl));

		// Reporting Ok here would put an account in the switcher whose first
		// synchronization asks for re-consent with nothing to explain why.
		expect(result.error?.name).toBe('StorageFailed');
		expect(opened.held.size).toBe(0);
	} finally {
		server.stop(true);
		opened.close();
	}
});

test('a credential that would not delete stops the removal', async () => {
	const opened = await openApp();
	const server = googleServing('google-sub-1', 'you@example.com', 'refresh-1');
	const tokenUrl = `http://127.0.0.1:${server.port}/token`;
	opened.app.config = { ...DEFAULT_MAIL_CONFIG, tokenUrl };
	try {
		const connected = await finishConnect(opened.app, authorization(tokenUrl));
		if (connected.error !== null) throw connected.error;
		const { sub } = connected.data;

		// There is no `secrets.list`, so the row is the only thing that knows this
		// credential exists. Removing it after a failed delete would strand the
		// credential where nothing can ever name it again.
		const refusing = await openApp({ refuse: 'delete' });
		refusing.app.storage = opened.app.storage;
		const stopped = await removeAccount(refusing.app, sub);
		expect(stopped.error?.name).toBe('StorageFailed');
		expect(await listAccounts(opened.app)).toHaveLength(1);
		expect(opened.deleted).toEqual([]);
		refusing.close();

		const gone = await removeAccount(opened.app, sub);
		expect(gone.error).toBeNull();
		expect(await listAccounts(opened.app)).toEqual([]);
		expect(opened.held.size).toBe(0);
		expect(opened.deleted).toEqual(['mail-google-sub-1']);
	} finally {
		server.stop(true);
		opened.close();
	}
});

test('removal refuses while Gmail has not been told, and deletes nothing', async () => {
	const opened = await openApp();
	const server = googleServing('google-sub-1', 'you@example.com', 'refresh-1');
	const tokenUrl = `http://127.0.0.1:${server.port}/token`;
	opened.app.config = { ...DEFAULT_MAIL_CONFIG, tokenUrl };
	try {
		const connected = await finishConnect(opened.app, authorization(tokenUrl));
		if (connected.error !== null) throw connected.error;
		const { sub } = connected.data;

		await withMailbox(opened.app, sub, async (mailbox) => {
			await mailbox.ingestFullPullPage(
				[
					{
						id: 'm1',
						threadId: 't1',
						labelIds: ['INBOX'],
						internalDate: '1700000000000',
						payload: { headers: [] },
					} as never,
				],
				{
					historyId: 'seed',
					scanId: '2026-07-01T00:00:00.000Z',
					syncedAt: '2026-07-01T00:00:00.000Z',
					nextPageToken: null,
				},
			);
			await assertAccountLabel(opened.app, sub, {
				messageId: 'm1',
				labelId: 'INBOX',
				want: false,
			});
		});
		expect(await openIntentStore(opened.local, sub).count()).toBe(1);

		// Delivering needs the credential that removal destroys, so removal that
		// owes anything deletes nothing at all (ADR-0320).
		const refused = await removeAccount(opened.app, sub);
		expect(refused.error).toMatchObject({ name: 'OwesWork', pending: 1 });
		expect(await listAccounts(opened.app)).toHaveLength(1);
		expect(opened.held.size).toBe(1);
		expect(opened.deleted).toEqual([]);
		expect(
			(await withMailbox(opened.app, sub, (mailbox) => mailbox.counts()))
				.messages,
		).toBe(1);

		// The person chose to abandon the work rather than deliver it.
		expect(await discardPending(opened.app, sub)).toBe(1);
		const gone = await removeAccount(opened.app, sub);
		expect(gone.error).toBeNull();
		expect(await listAccounts(opened.app)).toEqual([]);
		expect(opened.held.size).toBe(0);
		expect(opened.deleted).toEqual(['mail-google-sub-1']);
		expect(await openIntentStore(opened.local, sub).count()).toBe(0);
	} finally {
		server.stop(true);
		opened.close();
	}
});

test('two accounts are two mail files, and neither reads the other', async () => {
	const opened = await openApp();
	try {
		// Connected first, because a mailbox for an account this device does not
		// hold is refused rather than answered with an empty mailbox.
		for (const sub of ['sub-one', 'sub-two']) {
			await opened.local.run(
				`INSERT INTO accounts (sub, email, connected_at)
				 VALUES (?, ?, ?)`,
				[sub, `${sub}@example.com`, '2026-07-01T00:00:00.000Z'],
			);
		}
		await withMailbox(opened.app, 'sub-one', async (one) => {
			await withMailbox(opened.app, 'sub-two', async (two) => {
				const page = (id: string) =>
					[
						{
							id,
							threadId: 't1',
							labelIds: ['INBOX'],
							internalDate: '1700000000000',
							payload: { headers: [] },
						},
					] as never;
				await one.ingestFullPullPage(page('m1'), {
					historyId: 'seed',
					scanId: '2026-07-01T00:00:00.000Z',
					syncedAt: '2026-07-01T00:00:00.000Z',
					nextPageToken: null,
				});
				await two.ingestFullPullPage(page('m2'), {
					historyId: 'seed',
					scanId: '2026-07-01T00:00:00.000Z',
					syncedAt: '2026-07-01T00:00:00.000Z',
					nextPageToken: null,
				});

				// Each account's rows went to its own database, so a statement in one
				// cannot name a row in the other. What makes that true in production is
				// the owner's one-file-per-name mapping, which `device.test.ts`
				// pins; what this checks is that the application asks for two names.
				expect(await one.hasMessage('m1')).toBe(true);
				expect(await one.hasMessage('m2')).toBe(false);
				expect(await two.hasMessage('m1')).toBe(false);
				expect((await one.counts()).messages).toBe(1);

				// The intents share one durable file, so there the scope is a column.
				await assertAccountLabel(opened.app, 'sub-one', {
					messageId: 'm1',
					labelId: 'INBOX',
					want: false,
				});
				expect(await openIntentStore(opened.local, 'sub-one').count()).toBe(1);
				expect(await openIntentStore(opened.local, 'sub-two').count()).toBe(0);
			});
		});
	} finally {
		opened.close();
	}
});

test('a removed account cannot reopen its mailbox', async () => {
	const opened = await openApp();
	const server = googleServing('google-sub-1', 'you@example.com', 'refresh-1');
	const tokenUrl = `http://127.0.0.1:${server.port}/token`;
	opened.app.config = { ...DEFAULT_MAIL_CONFIG, tokenUrl };
	try {
		const connected = await finishConnect(opened.app, authorization(tokenUrl));
		if (connected.error !== null) throw connected.error;
		const { sub } = connected.data;
		await withMailbox(opened.app, sub, async () => undefined);

		const gone = await removeAccount(opened.app, sub);
		expect(gone.error).toBeNull();

		// Holding one past the removal would be a mailbox over a file that is
		// gone, and on the desktop a write through it would recreate that file.
		await expect(
			withMailbox(opened.app, sub, async () => undefined),
		).rejects.toThrow(/No account/);
	} finally {
		server.stop(true);
		opened.close();
	}
});
