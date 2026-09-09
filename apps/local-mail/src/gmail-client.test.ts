/**
 * Gmail Client Tests
 *
 * Verifies the HTTP boundary for the Gmail REST client. These tests pin the
 * request method/body behavior that fakes in sync and modify tests do not
 * exercise.
 *
 * Key behaviors:
 * - Provider failures survive reconciliation and reopening the durable pass record
 * - Daily quotas stop immediately; temporary rate limits retain bounded retries
 * - messages.modify sends POST with the add/remove label body
 * - messages.trash/untrash POST to their endpoints with no request body
 * - Slim Gmail Message responses validate successfully
 * - one messages.get(format=full) is the entire per-message budget (ADR-0196)
 */

import { expect, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import { expectErr } from 'wellcrafted/testing';
import { type MailApp, reconcileNow } from './accounts.ts';
import type { MailConfig } from './config.ts';
import { createGmailClient } from './gmail-client.ts';
import { openPassRecord, readOutbox } from './outbox.js';
import { openTestSession } from './session.test-support.js';
import type { TokenManager } from './token-manager.ts';

const config: MailConfig = {
	apiBase: 'http://127.0.0.1:0',
	authorizeUrl: 'http://127.0.0.1:0/auth',
	tokenUrl: 'http://127.0.0.1:0/token',
	historySafeWindowDays: 5,
	fullBackstopDays: 30,
	pageSize: 100,
};

const tokens: TokenManager = {
	async getValidAccessToken() {
		return Ok('access-token-123');
	},
	async forceRefresh() {
		return Ok('access-token-123');
	},
};

test('modifyMessage sends POST body and accepts a slim message response', async () => {
	const requests: {
		method: string;
		pathname: string;
		body: unknown;
		authorization: string | null;
		accept: string | null;
		contentType: string | null;
	}[] = [];
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			requests.push({
				method: request.method,
				pathname: url.pathname,
				body: await request.json(),
				authorization: request.headers.get('authorization'),
				accept: request.headers.get('accept'),
				contentType: request.headers.get('content-type'),
			});
			return Response.json({
				id: 'm1',
				threadId: 't-m1',
				labelIds: ['INBOX', 'Label_1'],
			});
		},
	});

	try {
		const client = createGmailClient({
			config: { ...config, apiBase: `http://127.0.0.1:${server.port}` },
			tokens,
		});

		const result = await client.modifyMessage('m1', {
			addLabelIds: ['Label_1'],
			removeLabelIds: ['UNREAD'],
		});

		expect(result.error).toBeNull();
		expect(result.data).toEqual({
			id: 'm1',
			threadId: 't-m1',
			labelIds: ['INBOX', 'Label_1'],
		});
		expect(requests).toEqual([
			{
				method: 'POST',
				pathname: '/gmail/v1/users/me/messages/m1/modify',
				body: {
					addLabelIds: ['Label_1'],
					removeLabelIds: ['UNREAD'],
				},
				authorization: 'Bearer access-token-123',
				accept: 'application/json',
				contentType: 'application/json',
			},
		]);
	} finally {
		server.stop(true);
	}
});

test('trashMessage POSTs to the trash endpoint with no body and folds labelIds', async () => {
	const requests: {
		method: string;
		pathname: string;
		body: string;
		contentType: string | null;
	}[] = [];
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			requests.push({
				method: request.method,
				pathname: url.pathname,
				body: await request.text(),
				contentType: request.headers.get('content-type'),
			});
			// Gmail's trash response: TRASH added, INBOX dropped.
			return Response.json({ id: 'm1', threadId: 't-m1', labelIds: ['TRASH'] });
		},
	});

	try {
		const client = createGmailClient({
			config: { ...config, apiBase: `http://127.0.0.1:${server.port}` },
			tokens,
		});

		const result = await client.trashMessage('m1');

		expect(result.error).toBeNull();
		expect(result.data).toEqual({
			id: 'm1',
			threadId: 't-m1',
			labelIds: ['TRASH'],
		});
		expect(requests).toEqual([
			{
				method: 'POST',
				pathname: '/gmail/v1/users/me/messages/m1/trash',
				body: '',
				contentType: null,
			},
		]);
	} finally {
		server.stop(true);
	}
});

test('untrashMessage POSTs to the untrash endpoint with no body', async () => {
	const requests: { method: string; pathname: string; body: string }[] = [];
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			requests.push({
				method: request.method,
				pathname: url.pathname,
				body: await request.text(),
			});
			return Response.json({
				id: 'm1',
				threadId: 't-m1',
				labelIds: ['INBOX'],
			});
		},
	});

	try {
		const client = createGmailClient({
			config: { ...config, apiBase: `http://127.0.0.1:${server.port}` },
			tokens,
		});

		const result = await client.untrashMessage('m1');

		expect(result.error).toBeNull();
		expect(result.data).toEqual({
			id: 'm1',
			threadId: 't-m1',
			labelIds: ['INBOX'],
		});
		expect(requests).toEqual([
			{
				method: 'POST',
				pathname: '/gmail/v1/users/me/messages/m1/untrash',
				body: '',
			},
		]);
	} finally {
		server.stop(true);
	}
});

