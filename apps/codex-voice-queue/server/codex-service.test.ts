/**
 * Codex service tests verify pinned sends, reply receipts, live state and approval decisions.
 */
import { afterEach, expect, spyOn, test } from 'bun:test';
import type { Thread, Turn } from '../src/lib/protocol.js';
import {
	type AppServerClient,
	AppServerError,
	createAppServerClient,
} from './app-server-client.js';
import {
	BusyError,
	createCodexService,
	OutcomeUnknownError,
	ReplyConflictError,
	ThreadInUseError,
} from './codex-service.js';
import {
	createFakeAppServer,
	type FakeMessage,
	FakeRpcError,
	waitFor,
} from './testing/fake-app-server.js';

const clients: AppServerClient[] = [];
afterEach(() => {
	for (const client of clients.splice(0)) client.stop();
});
const turn: Turn = {
	id: 'turn1',
	status: 'inProgress',
	items: [],
	error: null,
	startedAt: 1,
	completedAt: null,
	durationMs: null,
};
function thread(id: string, name: string | null, preview = ''): Thread {
	return {
		id,
		name,
		preview,
		cwd: '/work',
		source: 'cli',
		createdAt: 1,
		updatedAt: 2,
		status: { type: 'idle' },
		gitInfo: null,
		turns: [],
	};
}
function setup(
	onRequest: (message: FakeMessage) => unknown,
	requestTimeoutMs?: number,
) {
	const fake = createFakeAppServer({ onRequest });
	const client = createAppServerClient({
		spawnProcess: () => fake.transport,
		requestTimeoutMs,
	});
	clients.push(client);
	const service = createCodexService({
		client,
		sandbox: 'workspace-write',
		approval: 'on-request',
	});
	return { fake, client, service };
}
test('aggregates three thread pages and maps names and preview titles', async () => {
	let page = 0;
	const { fake, service } = setup(() => ({
		data: [
			thread(
				`t${++page}`,
				page === 1 ? 'Named' : null,
				page === 2 ? '\n preview title\nbody' : '',
			),
		],
		nextCursor: page < 3 ? String(page) : null,
	}));
	const result = await service.listThreads();
	expect(result.threads.map((thread) => thread.title)).toEqual([
		'Named',
		'preview title',
		'(untitled)',
	]);
	expect(result.truncated).toBe(false);
	expect(
		fake.messages
			.filter((message) => message.method === 'thread/list')
			.map((message) => (message.params as { cursor?: string }).cursor),
	).toEqual([undefined, '1', '2']);
});
test('resumes once with pinned policy, sends text, refuses busy sends, then sends again', async () => {
	const { fake, service } = setup((message) =>
		message.method === 'turn/start'
			? { turn }
			: { thread: thread('thread1', null) },
	);
	await service.sendText('thread1', ' hello ', { replyId: 'hello' });
	expect(
		fake.messages.find((message) => message.method === 'thread/resume')?.params,
	).toEqual({
		threadId: 'thread1',
		excludeTurns: true,
		approvalPolicy: 'on-request',
		sandbox: 'workspace-write',
		approvalsReviewer: 'user',
	});
	expect(
		fake.messages.find((message) => message.method === 'turn/start')?.params,
	).toEqual({
		threadId: 'thread1',
		clientUserMessageId: 'hello',
		input: [{ type: 'text', text: 'hello', text_elements: [] }],
		approvalPolicy: 'on-request',
		approvalsReviewer: 'user',
	});
	await expect(
		service.sendText('thread1', 'again', { replyId: 'again' }),
	).rejects.toBeInstanceOf(BusyError);
	fake.notify('turn/completed', {
		threadId: 'thread1',
		turn: { ...turn, status: 'completed' },
	});
	await waitFor(() => service.getState().live.thread1?.status === 'completed');
	await service.sendText('thread1', 'again', { replyId: 'again' });
	expect(
		fake.messages.filter((message) => message.method === 'thread/resume'),
	).toHaveLength(1);
});
test('holds v2 approval until decided and returns accept exactly', async () => {
	const { fake, client, service } = setup(() => ({}));
	await client.ensureReady();
	fake.ask('approval1', 'item/commandExecution/requestApproval', {
		threadId: 'thread1',
		turnId: 'turn1',
		itemId: 'item1',
		command: 'bun test',
	});
	await waitFor(() => service.getState().approvals.length === 1);
	const approval = service.getState().approvals[0];
	if (!approval) throw new Error('Missing approval');
	expect(fake.messages.some((message) => message.id === 'approval1')).toBe(
		false,
	);
	expect(service.decideApproval(approval.id, 'accept')).toBe(true);
	await waitFor(() =>
		fake.messages.some((message) => message.id === 'approval1'),
	);
	expect(
		fake.messages.find((message) => message.id === 'approval1')?.result,
	).toEqual({ decision: 'accept' });
	expect(service.getState().approvals).toHaveLength(0);
});
test('refuses unknown server requests and records a notice', async () => {
	const { fake, client, service } = setup(() => ({}));
	await client.ensureReady();
	fake.ask('unknown', 'future/request', { threadId: 'thread1' });
	await waitFor(() =>
		fake.messages.some((message) => message.id === 'unknown'),
	);
	expect(
		fake.messages.find((message) => message.id === 'unknown')?.error,
	).toEqual({ code: -32601, message: 'Not supported by Codex Voice Queue' });
	expect(service.getState().notices[0]?.threadId).toBe('thread1');
});
test('marks working turns failed and clears approvals on exit', async () => {
	const { fake, service } = setup((message) =>
		message.method === 'turn/start'
			? { turn }
			: { thread: thread('thread1', null) },
	);
	await service.sendText('thread1', 'hello', { replyId: 'hello' });
	fake.ask('approval', 'item/fileChange/requestApproval', {
		threadId: 'thread1',
		turnId: 'turn1',
		itemId: 'item1',
	});
	await waitFor(() => service.getState().approvals.length === 1);
	fake.exit(1);
	await waitFor(() => service.getState().live.thread1?.status === 'failed');
	expect(service.getState().live.thread1?.error).toBe(
		'Codex app-server stopped',
	);
	expect(service.getState().approvals).toHaveLength(0);
});
test('reverses turn pages and falls back to the last ten legacy turns', async () => {
	const { service } = setup((message) => {
		if (message.method === 'thread/turns/list')
			return {
				data: [
					{ ...turn, id: 'new' },
					{ ...turn, id: 'old' },
				],
				nextCursor: 'earlier',
			};
		return {};
	});
	expect((await service.readTurns('t')).turns.map((turn) => turn.id)).toEqual([
		'old',
		'new',
	]);
	const legacy = setup((message) => {
		if (message.method === 'thread/turns/list') throw new Error('legacy');
		return {
			thread: {
				turns: Array.from({ length: 12 }, (_, i) => ({
					...turn,
					id: String(i),
				})),
			},
		};
	});
	const result = await legacy.service.readTurns('t');
	expect(result.fallback).toBe('thread/read');
	expect(result.turns).toHaveLength(10);
	expect(result.allLoaded).toBe(true);
});

