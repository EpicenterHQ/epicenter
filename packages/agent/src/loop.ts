import { extractErrorMessage } from 'wellcrafted/error';
import type { JsonValue } from 'wellcrafted/json';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { AgentEngine } from './engine.js';
import {
	type AgentMessage,
	isPersistableMessage,
	toModelMessages,
} from './message.js';
import {
	type AgentToolCall,
	type Approval,
	defaultApprovalDecision,
	NO_TOOLS,
	resolveApprovedToolCall,
	type ToolCatalog,
} from './tools.js';

export type ConversationError = { message: string; code?: string };

export type ConversationSnapshot = {
	messages: AgentMessage[];
	streaming: AgentMessage | null;
	isThinking: boolean;
	isGenerating: boolean;
	error: ConversationError | null;
};

export type ConversationHandle = {
	snapshot(): ConversationSnapshot;
	subscribe(listener: () => void): () => void;
	send(content: string): boolean;
	stop(): void;
	retry(): void;
	[Symbol.dispose](): void;
};

/**
 * The complete durable-data capability required by the loop. A document-backed
 * adapter may implement it, but document and CRDT types do not cross this seam.
 */
export type AgentMessageStore = {
	set(key: string, value: AgentMessage): void;
	entries(): IterableIterator<{ key: string; val: AgentMessage }>;
	observe(handler: () => void): () => void;
	[Symbol.dispose](): void;
};

export type ConversationOptions = {
	store: AgentMessageStore;
	engine: AgentEngine;
	tools?: ToolCatalog;
	approval?: Approval;
	generateId: () => string;
};

const DENY_GATED_MUTATIONS: Approval = {
	decide: defaultApprovalDecision,
	request: async () => false,
};

const MAX_STEPS = 50;

