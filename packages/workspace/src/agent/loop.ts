/**
 * The client-side agent loop (ADR-0047): one shape for every agent, run in the
 * client, in memory. It streams the live turn into a snapshot the UI renders,
 * drives the multi-step model/tool dance, and persists only finished messages
 * as last-write-wins records. A background process never runs this loop; tools reach it as
 * dispatched actions through the injected {@link ToolCatalog}.
 *
 * This is the framework-agnostic core. A Svelte binding mirrors its
 * {@link ConversationSnapshot} into reactive state; the loop itself is plain
 * TypeScript so the turn machine is testable without a UI.
 *
 * One model call is one step. A step streams text and tool-call requests into a
 * fresh assistant message; if it asked for tools, the loop runs them (gated by
 * approval), appends their results, and re-prompts with the augmented
 * transcript; it repeats until a step finishes with no tool calls. The
 * zero-tool case (Vocab) is one step that only ever produces text.
 */
import { extractErrorMessage } from 'wellcrafted/error';
import type { JsonValue } from 'wellcrafted/json';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { RecordsHandle } from '../document/attach-records.js';
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

/**
 * A failed turn: a human-readable message plus an optional structured code (e.g.
 * `'InsufficientCredits'`, `'Unauthorized'`) the engine surfaced on its
 * `run-error` chunk, so the UI can branch on the code rather than match the
 * message string.
 */
export type ConversationError = { message: string; code?: string };

/** The render state of one conversation: durable transcript plus the live turn. */
export type ConversationSnapshot = {
	/**
	 * Settled messages: persisted history plus any completed in-turn step (a prior
	 * tool step). These never change again, so they keep a stable identity and a
	 * keyed `{#each}` over them is referentially inert during a turn. Render rich.
	 */
	messages: AgentMessage[];
	/**
	 * The one message a step is streaming into right now, or null between steps and
	 * turns and until it has content (an empty in-flight message shows as the
	 * thinking bubble, not here). It is mutated in place as tokens arrive, so it is
	 * handed out as a fresh object each snapshot: a reactive view keys on identity,
	 * and a stable reference would freeze it on the first token until a reload.
	 * Render this one cheaply (raw); it settles into `messages` when the turn ends.
	 */
	streaming: AgentMessage | null;
	/** A turn is claimed but nothing visible has streamed yet (typing bubble). */
	isThinking: boolean;
	/** A turn is in flight (disable input, offer stop). */
	isGenerating: boolean;
	/** The last turn's failure, or null. Cleared on the next turn. */
	error: ConversationError | null;
};

/** The framework-agnostic conversation handle the UI binds to. */
export type ConversationHandle = {
	snapshot(): ConversationSnapshot;
	/** Register a change listener; returns the remover. Fires on every change. */
	subscribe(listener: () => void): () => void;
	/**
	 * Persist the user turn and answer it. Returns whether a turn started: `false`
	 * on empty input or mid-turn, so a caller can gate its own side-effects (a
	 * title write, say) on the loop's decision instead of re-deriving the guard.
	 */
	send(content: string): boolean;
	/** Abort the in-flight turn; its partial messages are dropped. */
	stop(): void;
	/** Re-answer the latest user turn after a failure. */
	retry(): void;
	[Symbol.dispose](): void;
};

/**
 * The loop's persistence seam: the subset of a by-id record store it actually
 * uses. `attachRecords`'s richer {@link RecordsHandle} satisfies this
 * structurally; the loop never reads a value by id (`get`) or removes one
 * (`delete`). It only appends a finished message (`set`), reads the whole
 * transcript (`entries`), and re-reads on change (`observe`). Naming the subset
 * keeps the contract honest about what a store must provide and lets a more
 * minimal backend satisfy it.
 */
export type AgentMessageStore = Pick<
	RecordsHandle<AgentMessage>,
	'set' | 'entries' | 'observe'
> &
	Disposable;

export type ConversationOptions = {
	/** The opened `conversations.messages` store, keyed by message id. */
	store: AgentMessageStore;
	/** The inference backend (the metered Epicenter stream, BYOK, or local). */
	engine: AgentEngine;
	/** The live tool surface; omit for a capability-free agent. */
	tools?: ToolCatalog;
	/** The approval policy and prompt; omit to deny every gated mutation. */
	approval?: Approval;
	/** Mint a message id. */
	generateId: () => string;
};

/** When no approval is wired, a gated mutation is denied rather than run. */
const DENY_GATED_MUTATIONS: Approval = {
	decide: defaultApprovalDecision,
	request: async () => false,
};

/**
 * A turn's multi-step tool loop is bounded by this runaway backstop, not a product
 * limit. Each step is one model call that either finishes (text, no tools) or asks
 * for tools and re-prompts; the loop never reads a provider finish reason, so a
 * misbehaving backend, or a transcript that spans backends (ADR-0054), could
 * otherwise re-issue tool calls forever. A well-behaved turn converges far below
 * this.
 */
const MAX_STEPS = 50;