test('refuses an active resumed thread and checks it again on the next send', async () => {
	let active = true;
	const { fake, service } = setup((message) => {
		if (message.method === 'turn/start') return { turn };
		const resumedThread = thread('thread1', null);
		if (active) resumedThread.status = { type: 'active', activeFlags: [] };
		return { thread: resumedThread };
	});
	await expect(
		service.sendText('thread1', 'hello', { replyId: 'hello' }),
	).rejects.toThrow(
		'Codex is already working on this conversation in another session',
	);
	expect(
		fake.messages.filter((message) => message.method === 'turn/start'),
	).toHaveLength(0);
	active = false;
	await service.sendText('thread1', 'hello', { replyId: 'hello' });
	expect(
		fake.messages.filter((message) => message.method === 'thread/resume'),
	).toHaveLength(2);
	expect(
		fake.messages.filter((message) => message.method === 'turn/start'),
	).toHaveLength(1);
});

test('returns the accepted receipt while its turn is busy and rejects changed content', async () => {
	const { fake, service } = setup((message) =>
		message.method === 'turn/start' ? { turn } : { thread: thread('A', null) },
	);
	const result = await service.sendText('A', 'hi', { replyId: 'r1' });
	expect(service.getState().live.A?.status).toBe('inProgress');
	expect(await service.sendText('A', ' hi ', { replyId: 'r1' })).toEqual({
		...result,
		duplicate: true,
	});
	await expect(
		service.sendText('A', 'edited', { replyId: 'r1' }),
	).rejects.toBeInstanceOf(ReplyConflictError);
	await expect(
		service.sendText('B', 'hi', { replyId: 'r1' }),
	).rejects.toBeInstanceOf(ReplyConflictError);
	expect(
		fake.messages.filter((message) => message.method === 'turn/start'),
	).toHaveLength(1);
	expect(
		fake.messages.find((message) => message.method === 'turn/start')?.params,
	).toMatchObject({ clientUserMessageId: 'r1' });
});