test('fetching a message spends exactly one format=full call and nothing else', async () => {
	// The invariant this app is built on (ADR-0196): one
	// `messages.get(format=full)` per message, no `format=raw` second call, and
	// no `messages.attachments.get`. `messages.get` costs 20 quota units against
	// a 6,000/minute per-user ceiling, so a second per-message call would roughly
	// double every rebuild.
	const requests: { pathname: string; format: string | null }[] = [];
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			requests.push({
				pathname: url.pathname,
				format: url.searchParams.get('format'),
			});
			return Response.json({
				id: 'm1',
				threadId: 't-m1',
				labelIds: ['INBOX'],
				payload: {
					mimeType: 'text/plain',
					// Gmail externalized this body. The client returns it as-is; nothing
					// follows up to fetch the bytes.
					body: { attachmentId: 'ANGjdJ8', size: 900_000 },
					headers: [{ name: 'Subject', value: 'Big one' }],
				},
			});
		},
	});

	try {
		const client = createGmailClient({
			config: { ...config, apiBase: `http://127.0.0.1:${server.port}` },
			tokens,
		});

		const result = await client.getMessage('m1');

		expect(result.error).toBeNull();
		expect(requests).toEqual([
			{ pathname: '/gmail/v1/users/me/messages/m1', format: 'full' },
		]);
		expect(requests.some((r) => r.format === 'raw')).toBe(false);
		expect(requests.some((r) => r.pathname.includes('/attachments/'))).toBe(
			false,
		);
		// The client has no attachment surface at all, so no caller can add the
		// second call by accident.
		expect(Object.keys(client).some((name) => /attachment/i.test(name))).toBe(
			false,
		);
	} finally {
		server.stop(true);
	}
});

for (const { status, reason, requests: expectedRequests, name } of [
	{ status: 403, reason: 'dailyLimitExceeded', requests: 1, name: 'Http' },
	{ status: 403, reason: 'domainPolicy', requests: 1, name: 'Http' },
	{ status: 403, reason: 'insufficientPermissions', requests: 1, name: 'Http' },
	{
		status: 403,
		reason: 'userRateLimitExceeded',
		requests: 6,
		name: 'Throttled',
	},
	{ status: 403, reason: 'rateLimitExceeded', requests: 6, name: 'Throttled' },
	{ status: 429, reason: 'rateLimitExceeded', requests: 6, name: 'Throttled' },
]) {
	test(`${status} ${reason} makes ${expectedRequests} requests and preserves the provider failure`, async () => {
		let requests = 0;
		const body = JSON.stringify({
			error: {
				message: `Provider explanation for ${reason}`,
				errors: [{ reason }],
			},
		});
		const server = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			fetch(request) {
				const path = new URL(request.url).pathname;
				if (path.endsWith('/profile'))
					return Response.json({ historyId: '100' });
				if (path.endsWith('/labels')) return Response.json({ labels: [] });
				if (path.endsWith('/messages'))
					return Response.json({ messages: [{ id: 'm1', threadId: 't1' }] });
				requests++;
				return new Response(body, { status, headers: { 'Retry-After': '0' } });
			},
		});
		try {
			const client = createGmailClient({
				config: { ...config, apiBase: `http://127.0.0.1:${server.port}` },
				tokens,
			});
			const error = expectErr(await client.getMessage('m1'));
			expect(requests).toBe(expectedRequests);
			expect(error).toMatchObject({ name, status, body, reason });
			expect(error.message).toContain(`Provider explanation for ${reason}`);
			const session = await openTestSession();
			try {
				const app = {
					now: () => 0,
					activity: new Map([
						[
							session.sub,
							{
								pending: new Set(),
								session: Promise.resolve({
									...session,
									client,
									config,
									now: () => 0,
								}),
							},
						],
					]),
				} as unknown as MailApp;
				await reconcileNow(app, session.sub);
				const reopened = openPassRecord(session.localDatabase, session.sub);
				const outbox = await readOutbox({ ...session, passes: reopened });
				expect(outbox.waiting).toBe(0);
				expect(outbox.status).toBe(
					reason === 'insufficientPermissions' ? 'signin' : 'failed',
				);
				expect((await reopened.read())?.failure).toEqual({
					name,
					kind:
						name === 'Throttled'
							? 'retry'
							: reason === 'insufficientPermissions'
								? 'signin'
								: 'refused',
					message: error.message,
				});
			} finally {
				session.close();
			}
		} finally {
			server.stop(true);
		}
	});
}
