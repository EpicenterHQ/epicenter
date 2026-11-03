/**
 * Compiled queue regressions cover transcript invalidation, receipt-safe retries,
 * uncertain delivery recovery, and selection changes during pinned sends.
 */
import { expect, test } from 'bun:test';
import { type Api, ApiError } from './api.js';
import type {
	ArchiveResponse,
	GatewayState,
	PendingApproval,
	LiveTurn,
	SendRequest,
	SendResponse,
	ThreadSummary,
	TurnsResponse,
} from './api-types.js';
import { VoiceQueue } from './queue.svelte.js';

const empty: TurnsResponse = { turns: [], nextCursor: null, allLoaded: true };
function turns(id: string, clientId?: string): TurnsResponse {
	return {
		...empty,
		turns: [
			{
				id,
				status: 'completed',
				error: null,
				startedAt: null,
				completedAt: null,
				durationMs: null,
				items: clientId
					? [{ type: 'userMessage', id: 'message', clientId, content: [] }]
					: [],
			},
		],
	};
}
function live(status: LiveTurn['status']): LiveTurn {
	return {
		turnId: 'turn',
		status,
		startedAt: null,
		completedAt: null,
		error: null,
		lastAgentMessage: '',
		threadStatus: null,
	};
}
function state(entries: GatewayState['live'] = {}): GatewayState {
	return {
		bootId: 'original-boot',
		appServer: { state: 'ready', lastError: null },
		live: entries,
		approvals: [],
		notices: [],
	};
}
function fixture() {
	const bodies: SendRequest[] = [];
	const reads: string[] = [];
	const archives: string[] = [];
	let listed: ThreadSummary[] | null = null;
	let archive: (path: string) => Promise<ArchiveResponse> = async (path) => ({
		threadId: path.split('/')[3] ?? '',
	});
	let gateway = state();
	let transcript = turns('v1');
	let respond: (body: SendRequest) => Promise<SendResponse> = async (body) => ({
		turnId: 'turn',
		status: 'inProgress',
		replyId: body.replyId,
		duplicate: false,
	});
	const api: Api = {
		async request<T>(path: string, init?: RequestInit): Promise<T> {
			if (path === '/api/state') return gateway as T;
			if (path === '/api/threads')
				return {
					threads: listed ?? [...queue.threads.values()],
					truncated: false,
				} as T;
			if (init?.method === 'POST' && path.endsWith('/archive')) {
				archives.push(path);
				return (await archive(path)) as T;
			}
			if (init?.method === 'POST') {
				const body: SendRequest = JSON.parse(String(init.body));
				bodies.push(body);
				return (await respond(body)) as T;
			}
			reads.push(path);
			return transcript as T;
		},
	};
	const queue = new VoiceQueue({ api });
	for (const id of ['A', 'B', 'C']) {
		const thread: ThreadSummary = {
			id,
			title: id,
			preview: '',
			cwd: '/',
			source: 'cli',
			createdAt: 0,
			updatedAt: 0,
			status: { type: 'idle' },
			gitBranch: null,
		};
		queue.threads.set(id, thread);
	}
	queue.order = ['A', 'B', 'C'];
	queue.state = gateway;
	queue.select('A');
	queue.recognizedText = 'hello';
	return {
		queue,
		bodies,
		reads,
		archives,
		setThreads(value: ThreadSummary[]) {
			listed = value;
		},
		archive(value: typeof archive) {
			archive = value;
		},
		setState(value: GatewayState) {
			gateway = value;
		},
		setTurns(value: TurnsResponse) {
			transcript = value;
		},
		respond(value: typeof respond) {
			respond = value;
		},
	};
}
const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));

test('returning to A after sending and completion loads its latest turns', async () => {
	const f = fixture();
	await settle();
	expect(f.queue.transcript?.data?.turns[0]?.id).toBe('v1');
	await f.queue.sendText();
	expect(f.queue.selectedId).toBe('B');
	f.setState(state({ A: live('inProgress') }));
	await f.queue.poll();
	f.setTurns(turns('v2'));
	f.setState(state({ A: live('completed') }));
	await f.queue.poll();
	f.queue.select('A');
	await settle();
	expect(
		f.reads.filter((path) => path === '/api/threads/A/turns').length,
	).toBeGreaterThanOrEqual(2);
	expect(f.queue.transcript?.data?.turns[0]?.id).toBe('v2');
});

test('selected live changes immediately refresh the transcript', async () => {
	const f = fixture();
	await settle();
	f.setTurns(turns('v2'));
	f.setState(state({ A: live('inProgress') }));
	await f.queue.poll();
	await settle();
	expect(
		f.reads.filter((path) => path === '/api/threads/A/turns'),
	).toHaveLength(2);
	expect(f.queue.transcript?.data?.turns[0]?.id).toBe('v2');
});