test('shares concurrent same-reply sends while refusing different replies on the thread', async () => {
	let finish: (result: unknown) => void = () => {};
	const { fake, service } = setup((message) =>
		message.method === 'turn/start'
			? new Promise((resolve) => {
					finish = resolve;
				})
			: { thread: thread('A', null) },
	);
	const first = service.sendText('A', 'hi', { replyId: 'r1' });
	const second = service.sendText('A', 'hi', { replyId: 'r1' });
	await waitFor(() =>
		fake.messages.some((message) => message.method === 'turn/start'),
	);
	await expect(
		service.sendText('A', 'other', { replyId: 'r2' }),
	).rejects.toBeInstanceOf(BusyError);
	finish({ turn });
	const [a, b] = await Promise.all([first, second]);
	expect(a.turnId).toBe(b.turnId);
	expect(b.duplicate).toBe(true);
	expect(
		fake.messages.filter((message) => message.method === 'turn/start'),
	).toHaveLength(1);
});

test('keeps timed-out sends unknown and never starts their retry', async () => {
	const { fake, service } = setup(
		(message) =>
			message.method === 'turn/start'
				? new Promise(() => {})
				: { thread: thread('A', null) },
		10,
	);
	await expect(
		service.sendText('A', 'hi', { replyId: 'r1' }),
	).rejects.toBeInstanceOf(OutcomeUnknownError);
	await expect(
		service.sendText('A', 'hi', {
			replyId: 'r1',
			retry: true,
			bootId: service.bootId,
		}),
	).rejects.toBeInstanceOf(OutcomeUnknownError);
	expect(
		fake.messages.filter((message) => message.method === 'turn/start'),
	).toHaveLength(1);
});

test('keeps disconnected turn starts unknown across retries', async () => {
	const { fake, service } = setup((message) =>
		message.method === 'turn/start'
			? new Promise(() => {})
			: { thread: thread('A', null) },
	);
	const result = service.sendText('A', 'hi', { replyId: 'r1' });
	const caught = result.catch((error: unknown) => error);
	await waitFor(() =>
		fake.messages.some((message) => message.method === 'turn/start'),
	);
	fake.exit(1);
	expect(await caught).toBeInstanceOf(OutcomeUnknownError);
	await expect(
		service.sendText('A', 'hi', { replyId: 'r1' }),
	).rejects.toBeInstanceOf(OutcomeUnknownError);
	expect(
		fake.messages.filter((message) => message.method === 'turn/start'),
	).toHaveLength(1);
});

test('deletes receipts for RPC refusals so the reply can be sent again', async () => {
	let refused = true;
	const { fake, service } = setup((message) => {
		if (message.method !== 'turn/start') return { thread: thread('A', null) };
		if (refused) throw new Error('refused');
		return { turn };
	});
	await expect(
		service.sendText('A', 'hi', { replyId: 'r1' }),
	).rejects.toMatchObject({ kind: 'rpc' });
	refused = false;
	expect(
		(
			await service.sendText('A', 'hi', {
				replyId: 'r1',
				retry: true,
				bootId: service.bootId,
			})
		).duplicate,
	).toBe(false);
	expect(
		fake.messages.filter((message) => message.method === 'turn/start'),
	).toHaveLength(2);
});

test('rejects a stale-boot retry and permits a current-boot retry', async () => {
	const { fake, service } = setup((message) =>
		message.method === 'turn/start' ? { turn } : { thread: thread('A', null) },
	);
	expect(service.getState().bootId).toBe(service.bootId);
	await expect(
		service.sendText('A', 'hi', { replyId: 'r1', retry: true, bootId: 'old' }),
	).rejects.toThrow(
		'The gateway restarted, so it cannot tell whether this reply was delivered',
	);
	expect(
		fake.messages.filter((message) => message.method === 'turn/start'),
	).toHaveLength(0);
	await service.sendText('A', 'hi', {
		replyId: 'r1',
		retry: true,
		bootId: service.bootId,
	});
	expect(
		fake.messages.filter((message) => message.method === 'turn/start'),
	).toHaveLength(1);
});