/** Create one UI-free conversation over injected data, engine, and tool ports. */
export function createConversation({
	store,
	engine,
	tools = NO_TOOLS,
	approval = DENY_GATED_MUTATIONS,
	generateId,
}: ConversationOptions): ConversationHandle {
	const listeners = new Set<() => void>();
	const notify = () => {
		for (const listener of listeners) listener();
	};
	const readAll = () =>
		[...store.entries()]
			.map((entry) => entry.val)
			.sort((a, b) => a.createdAt - b.createdAt);

	let persisted = readAll();
	let lastCreatedAt = persisted.reduce(
		(latest, message) => Math.max(latest, message.createdAt),
		0,
	);
	const nextCreatedAt = () => {
		lastCreatedAt = Math.max(Date.now(), lastCreatedAt + 1);
		return lastCreatedAt;
	};
	const unobserve = store.observe(() => {
		persisted = readAll();
		lastCreatedAt = persisted.reduce(
			(latest, message) => Math.max(latest, message.createdAt),
			lastCreatedAt,
		);
		notify();
	});
	let turn: AgentMessage[] | null = null;
	let error: ConversationError | null = null;
	let controller: AbortController | null = null;
	let streamingId: string | null = null;

	function snapshot(): ConversationSnapshot {
		const turnMessages = turn ?? [];
		const filling = turnMessages.find((message) => message.id === streamingId);
		const streaming =
			filling && isPersistableMessage(filling)
				? { ...filling, parts: [...filling.parts] }
				: null;
		const completed = turnMessages.filter(
			(message) => message.id !== streamingId && isPersistableMessage(message),
		);
		return {
			messages: completed.length > 0 ? [...persisted, ...completed] : persisted,
			streaming,
			isThinking: turn !== null && streaming === null && completed.length === 0,
			isGenerating: turn !== null,
			error,
		};
	}

	async function runStep(
		history: AgentMessage[],
		assistant: AgentMessage,
		signal: AbortSignal,
	): Promise<Result<AgentToolCall[], ConversationError>> {
		const calls: AgentToolCall[] = [];
		let failure: ConversationError | undefined;
		try {
			for await (const chunk of engine(
				{ messages: toModelMessages(history), tools: tools.definitions() },
				signal,
			)) {
				if (signal.aborted) break;
				switch (chunk.type) {
					case 'text-delta':
						appendText(assistant, chunk.delta);
						notify();
						break;
					case 'tool-call': {
						const call: AgentToolCall = {
							toolCallId: chunk.toolCallId,
							toolName: chunk.toolName,
							input: chunk.input,
						};
						calls.push(call);
						assistant.parts.push({ type: 'tool-call', ...call });
						notify();
						break;
					}
					case 'run-error':
						failure = {
							message: chunk.message,
							...(chunk.code !== undefined && { code: chunk.code }),
						};
						break;
					default:
						chunk satisfies never;
				}
			}
		} catch (cause) {
			if (!signal.aborted) failure = { message: extractErrorMessage(cause) };
		}
		return failure ? Err(failure) : Ok(calls);
	}

	async function runTools(
		assistant: AgentMessage,
		calls: AgentToolCall[],
		signal: AbortSignal,
	): Promise<void> {
		for (const call of calls) {
			if (signal.aborted) return;
			const outcome = await resolveApprovedToolCall({
				tools,
				approval,
				call,
				signal,
			});
			if (signal.aborted) return;
			appendToolResult(
				assistant,
				call,
				outcome.content,
				outcome.details,
				outcome.isError,
			);
			notify();
		}
	}

	async function runTurn(): Promise<void> {
		controller = new AbortController();
		const { signal } = controller;
		error = null;
		turn = [];
		notify();

		let failure: ConversationError | undefined;
		let steps = 0;
		while (!signal.aborted) {
			if (steps++ >= MAX_STEPS) {
				failure = {
					message: `Stopped after ${MAX_STEPS} steps without a final answer.`,
					code: 'MaxStepsExceeded',
				};
				break;
			}
			const history = [...persisted, ...turn];
			const assistant: AgentMessage = {
				id: generateId(),
				role: 'assistant',
				createdAt: nextCreatedAt(),
				parts: [],
			};
			turn.push(assistant);
			streamingId = assistant.id;
			notify();

			const { data: calls, error: stepError } = await runStep(
				history,
				assistant,
				signal,
			);
			streamingId = null;
			if (signal.aborted) break;
			if (stepError) {
				failure = stepError;
				break;
			}
			if (calls.length === 0) break;
			await runTools(assistant, calls, signal);
		}

		const finished =
			!signal.aborted && failure === undefined && turn
				? turn.filter(isPersistableMessage)
				: [];
		turn = null;
		streamingId = null;
		controller = null;
		error = failure ?? null;
		for (const message of finished) store.set(message.id, message);
		notify();
	}

	return {
		snapshot,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		send(content) {
			const text = content.trim();
			if (!text || turn !== null) return false;
			const id = generateId();
			store.set(id, {
				id,
				role: 'user',
				createdAt: nextCreatedAt(),
				parts: [{ type: 'text', text }],
			});
			void runTurn();
			return true;
		},
		stop() {
			controller?.abort();
		},
		retry() {
			if (turn !== null) return;
			void runTurn();
		},
		[Symbol.dispose]() {
			controller?.abort();
			unobserve();
			store[Symbol.dispose]();
		},
	};
}

function appendText(message: AgentMessage, delta: string): void {
	if (!delta) return;
	const last = message.parts.at(-1);
	if (last?.type === 'text') last.text += delta;
	else message.parts.push({ type: 'text', text: delta });
}

function appendToolResult(
	message: AgentMessage,
	call: AgentToolCall,
	content: string,
	details: JsonValue | undefined,
	isError: boolean,
): void {
	message.parts.push({
		type: 'tool-result',
		toolCallId: call.toolCallId,
		toolName: call.toolName,
		content,
		...(details !== undefined && { details }),
		isError,
	});
}
