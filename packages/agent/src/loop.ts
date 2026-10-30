import type { AgentEngine } from '@epicenter/agent-protocol';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { JsonValue } from 'wellcrafted/json';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
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

/** Why a message is still unsaved after the store was asked to write it. */
export const AgentMessageStoreError = defineErrors({
	/** The store answered: it cannot confirm that the message is saved. */
	WriteFailed: ({ cause }: { cause: unknown }) => ({
		message: `The message store did not confirm the write: ${extractErrorMessage(cause)}`,
		cause,
	}),
	/**
	 * The store threw or rejected instead of answering, so whether the write
	 * landed is unknown. The loop reports this itself; a store returns
	 * `WriteFailed`.
	 */
	Threw: ({ cause }: { cause: unknown }) => ({
		message: `The message store threw instead of answering: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type AgentMessageStoreError = InferErrors<typeof AgentMessageStoreError>;

export const ConversationAdmissionError = defineErrors({
	/** The conversation took no action: nothing was written and no model ran. */
	NotAdmitted: ({
		reason,
	}: {
		reason: 'empty' | 'busy' | 'unsaved' | 'disposed';
	}) => ({
		message: `The conversation did not admit the request: ${reason}`,
		reason,
	}),
});
export type ConversationAdmissionError = InferErrors<
	typeof ConversationAdmissionError
>;

export type ConversationSnapshot = {
	/** The saved transcript, then `unsaved`, then the live turn's finished steps. */
	messages: AgentMessage[];
	streaming: AgentMessage | null;
	isThinking: boolean;
	isGenerating: boolean;
	/** Why the last model turn ended without an answer. Never a store failure. */
	error: ConversationError | null;
	/**
	 * Whole messages the store has not confirmed, oldest first: a sent learner
	 * message, or a fully received answer. Each also appears once in `messages`.
	 */
	unsaved: AgentMessage[];
	/** A store write for `unsaved` is in flight. */
	isSaving: boolean;
	/**
	 * Why the last write left `unsaved` unconfirmed. Stays while `save()` tries
	 * again and clears when everything is saved.
	 */
	saveError: AgentMessageStoreError | null;
};

export type ConversationHandle = {
	snapshot(): ConversationSnapshot;
	subscribe(listener: () => void): () => void;
	/**
	 * Save one learner message, then start the model turn in the background.
	 *
	 * Resolves when the store has answered. `Ok` means the message is saved; the
	 * turn has started unless `stop` or disposal arrived first. On `Err` no model
	 * ran. A failed write keeps the message in `unsaved` under its id.
	 */
	send(
		content: string,
	): Promise<Result<void, ConversationAdmissionError | AgentMessageStoreError>>;
	/** Abort the model turn, or cancel the one a pending `send` would start. */
	stop(): void;
	/** Run a model turn over the saved transcript. Ignored while busy or unsaved. */
	retry(): void;
	/**
	 * Write `unsaved` again under the same ids. Never runs the model or a tool,
	 * and never writes a message the store already confirmed.
	 */
	save(): Promise<
		Result<void, ConversationAdmissionError | AgentMessageStoreError>
	>;
	/** Writes already in flight finish before the store is disposed. */
	[Symbol.dispose](): void;
};

/**
 * The complete durable-data capability required by the loop. A document-backed
 * adapter may implement it, but document and CRDT types do not cross this seam.
 */
export type AgentMessageStore = {
	/**
	 * Write one whole message under its id and answer once the store can say
	 * whether it is saved. `Ok` is the store's promise that the message survives
	 * as far as this store ever keeps anything; the loop asks the model nothing
	 * before a learner message gets it. Writing an id the store already holds
	 * must not produce a second message.
	 */
	set(
		key: string,
		value: AgentMessage,
	): Promise<Result<void, AgentMessageStoreError>>;
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
	let unsaved: AgentMessage[] = [];
	let saveError: AgentMessageStoreError | null = null;
	let isSaving = false;
	// One send, retry, or save at a time, reserved before its first await and
	// held through every write and model step it owns.
	let isBusy = false;
	let isDisposed = false;

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
		// A store may announce a write before it confirms it, so a message can be
		// in both lists for a while; the stored copy is the one rendered.
		const stored = new Set(persisted.map((message) => message.id));
		const retained = unsaved.filter((message) => !stored.has(message.id));
		return {
			messages:
				retained.length > 0 || completed.length > 0
					? [...persisted, ...retained, ...completed]
					: persisted,
			streaming,
			isThinking: turn !== null && streaming === null && completed.length === 0,
			isGenerating: turn !== null,
			error,
			unsaved: [...unsaved],
			isSaving,
			saveError,
		};
	}

	/**
	 * Write `unsaved` in order and stop at the first message the store does not
	 * confirm, so a later message is never saved ahead of an earlier one. One
	 * attempt per message: a failed or thrown write may still have landed, and
	 * only an explicit `save()` asks again.
	 */
	async function saveUnsaved(): Promise<Result<void, AgentMessageStoreError>> {
		isSaving = true;
		notify();
		let failure: AgentMessageStoreError | null = null;
		for (const message of [...unsaved]) {
			const { data: saved, error: writeError } = await tryAsync({
				try: () => store.set(message.id, message),
				catch: (cause) => AgentMessageStoreError.Threw({ cause }),
			});
			failure = writeError !== null ? writeError : saved.error;
			if (failure !== null) break;
			unsaved = unsaved.filter((pending) => pending.id !== message.id);
			persisted = readAll();
			notify();
		}
		isSaving = false;
		saveError = failure;
		// Disposal waited for these writes; the store has no user left.
		if (isDisposed) store[Symbol.dispose]();
		return failure === null ? Ok(undefined) : Err(failure);
	}

	function refusal() {
		if (isDisposed) return 'disposed';
		if (isBusy) return 'busy';
		if (unsaved.length > 0) return 'unsaved';
		return null;
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

	/** Run one admitted turn to its end, then release the admission. */
	async function runTurn({ signal }: AbortController): Promise<void> {
		const steps: AgentMessage[] = [];
		error = null;
		turn = steps;
		notify();

		let failure: ConversationError | undefined;
		let count = 0;
		try {
			while (!signal.aborted) {
				if (count++ >= MAX_STEPS) {
					failure = {
						message: `Stopped after ${MAX_STEPS} steps without a final answer.`,
						code: 'MaxStepsExceeded',
					};
					break;
				}
				const history = [...persisted, ...steps];
				const assistant: AgentMessage = {
					id: generateId(),
					role: 'assistant',
					createdAt: nextCreatedAt(),
					parts: [],
				};
				steps.push(assistant);
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
		} catch (cause) {
			// A tool catalog or approval that rejects ends the turn like a failed
			// stream: nothing is saved and the conversation stays usable.
			if (!signal.aborted) failure = { message: extractErrorMessage(cause) };
		}

		turn = null;
		streamingId = null;
		controller = null;
		error = failure ?? null;
		// A fully received answer outlives a failed write: it stays in `unsaved`
		// under its ids until `save()` lands it.
		unsaved =
			!signal.aborted && failure === undefined
				? steps.filter(isPersistableMessage)
				: [];
		if (unsaved.length > 0) await saveUnsaved();
		isBusy = false;
		notify();
	}

	return {
		snapshot,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async send(content) {
			const text = content.trim();
			const reason = text ? refusal() : 'empty';
			if (reason !== null) {
				return ConversationAdmissionError.NotAdmitted({ reason });
			}
			const id = generateId();
			isBusy = true;
			const admitted = new AbortController();
			controller = admitted;
			unsaved = [
				{
					id,
					role: 'user',
					createdAt: nextCreatedAt(),
					parts: [{ type: 'text', text }],
				},
			];
			const saved = await saveUnsaved();
			// The write may finish after a stop or disposal, both of which abort
			// this admission; the model turn it would have started does not.
			if (saved.error !== null || admitted.signal.aborted) {
				controller = null;
				isBusy = false;
				notify();
				return saved;
			}
			void runTurn(admitted);
			return saved;
		},
		stop() {
			controller?.abort();
		},
		retry() {
			if (refusal() !== null) return;
			isBusy = true;
			controller = new AbortController();
			void runTurn(controller);
		},
		async save() {
			if (isDisposed || isBusy) {
				return ConversationAdmissionError.NotAdmitted({
					reason: isDisposed ? 'disposed' : 'busy',
				});
			}
			if (unsaved.length === 0) return Ok(undefined);
			isBusy = true;
			const saved = await saveUnsaved();
			isBusy = false;
			notify();
			return saved;
		},
		[Symbol.dispose]() {
			if (isDisposed) return;
			isDisposed = true;
			controller?.abort();
			unobserve();
			if (!isSaving) store[Symbol.dispose]();
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
