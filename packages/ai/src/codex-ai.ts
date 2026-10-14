import { Ok, type Result } from 'wellcrafted/result';
import {
	type Ai,
	createReplyStream,
	ReplyError,
	type ReplyRequest,
} from './reply.js';

export type CodexNotification = { method: string; params: unknown };
/**
 * A dedicated text-only connection owns admitted attempts through their cleanup.
 * Failed interrupt/unsubscribe requests retire the connection rather than leave live turns.
 */
export type CodexConnection = {
	signal: AbortSignal;
	request(method: string, params: unknown): Promise<unknown>;
	subscribe(listener: (event: CodexNotification) => void): () => void;
	admit(): () => void;
	close(): Promise<void>;
};

function record(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Invalid Codex response object.');
	return value as Record<string, unknown>;
}
function id(value: unknown): string {
	if (typeof value !== 'string' || !value)
		throw new Error('Invalid Codex response identifier.');
	return value;
}

/** Borrows RPC; every attempt starts from the supplied application transcript. */
export function createCodexAi(
	connection: CodexConnection,
	options: { model: string },
) {
	const { model } = options;
	async function* generate(
		request: ReplyRequest,
		signal: AbortSignal,
	): AsyncGenerator<string, Result<string, ReplyError>> {
		const release = connection.admit();
		let threadId: string | undefined;
		let turnId: string | undefined;
		let interruption: Promise<unknown> | undefined;
		let completed: Record<string, unknown> | undefined;
		let preview: string | undefined;
		let problem: unknown;
		let hasProblem = false;
		let wake = Promise.withResolvers<void>();
		const messages = new Map<string, { text: string; phase: unknown }>();
		function interruptTurn() {
			if (interruption) return interruption;
			if (!threadId || !turnId || completed || connection.signal.aborted)
				return;
			interruption = connection.request('turn/interrupt', { threadId, turnId });
			// Cancellation starts immediately; finally awaits the same request for cleanup.
			void interruption.catch(() => undefined);
			return interruption;
		}
		const unsubscribe = connection.subscribe((event) => {
			try {
				const params = record(event.params);
				if (params.threadId !== threadId) return;
				if (event.method === 'turn/started') {
					turnId = id(record(params.turn).id);
					if (signal.aborted) interruptTurn();
				} else if (
					event.method === 'item/started' ||
					event.method === 'item/completed'
				) {
					const item = record(params.item);
					if (item.type === 'agentMessage') {
						if (typeof item.text !== 'string')
							throw new Error('Invalid Codex agent text.');
						messages.set(id(item.id), { text: item.text, phase: item.phase });
						if (item.phase === 'final_answer') preview = item.text;
					} else if (
						!['userMessage', 'reasoning'].includes(String(item.type))
					) {
						throw new Error(
							`Codex emitted a non-text item: ${String(item.type)}`,
						);
					}
				} else if (event.method === 'item/agentMessage/delta') {
					const message = messages.get(id(params.itemId));
					if (typeof params.delta !== 'string')
						throw new Error('Invalid Codex text delta.');
					// Unknown phases are never mistaken for final-answer previews.
					if (message) {
						message.text += params.delta;
						if (message.phase === 'final_answer') preview = message.text;
					}
				} else if (event.method === 'turn/completed') {
					completed = record(params.turn);
				} else if (event.method === 'error' && params.willRetry !== true) {
					throw new Error('Codex reported a turn error.');
				}
			} catch (cause) {
				problem = cause;
				hasProblem = true;
			}
			wake.resolve();
		});
		const stop = () => {
			wake.resolve();
			interruptTurn();
		};
		signal.addEventListener('abort', stop, { once: true });
		try {
			const started = record(
				await connection.request('thread/start', {
					model,
					ephemeral: true,
					approvalPolicy: 'never',
					sandbox: 'read-only',
					baseInstructions: request.instructions,
					developerInstructions: '',
					environments: [],
					selectedCapabilityRoots: [],
					dynamicTools: [],
				}),
			);
			const thread = record(started.thread);
			threadId = id(thread.id);
			if (thread.ephemeral !== true)
				return ReplyError.Unsupported({
					reason: 'Codex did not create an ephemeral thread',
				});
			if (signal.aborted) return ReplyError.Cancelled();
			if (request.messages.length)
				await connection.request('thread/inject_items', {
					threadId,
					items: request.messages.map((message) => ({
						type: 'message',
						role: message.role,
						content: [
							{
								type: message.role === 'user' ? 'input_text' : 'output_text',
								text: message.content,
							},
						],
					})),
				});
			if (signal.aborted) return ReplyError.Cancelled();
			const startedTurn = record(
				await connection.request('turn/start', { threadId, input: [] }),
			);
			turnId = id(record(startedTurn.turn).id);
			if (signal.aborted) stop();
			for (;;) {
				if (signal.aborted) return ReplyError.Cancelled();
				if (hasProblem) return ReplyError.Provider({ cause: problem });
				if (preview !== undefined) {
					const current = preview;
					preview = undefined;
					yield current;
					continue;
				}
				if (completed) break;
				await wake.promise;
				wake = Promise.withResolvers<void>();
			}
			if (completed.status !== 'completed')
				return ReplyError.Incomplete({ reason: String(completed.status) });
			const finals = [...messages.values()].filter(
				(message) => message.phase === 'final_answer',
			);
			if (finals.length !== 1)
				return ReplyError.Incomplete({
					reason: 'missing or ambiguous final-answer phase',
				});
			return Ok(finals[0]!.text);
		} catch (cause) {
			return signal.aborted
				? ReplyError.Cancelled()
				: ReplyError.Provider({ cause });
		} finally {
			signal.removeEventListener('abort', stop);
			try {
				if (threadId && !connection.signal.aborted) {
					await interruptTurn();
					await connection.request('thread/unsubscribe', { threadId });
				}
			} finally {
				unsubscribe();
				release();
			}
		}
	}
	return Object.freeze({
		reply(request: ReplyRequest) {
			const captured = {
				...request,
				messages: request.messages.map((message) => ({ ...message })),
			};
			return createReplyStream(connection.signal, captured.signal, (signal) =>
				generate(captured, signal),
			);
		},
	} satisfies Ai);
}