const fileItem = { threadId: 'thread1', turnId: 'turn1', itemId: 'item1' };
const changes = [
	{
		path: '/work/file.ts',
		kind: { type: 'update' as const, move_path: null },
		diff: '-old\n+new',
	},
];

test('shows changes that arrived before a file approval and clears them on completion', async () => {
	const { fake, client, service } = setup(() => ({}));
	await client.ensureReady();
	fake.notify('item/started', {
		...fileItem,
		item: { type: 'fileChange', id: 'item1', status: 'inProgress', changes },
	});
	fake.ask('approval', 'item/fileChange/requestApproval', fileItem);
	await waitFor(() => service.getState().approvals.length === 1);
	const pending = service.getState().approvals[0];
	expect(pending).toMatchObject({ changes, changesTruncated: false });
	expect(service.decideApproval(pending?.id ?? '', 'accept')).toBe(true);
	fake.notify('turn/completed', {
		threadId: 'thread1',
		turn: { ...turn, status: 'completed' },
	});
	await waitFor(() => service.getState().live.thread1?.status === 'completed');
	fake.ask('next-approval', 'item/fileChange/requestApproval', fileItem);
	await waitFor(() => service.getState().approvals.length === 1);
	expect(service.getState().approvals[0]?.changes).toBeNull();
});

test('resolves late patches at read time and caps stored diff text per item', async () => {
	const { fake, client, service } = setup(() => ({}));
	await client.ensureReady();
	fake.ask('approval', 'item/fileChange/requestApproval', fileItem);
	await waitFor(() => service.getState().approvals.length === 1);
	expect(service.getState().approvals[0]?.changes).toBeNull();
	fake.notify('item/fileChange/patchUpdated', { ...fileItem, changes });
	await waitFor(() => service.getState().approvals[0]?.changes !== null);
	expect(service.getState().approvals[0]).toMatchObject({
		changes,
		changesTruncated: false,
	});
	fake.notify('item/completed', {
		...fileItem,
		item: {
			type: 'fileChange',
			id: 'item1',
			status: 'completed',
			changes: [
				{ ...changes[0], diff: 'a'.repeat(99_999) },
				{ ...changes[0], diff: 'b'.repeat(10) },
			],
		},
	});
	await waitFor(
		() => service.getState().approvals[0]?.changesTruncated === true,
	);
	expect(
		service
			.getState()
			.approvals[0]?.changes?.map((change) => change.diff.length),
	).toEqual([99_999, 1]);
});

test('refuses acceptance without shared changes but still delivers decline', async () => {
	const { fake, client, service } = setup(() => ({}));
	await client.ensureReady();
	fake.ask('approval', 'item/fileChange/requestApproval', fileItem);
	await waitFor(() => service.getState().approvals.length === 1);
	const id = service.getState().approvals[0]?.id ?? '';
	expect(service.decideApproval(id, 'accept')).toBe('changes_unavailable');
	expect(fake.messages.some((message) => message.id === 'approval')).toBe(
		false,
	);
	fake.notify('item/fileChange/patchUpdated', { ...fileItem, changes: [] });
	await waitFor(() => service.getState().approvals[0]?.changes?.length === 0);
	expect(service.decideApproval(id, 'accept')).toBe('changes_unavailable');
	expect(service.decideApproval(id, 'decline')).toBe(true);
	await waitFor(() =>
		fake.messages.some((message) => message.id === 'approval'),
	);
	expect(
		fake.messages.find((message) => message.id === 'approval')?.result,
	).toEqual({ decision: 'decline' });
	expect(service.decideApproval(id, 'accept')).toBe(false);
});

test('evicts the oldest tracked file item after 200 entries and clears on exit', async () => {
	const { fake, client, service } = setup(() => ({}));
	await client.ensureReady();
	for (let index = 0; index <= 200; index++)
		fake.notify('item/fileChange/patchUpdated', {
			...fileItem,
			itemId: String(index),
			changes,
		});
	fake.ask('old', 'item/fileChange/requestApproval', {
		...fileItem,
		itemId: '0',
	});
	fake.ask('new', 'item/fileChange/requestApproval', {
		...fileItem,
		itemId: '200',
	});
	await waitFor(() => service.getState().approvals.length === 2);
	expect(
		service.getState().approvals.find((entry) => entry.itemId === '0')?.changes,
	).toBeNull();
	expect(
		service.getState().approvals.find((entry) => entry.itemId === '200')
			?.changes,
	).toEqual(changes);
	fake.exit(1);
	await waitFor(() => service.getState().approvals.length === 0);
	expect(client.getState().state).toBe('down');
});