test('transport retry keeps the receipt and original boot even when A looks busy', async () => {
	const f = fixture();
	f.respond(async () => {
		throw new ApiError(0, 'offline');
	});
	await f.queue.sendText();
	expect(f.queue.draft?.uncertain).toBe(true);
	expect(f.queue.status).toBe(
		'No answer from the gateway. Retrying is safe: the gateway ignores a repeat of this reply.',
	);
	f.queue.state = { ...state({ A: live('inProgress') }), bootId: 'later-boot' };
	f.respond(async (body) => ({
		turnId: 'turn',
		status: 'inProgress',
		replyId: body.replyId,
		duplicate: true,
	}));
	await f.queue.send();
	expect(f.bodies[1]).toEqual({
		text: 'hello',
		replyId: f.bodies[0]?.replyId ?? '',
		retry: true,
		bootId: 'original-boot',
	});
	expect(f.queue.sent.has('A')).toBe(true);
	expect(f.queue.selectedId).toBe('B');
	expect(f.queue.draft).toBeNull();
});

test('outcome_unknown preserves the draft and checking clientId confirms delivery without advancing', async () => {
	const f = fixture();
	f.respond(async () => {
		throw new ApiError(409, 'uncertain', 'outcome_unknown');
	});
	await f.queue.sendText();
	expect(f.queue.flow).toBe('sendUnknown');
	expect(f.queue.selectedId).toBe('A');
	expect(f.queue.targetId).toBe('A');
	expect(f.queue.recognizedText).toBe('hello');
	f.setTurns(turns('delivered', f.queue.draft?.replyId));
	f.queue.select('C');
	await f.queue.checkConversation();
	expect(f.queue.selectedId).toBe('C');
	expect(f.queue.sent.has('A')).toBe(true);
	expect(f.queue.draft).toBeNull();
	expect(f.queue.status).toBe('Found in the conversation: delivered');
});

test('missing unknown receipt stays actionable and send as new mints a fresh receipt', async () => {
	const f = fixture();
	f.respond(async () => {
		throw new ApiError(409, 'uncertain', 'outcome_unknown');
	});
	await f.queue.sendText();
	await f.queue.checkConversation();
	expect(f.queue.flow).toBe('sendUnknown');
	expect(f.queue.status).toBe(
		'Not in the latest turns. It may still arrive; check again, or send it as a new message.',
	);
	f.queue.recognizedText = 'edited';
	await f.queue.sendAsNew();
	expect(f.bodies[1]?.replyId).not.toBe(f.bodies[0]?.replyId);
	expect(f.bodies[1]?.retry).toBeUndefined();
	expect(f.bodies[1]?.text).toBe('edited');
});

test('definite failure reuses a receipt until the text changes', async () => {
	const f = fixture();
	f.respond(async () => {
		throw new ApiError(502, 'app server down', 'app_server');
	});
	await f.queue.sendText();
	await f.queue.send();
	expect(f.bodies[1]?.replyId).toBe(f.bodies[0]?.replyId);
	f.queue.recognizedText = 'changed';
	await f.queue.send();
	expect(f.bodies[2]?.replyId).not.toBe(f.bodies[1]?.replyId);
	expect(f.queue.draft?.uncertain).toBe(false);
});

test('reply conflict uses a fresh replyId on the next attempt', async () => {
	const f = fixture();
	f.respond(async () => {
		throw new ApiError(409, 'conflict', 'reply_conflict');
	});
	await f.queue.sendText();
	expect(f.queue.status).toBe('conflict');
	await f.queue.send();
	expect(f.bodies[1]?.replyId).not.toBe(f.bodies[0]?.replyId);
});

test('send completion keeps C when the user selected it while A was sending', async () => {
	const f = fixture();
	let complete!: (response: SendResponse) => void;
	f.respond(
		() =>
			new Promise((resolve) => {
				complete = resolve;
			}),
	);
	const sending = f.queue.sendText();
	f.queue.select('C');
	complete({
		turnId: 'turn',
		status: 'inProgress',
		replyId: f.bodies[0]?.replyId ?? '',
		duplicate: false,
	});
	await sending;
	expect(f.queue.selectedId).toBe('C');
	expect(f.queue.status).toBe('Sent to A');
});

test('invalidation drops an older in-flight transcript after the replacement loads', async () => {
	let finishOld!: (value: TurnsResponse) => void;
	let reads = 0;
	const api: Api = {
		async request<T>(path: string): Promise<T> {
			if (path === '/api/state') return state({ A: live('completed') }) as T;
			reads++;
			return (
				reads === 1
					? await new Promise<TurnsResponse>((resolve) => {
							finishOld = resolve;
						})
					: turns('v2')
			) as T;
		},
	};
	const queue = new VoiceQueue({ api });
	queue.state = state({ A: live('inProgress') });
	queue.select('A');
	await queue.poll();
	await settle();
	finishOld(turns('v1'));
	await settle();
	expect(reads).toBe(2);
	expect(queue.transcript?.data?.turns[0]?.id).toBe('v2');
});

test('the first poll does not invalidate a cached transcript', async () => {
	const f = fixture();
	await settle();
	f.queue.state = null;
	f.setState(state({ A: live('completed') }));
	await f.queue.poll();
	expect(f.reads).toHaveLength(1);
});

