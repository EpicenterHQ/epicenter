/** Beeper operations use only the injected network and memory secrets; sends never retry. */
import { expect, test } from 'bun:test';
import { createMemorySecrets } from '@epicenter/ai/send';
import { createBeeperConnection } from './messages.js';

test('connection tokens stay in secrets and sends are attempted once after an ambiguous failure', async () => {
	const secrets = createMemorySecrets();
	const calls: { url: string; method: string; token: string | null }[] = [];
	const network = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const request = new Request(input, init);
		calls.push({
			url: request.url,
			method: request.method,
			token: request.headers.get('Authorization'),
		});
		if (new URL(request.url).pathname === '/v1/accounts')
			return Response.json([{ accountID: 'fictional-account' }]);
		throw new TypeError('Simulated lost response');
	}) as typeof fetch;
	const connection = createBeeperConnection(secrets, network);
	const connected = await connection.request({
		action: 'connect',
		token: 'fictional-secret',
	});
	expect(connected.kind).toBe('connected');
	if (connected.kind !== 'connected') throw new Error('Connection failed');
	expect(JSON.stringify(connected)).not.toContain('fictional-secret');
	const answer = await connection.request({
		action: 'send',
		profile: connected.profile,
		chatId: 'chat/with?opaque=id',
		text: 'Fictional message',
	});
	expect(answer.kind).toBe('error');
	expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
	expect(
		decodeURIComponent(
			new URL(calls.at(-1)?.url ?? 'http://missing/').pathname.split('/')[3] ??
				'',
		),
	).toBe('chat/with?opaque=id');
	expect(
		calls.every((call) => call.url.startsWith('http://127.0.0.1:23373/')),
	).toBe(true);
	expect(calls.every((call) => call.token === 'Bearer fictional-secret')).toBe(
		true,
	);
});

test('a changed account identity prevents sending and disconnect forgets only the app token', async () => {
	const secrets = createMemorySecrets();
	let account = 'first';
	let sends = 0;
	const network = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const request = new Request(input, init);
		if (request.method === 'POST') sends++;
		return Response.json([{ accountID: account }]);
	}) as typeof fetch;
	const connection = createBeeperConnection(secrets, network);
	const connected = await connection.request({
		action: 'connect',
		token: 'fictional-token',
	});
	if (connected.kind !== 'connected') throw new Error('Connection failed');
	account = 'different';
	expect(
		(
			await connection.request({
				action: 'send',
				profile: connected.profile,
				chatId: 'chat',
				text: 'Hello',
			})
		).kind,
	).toBe('error');
	expect(sends).toBe(0);
	expect(await connection.request({ action: 'disconnect' })).toEqual({
		kind: 'disconnected',
	});
	expect((await connection.request({ action: 'chats' })).kind).toBe('error');
});

test('reads preserve opaque pagination and a successful send returns only Beeper acceptance', async () => {
	const network = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (url.pathname === '/v1/accounts')
			return Response.json([{ accountID: 'fictional-account' }]);
		if (url.pathname === '/v1/chats') {
			expect(url.searchParams.get('cursor')).toBe('opaque cursor/?=');
			return Response.json({
				items: [
					{
						id: 'chat',
						title: 'Fictional chat',
						network: 'Signal',
						preview: { text: 'Hello' },
						lastActivity: '2026-10-20T09:00:00Z',
					},
				],
				hasMore: true,
				oldestCursor: 'next opaque cursor',
				newestCursor: null,
			});
		}
		if (request.method === 'POST')
			return Response.json({ chatID: 'chat', pendingMessageID: 'pending-1' });
		return Response.json({
			items: [
				{ id: 'hidden', isHidden: true },
				{
					id: 'visible',
					text: 'Fictional message',
					senderName: 'Example',
					senderID: 'example',
					timestamp: '2026-10-20T09:00:00Z',
					isSender: true,
					sendStatus: { status: 'PENDING' },
					attachments: [{ type: 'img' }],
				},
			],
			hasMore: true,
			oldestCursor: 'older opaque cursor',
			newestCursor: null,
		});
	}) as typeof fetch;
	const connection = createBeeperConnection(createMemorySecrets(), network);
	const connected = await connection.request({
		action: 'connect',
		token: 'fictional-token',
	});
	if (connected.kind !== 'connected') throw new Error('Connection failed');
	const chats = await connection.request({
		action: 'chats',
		cursor: 'opaque cursor/?=',
	});
	if (chats.kind !== 'chats') throw new Error('Could not read chats');
	expect(chats.page.cursor).toBe('next opaque cursor');
	const messages = await connection.request({
		action: 'messages',
		chatId: 'chat',
	});
	if (messages.kind !== 'messages') throw new Error('Could not read messages');
	expect(messages.page.items).toHaveLength(1);
	expect(messages.page.items[0]?.attachment).toBe(true);
	expect(messages.page.items[0]?.status).toBe('PENDING');
	expect(messages.page.cursor).toBe('older opaque cursor');
	expect(
		await connection.request({
			action: 'send',
			chatId: 'chat',
			profile: connected.profile,
			text: 'A fictional reply',
		}),
	).toEqual({ kind: 'accepted', pendingId: 'pending-1' });
});