test('deletes receipts when resume fails before turn start', async () => {
	let refused = true;
	const { fake, service } = setup((message) => {
		if (message.method === 'turn/start') return { turn };
		if (refused) throw new Error('resume failed');
		return { thread: thread('A', null) };
	});
	await expect(service.sendText('A', 'hi', { replyId: 'r1' })).rejects.toThrow(
		'resume failed',
	);
	refused = false;
	await service.sendText('A', 'hi', { replyId: 'r1' });
	expect(
		fake.messages.filter((message) => message.method === 'turn/start'),
	).toHaveLength(1);
});

test('evicts oldest non-pending receipts at capacity while retaining in-flight replies', async () => {
	let finish: (result: unknown) => void = () => {};
	const { fake, service } = setup((message) => {
		if (message.method !== 'turn/start') return { thread: thread('A', null) };
		if ((message.params as { threadId: string }).threadId === 'pending')
			return new Promise((resolve) => {
				finish = resolve;
			});
		return { turn };
	});
	const pending = service.sendText('pending', 'hi', { replyId: 'pending' });
	await waitFor(() =>
		fake.messages.some((message) => message.method === 'turn/start'),
	);
	for (let index = 0; index < 500; index++)
		await service.sendText(`thread${index}`, 'hi', {
			replyId: `reply${index}`,
		});
	const duplicate = service.sendText('pending', 'hi', { replyId: 'pending' });
	finish({ turn });
	expect((await pending).turnId).toBe((await duplicate).turnId);
	// A changed thread can reuse only the evicted ID; retained IDs still conflict.
	await service.sendText('replacement', 'hi', { replyId: 'reply0' });
	await expect(
		service.sendText('other', 'hi', { replyId: 'reply499' }),
	).rejects.toBeInstanceOf(ReplyConflictError);
	expect(
		fake.messages.filter((message) => message.method === 'turn/start'),
	).toHaveLength(502);
});

test('drops settled receipts older than two hours', async () => {
	const { service } = setup((message) =>
		message.method === 'turn/start' ? { turn } : { thread: thread('A', null) },
	);
	await service.sendText('A', 'hi', { replyId: 'r1' });
	const clock = spyOn(Date, 'now').mockReturnValue(
		Date.now() + 2 * 60 * 60 * 1000 + 1,
	);
	try {
		expect(
			(await service.sendText('B', 'new text', { replyId: 'r1' })).duplicate,
		).toBe(false);
	} finally {
		clock.mockRestore();
	}
});

test('archive clears live state and resume tracking only after confirmation', async () => {
	const { fake, service } = setup((message) =>
		message.method === 'turn/start' ? { turn } : { thread: thread('A', null) },
	);
	await service.sendText('A', 'hello', { replyId: 'first' });
	fake.notify('turn/completed', {
		threadId: 'A',
		turn: { ...turn, status: 'completed' },
	});
	await waitFor(() => service.getState().live.A?.status === 'completed');
	expect(await service.archiveThread('A')).toEqual({ threadId: 'A' });
	expect(
		fake.messages
			.filter((message) => message.method === 'thread/archive')
			.map((message) => message.params),
	).toEqual([{ threadId: 'A' }]);
	expect(service.getState().live.A).toBeUndefined();
	await service.sendText('A', 'again', { replyId: 'second' });
	expect(
		fake.messages.filter((message) => message.method === 'thread/resume'),
	).toHaveLength(2);
});

test('archive refuses a running turn, active thread, pending approval and in-flight send', async () => {
	const { fake, service, client } = setup((message) =>
		message.method === 'turn/start' ? { turn } : { thread: thread('A', null) },
	);
	await service.sendText('A', 'hello', { replyId: 'first' });
	await expect(service.archiveThread('A')).rejects.toBeInstanceOf(BusyError);
	fake.notify('thread/status/changed', {
		threadId: 'B',
		status: { type: 'active', activeFlags: [] },
	});
	await waitFor(
		() => service.getState().live.B?.threadStatus?.type === 'active',
	);
	await expect(service.archiveThread('B')).rejects.toBeInstanceOf(BusyError);
	fake.ask('approval', 'item/commandExecution/requestApproval', {
		threadId: 'C',
		turnId: 't',
		itemId: 'i',
	});
	await waitFor(() => service.getState().approvals.length === 1);
	await expect(service.archiveThread('C')).rejects.toThrow(
		'Answer the pending approval before archiving this conversation',
	);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const ready = client.ensureReady.bind(client);
	spyOn(client, 'ensureReady').mockImplementation(async () => {
		await gate;
		await ready();
	});
	const sending = service.sendText('D', 'hello', { replyId: 'other' });
	await Promise.resolve();
	await expect(service.archiveThread('D')).rejects.toBeInstanceOf(BusyError);
	expect(
		fake.messages.filter((message) => message.method === 'thread/archive'),
	).toHaveLength(0);
	release();
	await sending;
});