export function createConversation(
	options: ConversationOptions,
): ConversationHandle {
	const {
		store,
		engine,
		tools = NO_TOOLS,
		approval = DENY_GATED_MUTATIONS,
		generateId,
	} = options;

	const listeners = new Set<() => void>();
	function notify(): void {
		for (const listener of listeners) listener();
	}

	/**
	 * The durable transcript, chronologically ordered. It is a flat, linear list
	 * by design: branching and edit history are a product tier built above the
	 * loop, not a missing primitive (ADR-0047 considered and deferred them, as
	 * TanStack's own flat `UIMessage[]` does). Deferred indefinitely.
	 */
	function readAll(): AgentMessage[] {
		return [...store.entries()]
			.map((entry) => entry.val)
			.sort((a, b) => a.createdAt - b.createdAt);
	}

	let persisted = readAll();
	const unobserve = store.observe(() => {
		persisted = readAll();
		notify();
	});

	// The in-flight turn: assistant messages built this turn, component-only
	// until a clean finish persists them. Null between turns.
	let turn: AgentMessage[] | null = null;
	let error: ConversationError | null = null;
	let controller: AbortController | null = null;
	// The message a step is actively streaming into; null between steps and turns.
	let streamingId: string | null = null;

	function snapshot(): ConversationSnapshot {
		// `isPersistableMessage` is the single predicate behind all three views:
		// what streams, what renders settled, and what persists. A message worth
		// showing mid-turn is exactly one a clean finish keeps, so they cannot
		// drift (a message that rendered then vanished on finish).
		const turnMessages = turn ?? [];
		// The message a step is filling now, handed out as a fresh object so a
		// reactive view re-reads its growing text instead of freezing on a stable
		// reference. Null until it has content, so the empty in-flight message is
		// the thinking bubble, not an empty streaming bubble.
		const filling = turnMessages.find((message) => message.id === streamingId);
		const streaming =
			filling && isPersistableMessage(filling)
				? { ...filling, parts: [...filling.parts] }
				: null;
		// Settled messages keep a stable identity: persisted history, plus any
		// completed in-turn step (a tool step that is no longer the one filling).
		// During a single-step turn this is just `persisted`, so the reference is
		// stable and a keyed `{#each}` over it does not reconcile per token.
		const completed = turnMessages.filter(
			(message) => message.id !== streamingId && isPersistableMessage(message),
		);
		const messages =
			completed.length > 0 ? [...persisted, ...completed] : persisted;
		return {
			messages,
			streaming,
			isThinking: turn !== null && streaming === null && completed.length === 0,
			isGenerating: turn !== null,
			error,
		};
	}

	/**
	 * Stream one model call into `assistant`, resolving to the tool calls it asked
	 * for (empty = final answer) or the failure that ended it. `history` is the
	 * transcript the model sees: everything before this step, never the empty
	 * `assistant` being filled. The caller snapshots it before pushing `assistant`,
	 * so a trailing blank message can't reach the prompt (a ChatML backend like
	 * local Ollama/Qwen would otherwise emit a literal "assistant" token and
	 * role-play the next user turn; hosted Gemini tolerated it, so it stayed latent).
	 */
	async function runStep(
		history: AgentMessage[],
		assistant: AgentMessage,
		signal: AbortSignal,
	): Promise<Result<AgentToolCall[], ConversationError>> {
		const prompt = toModelMessages(history);
		const calls: AgentToolCall[] = [];
		let failure: ConversationError | undefined;

		try {
			for await (const chunk of engine(
				{ messages: prompt, tools: tools.definitions() },
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
						// EngineChunk is a closed protocol the loop reduces; a new
						// variant must be handled here, not silently dropped.
						chunk satisfies never;
				}
			}
		} catch (cause) {
			if (!signal.aborted) failure = { message: extractErrorMessage(cause) };
		}

		return failure ? Err(failure) : Ok(calls);
	}

	/**
	 * Run a step's tool calls in model order. Approval can pause for a human, so
	 * keep execution sequential unless a real workload earns concurrent prompts.
	 */
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
			// Snapshot the prompt before pushing the new assistant: the model sees
			// the transcript up to here, never the empty message it is about to fill.
			const history = [...persisted, ...turn];
			const assistant: AgentMessage = {
				id: generateId(),
				role: 'assistant',
				createdAt: Date.now(),
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
			// The step is done filling this message; it is no longer streaming, so a
			// renderer can switch it to the rich path (during tools, or on finish).
			streamingId = null;
			if (signal.aborted) break;
			if (stepError) {
				failure = stepError;
				break;
			}

			// No tool calls means the model gave its final answer; the turn is done.
			const isFinalAnswer = calls.length === 0;
			if (isFinalAnswer) break;

			await runTools(assistant, calls, signal);
		}

		const aborted = signal.aborted;
		const finished =
			!aborted && failure === undefined && turn
				? turn.filter(isPersistableMessage)
				: [];

		// Clear the live turn before persisting so the durable messages never
		// double-render: once `turn` is null, the store write refreshes
		// `persisted` to include them.
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
				createdAt: Date.now(),
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

/** Append a text delta to the trailing text part, opening one if needed. */
function appendText(message: AgentMessage, delta: string): void {
	if (!delta) return;
	const last = message.parts[message.parts.length - 1];
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
