/**
 * Beeper's device connection, over an injected network and memory secrets.
 *
 * Key behaviors:
 * - The token stays in secrets and every request goes to Beeper on this computer
 * - A send is asked once; a lost answer is `unknown`, a refusal is `refused`
 * - A pending id is followed with `retrieve` to Beeper's delivery status
 * - Reads keep Beeper's opaque cursors
 * - The protocol admits no send of raw text, only ready replies by version
 */
import { expect, test } from 'bun:test';
import { Check } from 'typebox/value';
import { createBeeperConnection } from './messages.js';
import { messagesRequest } from './messages-protocol.js';
import { createMemorySecrets } from './secrets.ts';

type Call = { url: string; method: string; token: string | null };

function network(answer: (request: Request) => Response | Promise<Response>) {
	const calls: Call[] = [];
	const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(input, init);
		calls.push({
			url: request.url,
			method: request.method,
			token: request.headers.get('Authorization'),
		});
		return answer(request);
	}) as typeof fetch;
	return { calls, fetcher };
}

const accounts = (request: Request) =>
	new URL(request.url).pathname === '/v1/accounts'
		? Response.json([{ accountID: 'fictional-account' }])
		: undefined;

test('the token stays in secrets and a send with a lost answer is asked once and unknown', async () => {
	const { calls, fetcher } = network((request) => {
		const found = accounts(request);
		if (found) return found;
		throw new TypeError('Simulated lost response');
	});
	const connection = createBeeperConnection(createMemorySecrets(), fetcher);
	const connected = await connection.request({
		action: 'connect',
		token: 'fictional-secret',
	});
	if (connected.kind !== 'connected') throw new Error('Connection failed');
	expect(JSON.stringify(connected)).not.toContain('fictional-secret');
	expect(await connection.profile()).toEqual({ profile: connected.profile });

	const answer = await connection.send('chat/with?opaque=id', 'Fictional');
	expect(answer.kind).toBe('unknown');
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

test('a refusal from Beeper is refused, and a timeout is unknown', async () => {
	let status = 422;
	const { fetcher } = network(
		(request) =>
			accounts(request) ??
			Response.json({ message: 'no' }, { status }),
	);
	const connection = createBeeperConnection(createMemorySecrets(), fetcher);
	await connection.request({ action: 'connect', token: 'fictional-token' });
	expect((await connection.send('chat', 'Hello')).kind).toBe('refused');
	status = 408;
	expect((await connection.send('chat', 'Hello')).kind).toBe('unknown');
	status = 503;
	expect((await connection.send('chat', 'Hello')).kind).toBe('unknown');
});

test('nothing is asked without a saved token, and disconnect forgets it', async () => {
	const { calls, fetcher } = network(
		(request) => accounts(request) ?? Response.json({}),
	);
	const connection = createBeeperConnection(createMemorySecrets(), fetcher);
	expect(await connection.profile()).toEqual({
		message: 'Beeper is not connected.',
	});
	expect((await connection.send('chat', 'Hello')).kind).toBe('refused');
	await connection.request({ action: 'connect', token: 'fictional-token' });
	expect(await connection.request({ action: 'disconnect' })).toEqual({
		kind: 'disconnected',
	});
	expect((await connection.request({ action: 'chats' })).kind).toBe('error');
	expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
});

test('a send answers its pending id and routed chat, and status follows the pending id', async () => {
	const { calls, fetcher } = network((request) => {
		const found = accounts(request);
		if (found) return found;
		const path = new URL(request.url).pathname;
		if (request.method === 'POST')
			return Response.json({
				chatID: 'member-chat',
				pendingMessageID: 'pending-1',
			});
		if (path.endsWith('/messages/pending-1'))
			return Response.json({
				id: 'pending-1',
				chatID: 'member-chat',
				accountID: 'fictional-account',
				senderID: 'me',
				sortKey: '1',
				timestamp: '2026-10-20T09:00:00Z',
				sendStatus: { status: 'SUCCESS', timestamp: '2026-10-20T09:00:01Z' },
			});
		return Response.json({ message: 'Not found' }, { status: 404 });
	});
	const connection = createBeeperConnection(createMemorySecrets(), fetcher);
	await connection.request({ action: 'connect', token: 'fictional-token' });
	expect(await connection.send('merged-chat', 'A fictional reply')).toEqual({
		kind: 'accepted',
		pendingId: 'pending-1',
		chatId: 'member-chat',
	});
	expect(await connection.status('member-chat', 'pending-1')).toEqual({
		kind: 'status',
		status: 'SUCCESS',
	});
	expect(
		calls.some((call) =>
			call.url.includes('/v1/chats/member-chat/messages/pending-1'),
		),
	).toBe(true);
	expect(await connection.status('member-chat', 'pending-2')).toEqual({
		kind: 'status',
		status: null,
	});
});

test('reads keep opaque pagination', async () => {
	const { fetcher } = network((request) => {
		const found = accounts(request);
		if (found) return found;
		const url = new URL(request.url);
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
	});
	const connection = createBeeperConnection(createMemorySecrets(), fetcher);
	await connection.request({ action: 'connect', token: 'fictional-token' });
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
});

test('the protocol admits no send of raw text', () => {
	expect(
		Check(messagesRequest, {
			action: 'send',
			chatId: 'chat',
			profile: 'profile',
			text: 'Hello',
		}),
	).toBe(false);
	expect(
		Check(messagesRequest, {
			action: 'send',
			items: [{ id: 'reply', over: 'version' }],
		}),
	).toBe(true);
});
