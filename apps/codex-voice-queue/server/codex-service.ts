import type {
	ApprovalPolicy,
	ArchiveResponse,
	GatewayState,
	LiveTurn,
	Notice,
	PendingApproval,
	Sandbox,
	SendResponse,
	ThreadSummary,
	TurnsResponse,
} from '../src/lib/api-types.js';
import type {
	ApprovalDecision,
	ApprovalResponse,
	CommandExecutionRequestApprovalParams,
	FileChangeRequestApprovalParams,
	FileUpdateChange,
	KnownThreadItem,
	RequestId,
	RpcNotification,
	RpcServerRequest,
	Thread,
	ThreadListResponse,
	ThreadReadResponse,
	ThreadStatus,
	ThreadTurnsListResponse,
	Turn,
	TurnStartResponse,
} from '../src/lib/protocol.js';
import { type AppServerClient, AppServerError } from './app-server-client.js';

export class BusyError extends Error {
	constructor(message = 'Codex is still working on this conversation') {
		super(message);
		this.name = 'BusyError';
	}
}
export class ReplyConflictError extends Error {
	constructor() {
		super('This reply ID was already used for different text');
		this.name = 'ReplyConflictError';
	}
}
export class OutcomeUnknownError extends Error {
	constructor(
		message = 'Codex did not confirm this reply before the connection timed out or dropped; it may have been delivered',
	) {
		super(message);
		this.name = 'OutcomeUnknownError';
	}
}
export class ValidationError extends Error {
	constructor(
		message: string,
		public status = 400,
	) {
		super(message);
		this.name = 'ValidationError';
	}
}
export function createCodexService({
	client,
	sandbox,
	approval,
}: {
	client: AppServerClient;
	sandbox: Sandbox;
	approval: ApprovalPolicy;
}) {
	const bootId = crypto.randomUUID();
	const receipts = new Map<
		string,
		{
			threadId: string;
			text: string;
			state: 'pending' | 'accepted' | 'unknown';
			promise: Promise<SendResponse>;
			result?: SendResponse;
			at: number;
		}
	>();
	const fileChanges = new Map<
		string,
		{ changes: FileUpdateChange[]; truncated: boolean }
	>();
	function changesKey(item: {
		threadId: string;
		turnId: string;
		itemId: string;
	}) {
		return `${item.threadId}:${item.turnId}:${item.itemId}`;
	}
	function trackChanges(event: {
		threadId: string;
		turnId: string;
		itemId: string;
		changes: FileUpdateChange[];
	}) {
		let remaining = 100_000;
		let truncated = false;
		const changes = event.changes.map((change) => {
			const diff = change.diff.slice(0, remaining);
			remaining -= diff.length;
			if (diff.length < change.diff.length) truncated = true;
			return { ...change, diff };
		});
		const key = changesKey(event);
		fileChanges.set(key, { changes, truncated });
		if (fileChanges.size > 200) {
			const oldest = fileChanges.keys().next().value;
			if (oldest !== undefined) fileChanges.delete(oldest);
		}
	}
	function approvalChanges(item: PendingApproval) {
		const tracked =
			item.kind === 'fileChange'
				? fileChanges.get(changesKey(item))
				: undefined;
		return {
			changes: tracked?.changes ?? null,
			changesTruncated: tracked?.truncated ?? false,
		};
	}
	const live = new Map<string, LiveTurn>();
	const resumed = new Set<string>();
	const sending = new Set<string>();
	const archiving = new Set<string>();
	const approvals = new Map<
		string,
		{ approval: PendingApproval; resolve: (response: ApprovalResponse) => void }
	>();
	const notices: Notice[] = [];
	function notice(threadId: string | null, message: string) {
		notices.push({
			id: crypto.randomUUID(),
			threadId,
			at: Date.now(),
			message,
		});
		if (notices.length > 100) notices.shift();
	}
	function clearApprovals(matches: (approval: PendingApproval) => boolean) {
		for (const [id, pending] of approvals) {
			if (matches(pending.approval)) {
				approvals.delete(id);
				pending.resolve({ decision: 'decline' });
			}
		}
	}
	function update(threadId: string, patch: Partial<LiveTurn>) {
		const previous = live.get(threadId) ?? {
			turnId: '',
			status: 'completed',
			startedAt: null,
			completedAt: null,
			error: null,
			lastAgentMessage: '',
			threadStatus: null,
		};
		live.set(threadId, { ...previous, ...patch });
	}
	function turnChanged(threadId: string, turn: Turn) {
		const previous = live.get(threadId);
		update(threadId, {
			turnId: turn.id,
			status: turn.status,
			startedAt: turn.startedAt,
			completedAt: turn.completedAt,
			error: turn.error?.message ?? null,
			...(previous?.turnId === turn.id ? {} : { lastAgentMessage: '' }),
		});
	}
	client.onNotification(({ method, params }: RpcNotification) => {
		if (!params || typeof params !== 'object') return;
		switch (method) {
			case 'thread/archived': {
				const { threadId } = params as { threadId: string };
				live.delete(threadId);
				resumed.delete(threadId);
				break;
			}
			case 'turn/started': {
				const event = params as { threadId: string; turn: Turn };
				turnChanged(event.threadId, event.turn);
				break;
			}
			case 'turn/completed': {
				const event = params as { threadId: string; turn: Turn };
				turnChanged(event.threadId, event.turn);
				for (const key of fileChanges.keys())
					if (key.startsWith(`${event.threadId}:${event.turn.id}:`))
						fileChanges.delete(key);
				clearApprovals(
					(item) =>
						item.threadId === event.threadId && item.turnId === event.turn.id,
				);
				break;
			}
			case 'thread/status/changed': {
				const event = params as { threadId: string; status: ThreadStatus };
				update(event.threadId, { threadStatus: event.status });
				break;
			}
			case 'item/agentMessage/delta': {
				const event = params as {
					threadId: string;
					turnId: string;
					delta: string;
				};
				const previous = live.get(event.threadId);
				update(event.threadId, {
					turnId: event.turnId,
					lastAgentMessage: (
						(previous?.lastAgentMessage ?? '') + event.delta
					).slice(-4000),
				});
				break;
			}
			case 'item/fileChange/patchUpdated': {
				trackChanges(
					params as {
						threadId: string;
						turnId: string;
						itemId: string;
						changes: FileUpdateChange[];
					},
				);
				break;
			}
			case 'item/started':
			case 'item/completed': {
				const event = params as {
					threadId: string;
					turnId: string;
					item: KnownThreadItem;
				};
				if (event.item.type === 'fileChange')
					trackChanges({
						...event,
						itemId: event.item.id,
						changes: event.item.changes,
					});
				if (method === 'item/completed' && event.item.type === 'agentMessage')
					update(event.threadId, {
						turnId: event.turnId,
						lastAgentMessage: event.item.text.slice(-4000),
					});
				break;
			}
			case 'error': {
				const event = params as {
					threadId: string;
					turnId: string;
					error: { message: string };
					willRetry: boolean;
				};
				update(event.threadId, {
					turnId: event.turnId,
					error: event.error.message,
				});
				break;
			}
			case 'serverRequest/resolved': {
				const event = params as { threadId: string; requestId: RequestId };
				clearApprovals(
					(item) =>
						item.threadId === event.threadId &&
						item.requestId === event.requestId,
				);
				break;
			}
		}
	});
	client.onExit(() => {
		resumed.clear();
		fileChanges.clear();
		clearApprovals(() => true);
		for (const [id, turn] of live)
			if (turn.status === 'inProgress')
				update(id, {
					status: 'failed',
					error: 'Codex app-server stopped',
					completedAt: Date.now() / 1000,
					threadStatus: { type: 'systemError' },
				});
	});
	client.onServerRequest(async (request: RpcServerRequest) => {
		const { method, params } = request;
		const threadId =
			params &&
			typeof params === 'object' &&
			'threadId' in params &&
			typeof params.threadId === 'string'
				? params.threadId
				: null;
		if (
			method === 'item/commandExecution/requestApproval' ||
			method === 'item/fileChange/requestApproval'
		) {
			const input = params as CommandExecutionRequestApprovalParams &
				FileChangeRequestApprovalParams;
			if (!input?.threadId || !input.turnId || !input.itemId) {
				notice(
					threadId,
					'Codex sent an invalid approval request; it was declined.',
				);
				throw new AppServerError(-32000, 'Invalid approval request', method);
			}
			const id = crypto.randomUUID();
			const pending: PendingApproval = {
				id,
				requestId: request.id,
				method,
				threadId: input.threadId,
				turnId: input.turnId,
				itemId: input.itemId,
				kind:
					method === 'item/commandExecution/requestApproval'
						? 'command'
						: 'fileChange',
				changes: null,
				changesTruncated: false,
				command: input.command,
				cwd: input.cwd,
				reason: input.reason,
				grantRoot: input.grantRoot,
				networkHost: input.networkApprovalContext?.host,
				createdAt: Date.now(),
			};
			return new Promise<ApprovalResponse>((resolve) =>
				approvals.set(id, { approval: pending, resolve }),
			);
		}
		const descriptions: Record<string, string> = {
			'item/tool/requestUserInput':
				'Codex asked for user input; the voice queue declined it. Open this conversation in Codex to answer.',
			'item/permissions/requestApproval':
				'Codex asked for additional permissions; the voice queue declined them.',
			'mcpServer/elicitation/request':
				'Codex asked for MCP input; the voice queue declined it.',
			'item/tool/call':
				'Codex asked to run a client-side tool; the voice queue declined it.',
		};
		notice(
			threadId,
			descriptions[method] ??
				`Codex requested ${method}; the voice queue declined it. Open Codex to continue.`,
		);
		switch (method) {
			case 'mcpServer/elicitation/request':
				return { action: 'decline', content: null, _meta: null };
			case 'item/tool/call':
				return {
					contentItems: [
						{
							type: 'inputText',
							text: 'Codex Voice Queue does not run client-side tools.',
						},
					],
					success: false,
				};
			case 'execCommandApproval':
			case 'applyPatchApproval':
				return {
					decision: {
						denied: {
							rejection: 'Codex Voice Queue only answers v2 approval requests.',
						},
					},
				};
			default:
				throw new AppServerError(
					-32601,
					'Not supported by Codex Voice Queue',
					method,
				);
		}
	});
	function summary(thread: Thread): ThreadSummary {
		const source =
			typeof thread.source === 'string'
				? thread.source
				: (Object.keys(thread.source)[0] ?? 'unknown');
		return {
			id: thread.id,
			title: (
				thread.name?.trim() ||
				thread.preview
					.split(/\r?\n/)
					.find((line) => line.trim())
					?.trim() ||
				'(untitled)'
			).slice(0, 200),
			preview: thread.preview.slice(0, 300),
			cwd: thread.cwd,
			source,
			createdAt: thread.createdAt,
			updatedAt: thread.updatedAt,
			status: live.get(thread.id)?.threadStatus ?? thread.status,
			gitBranch: thread.gitInfo?.branch ?? null,
			live: live.get(thread.id),
		};
	}
	return {
		bootId,
		async listThreads() {
			const threads: ThreadSummary[] = [];
			const seen = new Set<string>();
			const cursors = new Set<string>();
			let cursor: string | undefined;
			do {
				const page = await client.request<ThreadListResponse>('thread/list', {
					limit: 100,
					sortKey: 'updated_at',
					sortDirection: 'desc',
					archived: false,
					sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'],
					...(cursor ? { cursor } : {}),
				});
				for (const thread of page.data)
					if (!seen.has(thread.id)) {
						seen.add(thread.id);
						threads.push(summary(thread));
					}
				if (threads.length >= 5000)
					return {
						threads: threads.slice(0, 5000),
						truncated: threads.length > 5000 || page.nextCursor !== null,
					};
				cursor = page.nextCursor ?? undefined;
				if (cursor && cursors.has(cursor))
					throw new AppServerError(
						-32000,
						'Codex returned a repeated thread cursor',
						'thread/list',
					);
				if (cursor) cursors.add(cursor);
			} while (cursor);
			return { threads, truncated: false };
		},
		async readTurns(threadId: string, cursor?: string): Promise<TurnsResponse> {
			try {
				const page = await client.request<ThreadTurnsListResponse>(
					'thread/turns/list',
					{
						threadId,
						itemsView: 'full',
						sortDirection: 'desc',
						limit: 10,
						...(cursor ? { cursor } : {}),
					},
				);
				return {
					turns: [...page.data].reverse(),
					nextCursor: page.nextCursor,
					allLoaded: page.nextCursor === null,
				};
			} catch (error) {
				if (!(error instanceof AppServerError)) throw error;
				try {
					const result = await client.request<ThreadReadResponse>(
						'thread/read',
						{ threadId, includeTurns: true },
					);
					return {
						turns: result.thread.turns.slice(-10),
						nextCursor: null,
						allLoaded: true,
						fallback: 'thread/read',
					};
				} catch {
					throw error;
				}
			}
		},
		async archiveThread(threadId: string): Promise<ArchiveResponse> {
			if (
				live.get(threadId)?.status === 'inProgress' ||
				live.get(threadId)?.threadStatus?.type === 'active' ||
				sending.has(threadId) ||
				archiving.has(threadId)
			)
				throw new BusyError();
			if (
				[...approvals.values()].some(
					({ approval }) => approval.threadId === threadId,
				)
			)
				throw new BusyError(
					'Answer the pending approval before archiving this conversation',
				);
			archiving.add(threadId);
			try {
				await client.ensureReady();
				await client.request('thread/archive', { threadId });
				live.delete(threadId);
				resumed.delete(threadId);
				for (const key of fileChanges.keys())
					if (key.startsWith(`${threadId}:`)) fileChanges.delete(key);
				return { threadId };
			} finally {
				archiving.delete(threadId);
			}
		},
		async sendText(
			threadId: string,
			text: string,
			{
				replyId,
				retry = false,
				bootId: previousBootId,
			}: { replyId: string; retry?: boolean; bootId?: string },
		): Promise<SendResponse> {
			const trimmed = text.trim();
			for (const [id, receipt] of receipts)
				if (
					receipt.state !== 'pending' &&
					Date.now() - receipt.at > 2 * 60 * 60 * 1000
				)
					receipts.delete(id);
			const existing = receipts.get(replyId);
			if (existing) {
				if (existing.threadId !== threadId || existing.text !== trimmed)
					throw new ReplyConflictError();
				if (existing.state === 'unknown') throw new OutcomeUnknownError();
				if (existing.state === 'accepted' && existing.result)
					return { ...existing.result, duplicate: true };
				return { ...(await existing.promise), duplicate: true };
			}
			if (retry && previousBootId !== bootId)
				throw new OutcomeUnknownError(
					'The gateway restarted, so it cannot tell whether this reply was delivered',
				);
			while (receipts.size >= 500) {
				const oldest = [...receipts].find(
					([, receipt]) => receipt.state !== 'pending',
				);
				if (!oldest) throw new BusyError('Too many replies are pending');
				receipts.delete(oldest[0]);
			}
			const promise = Promise.resolve().then(async () => {
				if (!trimmed || trimmed.length > 20_000)
					throw new ValidationError('Text must contain 1 to 20000 characters');
				if (
					live.get(threadId)?.status === 'inProgress' ||
					sending.has(threadId) ||
					archiving.has(threadId)
				)
					throw new BusyError();
				sending.add(threadId);
				let turnStartSent = false;
				try {
					await client.ensureReady();
					if (!resumed.has(threadId)) {
						const response = await client.request<{ thread: Thread }>(
							'thread/resume',
							{
								threadId,
								excludeTurns: true,
								approvalPolicy: approval,
								sandbox,
								approvalsReviewer: 'user',
							},
						);
						if (response.thread.status.type === 'active')
							throw new BusyError(
								'Codex is already working on this conversation in another session',
							);
						resumed.add(threadId);
					}
					const result = await client.request<TurnStartResponse>(
						'turn/start',
						{
							clientUserMessageId: replyId,
							threadId,
							input: [{ type: 'text', text: trimmed, text_elements: [] }],
							approvalPolicy: approval,
							approvalsReviewer: 'user',
						},
						{
							onSend: () => {
								turnStartSent = true;
							},
						},
					);
					// Completion can arrive before the start response on the same stream.
					if (live.get(threadId)?.turnId !== result.turn.id)
						update(threadId, {
							turnId: result.turn.id,
							status: 'inProgress',
							startedAt: result.turn.startedAt ?? Date.now() / 1000,
							completedAt: null,
							error: null,
							lastAgentMessage: '',
						});
					return {
						turnId: result.turn.id,
						status: result.turn.status,
						replyId,
						duplicate: false,
					};
				} catch (error) {
					if (
						turnStartSent &&
						error instanceof AppServerError &&
						error.kind !== 'rpc'
					) {
						const receipt = receipts.get(replyId);
						if (receipt) receipt.state = 'unknown';
						throw new OutcomeUnknownError();
					}
					throw error;
				} finally {
					sending.delete(threadId);
				}
			});
			const receipt = {
				threadId,
				text: trimmed,
				state: 'pending' as 'pending' | 'accepted' | 'unknown',
				promise,
				at: Date.now(),
				result: undefined as SendResponse | undefined,
			};
			receipts.set(replyId, receipt);
			try {
				const result = await promise;
				receipt.state = 'accepted';
				receipt.result = result;
				return result;
			} catch (error) {
				if (receipt.state !== 'unknown') receipts.delete(replyId);
				throw error;
			}
		},
		decideApproval(id: string, decision: ApprovalDecision) {
			const pending = approvals.get(id);
			if (!pending) return false;
			if (
				decision === 'accept' &&
				pending.approval.kind === 'fileChange' &&
				!approvalChanges(pending.approval).changes?.length
			)
				return 'changes_unavailable' as const;
			approvals.delete(id);
			pending.resolve({ decision });
			return true;
		},
		getState(): GatewayState {
			return {
				bootId,
				appServer: client.getState(),
				live: Object.fromEntries(live),
				approvals: [...approvals.values()].map((entry) => ({
					...entry.approval,
					...approvalChanges(entry.approval),
				})),
				notices: [...notices],
			};
		},
	};
}
export type CodexService = ReturnType<typeof createCodexService>;