test('failed archive releases its guard and can be retried', async () => {
	let fail = true;
	const { service } = setup(() => {
		if (fail) throw new Error('archive refused');
		return {};
	});
	await expect(service.archiveThread('A')).rejects.toThrow('archive refused');
	fail = false;
	expect(await service.archiveThread('A')).toEqual({ threadId: 'A' });
});

test('in-flight archive refuses another archive and a send', async () => {
	let finish!: (value: unknown) => void;
	const { fake, service } = setup(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const archiving = service.archiveThread('A');
	await waitFor(() =>
		fake.messages.some((message) => message.method === 'thread/archive'),
	);
	await expect(service.archiveThread('A')).rejects.toBeInstanceOf(BusyError);
	await expect(
		service.sendText('A', 'hello', { replyId: 'first' }),
	).rejects.toBeInstanceOf(BusyError);
	finish({});
	await archiving;
});

test('thread archived notification clears local live and resumed state', async () => {
	const { fake, service } = setup((message) =>
		message.method === 'turn/start' ? { turn } : { thread: thread('A', null) },
	);
	await service.sendText('A', 'hello', { replyId: 'first' });
	fake.notify('thread/archived', { threadId: 'A' });
	await waitFor(() => !service.getState().live.A);
	await service.sendText('A', 'again', { replyId: 'second' });
	expect(
		fake.messages.filter((message) => message.method === 'thread/resume'),
	).toHaveLength(2);
});

test('archive writer conflict explains ownership and releases the guard for retry', async () => {
	let conflict = true;
	const { service } = setup(() => {
		if (conflict)
			throw new FakeRpcError(-32600, 'thread A already has an active writer');
		return {};
	});
	const error = await service
		.archiveThread('A')
		.catch((error: unknown) => error);
	expect(error).toBeInstanceOf(ThreadInUseError);
	expect(error).toMatchObject({
		message:
			'Another Codex app has this conversation open, so only that app can archive it. Archive it there, or quit that app and retry.',
	});
	conflict = false;
	expect(await service.archiveThread('A')).toEqual({ threadId: 'A' });
});

test('resume writer conflict starts no turn and allows retry with the same reply ID', async () => {
	let conflict = true;
	const { fake, service } = setup((message) => {
		if (message.method === 'turn/start') return { turn };
		if (message.method === 'thread/resume' && conflict)
			throw new FakeRpcError(-32600, 'thread A already has an active writer');
		return { thread: thread('A', null) };
	});
	const error = await service
		.sendText('A', 'hi', { replyId: 'reply_123' })
		.catch((error: unknown) => error);
	expect(error).toBeInstanceOf(ThreadInUseError);
	expect(error).toMatchObject({
		message:
			'Another Codex app has this conversation open, so only that app can reply to it. Reply there, or quit that app and retry.',
	});
	expect(
		fake.messages.filter((message) => message.method === 'turn/start'),
	).toHaveLength(0);
	conflict = false;
	expect(
		await service.sendText('A', 'hi', { replyId: 'reply_123' }),
	).toMatchObject({
		turnId: turn.id,
		duplicate: false,
	});
	expect(
		fake.messages.filter((message) => message.method === 'thread/resume'),
	).toHaveLength(2);
	expect(
		fake.messages.filter((message) => message.method === 'turn/start'),
	).toHaveLength(1);
});

test('archive preserves unrelated RPC errors', async () => {
	const { service } = setup(() => {
		throw new FakeRpcError(-32600, 'something else');
	});
	const error = await service
		.archiveThread('A')
		.catch((error: unknown) => error);
	expect(error).toBeInstanceOf(AppServerError);
	expect(error).not.toBeInstanceOf(ThreadInUseError);
	expect(error).toMatchObject({ code: -32600, message: 'something else' });
});