test('fresh replies stay blocked when Codex is already working', async () => {
	const f = fixture();
	f.queue.state = state({ A: live('inProgress') });
	await f.queue.sendText();
	expect(f.bodies).toHaveLength(0);
	expect(f.queue.selectedId).toBe('A');
});

test('archive removes A only after success and selects B', async () => {
	const f = fixture();
	await settle();
	f.queue.sent.add('A');
	await f.queue.archive();
	expect(f.archives).toEqual(['/api/threads/A/archive']);
	expect(f.queue.threads.has('A')).toBe(false);
	expect(f.queue.transcripts.has('A')).toBe(false);
	expect(f.queue.sent.has('A')).toBe(false);
	expect(f.queue.order).toEqual(['B', 'C']);
	expect(f.queue.selectedId).toBe('B');
	expect(f.queue.status).toBe('Archived A');
	expect(f.queue.archivingId).toBeNull();
});

test('archive advances to the next visible conversation', async () => {
	const f = fixture();
	for (const id of ['A', 'C']) {
		const thread = f.queue.threads.get(id)!;
		f.queue.threads.set(id, { ...thread, preview: 'visible' });
	}
	f.queue.query = 'visible';
	await f.queue.archive();
	expect(f.queue.selectedId).toBe('C');
	expect(f.queue.order).toEqual(['B', 'C']);
});

test('archiving the last visible conversation clears selection', async () => {
	const f = fixture();
	f.queue.query = 'A';
	await f.queue.archive();
	expect(f.queue.selectedId).toBeNull();
	expect(f.queue.status).toBe('Archived A. End of queue');
});

test('failed archive preserves the conversation and retries successfully', async () => {
	const f = fixture();
	f.archive(async () => {
		throw new Error('offline');
	});
	await f.queue.archive();
	expect(f.queue.selectedId).toBe('A');
	expect(f.queue.threads.has('A')).toBe(true);
	expect(f.queue.order).toEqual(['A', 'B', 'C']);
	expect(f.queue.archiveFailedId).toBe('A');
	expect(f.queue.status).toBe('Could not archive: offline');
	expect(f.queue.archivingId).toBeNull();
	f.archive(async () => ({ threadId: 'A' }));
	await f.queue.archive();
	expect(f.queue.archiveFailedId).toBeNull();
	expect(f.queue.selectedId).toBe('B');
	expect(f.queue.threads.has('A')).toBe(false);
});

test('selection during archive stays on C and reply actions stay blocked', async () => {
	const f = fixture();
	let finish!: (value: ArchiveResponse) => void;
	f.archive(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const archiving = f.queue.archive();
	expect(f.queue.threads.has('A')).toBe(true);
	expect(f.queue.archivingId).toBe('A');
	expect(f.queue.canArchive).toBe(false);
	f.queue.select('C');
	await f.queue.sendText();
	await f.queue.toggleRecord();
	await f.queue.archive();
	expect(f.bodies).toHaveLength(0);
	expect(f.queue.flow).toBe('idle');
	expect(f.archives).toHaveLength(1);
	finish({ threadId: 'A' });
	await archiving;
	expect(f.queue.selectedId).toBe('C');
	expect(f.queue.threads.has('A')).toBe(false);
	expect(f.queue.status).toBe('Archived A');
});

const approval: PendingApproval = {
	id: 'approval',
	requestId: 'request',
	method: 'item/commandExecution/requestApproval',
	threadId: 'A',
	turnId: 'turn',
	itemId: 'item',
	kind: 'command',
	changes: null,
	changesTruncated: false,
	createdAt: 0,
};

test('archive is blocked by busy state, approval or reply flow', async () => {
	const f = fixture();
	for (const gateway of [
		state({ A: live('inProgress') }),
		{ ...state(), approvals: [approval] },
	]) {
		f.queue.state = gateway;
		expect(f.queue.canArchive).toBe(false);
		await f.queue.archive();
	}
	f.queue.state = state();
	for (const flow of [
		'recording',
		'transcribing',
		'sending',
		'transcribeFailed',
		'sendFailed',
		'sendUnknown',
		'checking',
	] as const) {
		f.queue.flow = flow;
		expect(f.queue.canArchive).toBe(false);
		await f.queue.archive();
	}
	expect(f.archives).toHaveLength(0);
});

test('reload missing an in-flight archive target leaves completion to select its neighbor', async () => {
	const f = fixture();
	let finish!: (value: ArchiveResponse) => void;
	f.archive(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const archiving = f.queue.archive();
	f.setThreads(
		[...f.queue.threads.values()].filter((thread) => thread.id !== 'A'),
	);
	await f.queue.reload();
	expect(f.queue.selectedId).toBe('A');
	finish({ threadId: 'A' });
	await archiving;
	expect(f.queue.selectedId).toBe('B');
	expect(f.queue.order).toEqual(['B', 'C']);
});
