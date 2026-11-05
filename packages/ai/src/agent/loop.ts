/**
 * One conversation with a model over a contract's messages collection
 * (ADR-0047): it reads the chat's finished messages from the folder's
 * collection, streams each turn from the chosen model through `ai.chat`,
 * runs the tools the host offers, and saves each finished message as its
 * own note. The folder lists and follows the collection while the
 * conversation listens; the conversation keeps no copy of its own.
 *
 * A message is saved with the folder's `set`, which never fails: the folder
 * keeps it, in order, until it lands (ADR-0775). Whether the store can be
 * reached is the folder's to say, not the conversation's.
 */
import type { FolderNotes } from '@epicenter/folder/core';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { JsonValue } from 'wellcrafted/json';
import { createLogger } from 'wellcrafted/logger';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { ChatMessage } from '../client.js';
import type { Ai, ModelChoice } from '../open-ai.js';
import {
	type AgentMessage,
	isPersistableMessage,
	type MessageNote,
	type MessagesCollection,
	readMessage,
	toChatMessages,
} from './message.js';
import { streamStep } from './stream.js';
import {
	type AgentTool,
	type AgentToolCall,
	type Approve,
	runTool,
	toChatTools,
} from './tools.js';

const log = createLogger('ai/agent');

export type ConversationError = { message: string; code?: string };

export const ConversationAdmissionError = defineErrors({
	/** The conversation took no action: nothing was written and no model ran. */
	NotAdmitted: ({ reason }: { reason: 'empty' | 'busy' | 'disposed' }) => ({
		message: `The conversation did not admit the request: ${reason}`,
		reason,
	}),
});
export type ConversationAdmissionError = InferErrors<
	typeof ConversationAdmissionError
>;

/** A message note of this chat that does not read: not shown, and not sent to the model. */
export type UnreadableMessage = { path: string; reason: string };

export type ConversationSnapshot = {
	/** The saved transcript, then the messages handed to the folder and not yet shown, then the live turn's finished steps. */
	messages: AgentMessage[];
	streaming: AgentMessage | null;
	isThinking: boolean;
	isGenerating: boolean;
	/** Why the last model turn ended without an answer. */
	error: ConversationError | null;
	/** This chat's message notes that do not read. */
	unreadable: UnreadableMessage[];
	/**
	 * Whether the chat's saved messages were ever listed. Until then the
	 * transcript may be missing what is saved, so a turn waits for the
	 * listing, and one stopped or disposed while it waits ends with the
	 * error code `Unlisted`, having asked no model.
	 */
	listed: boolean;
};

export type ConversationHandle = {
	snapshot(): ConversationSnapshot;
	subscribe(listener: () => void): () => void;
	/**
	 * Settles once the chat's saved messages were first listed, or once the
	 * conversation is disposed. A listing that cannot reach the store is
	 * tried again by the folder, and this waits for it.
	 */
	readonly ready: Promise<void>;
	/**
	 * Save one learner message, then start the model turn in the background.
	 *
	 * Answers once the message is handed to the folder, which keeps it
	 * until it lands; it shows in `snapshot().messages` from then. On `Err`
	 * nothing was written and no model ran.
	 */
	send(content: string): Promise<Result<void, ConversationAdmissionError>>;
	/** Abort the model turn, or cancel the one a pending `send` would start; answers once no turn runs. */
	stop(): Promise<void>;
	/**
	 * Run a model turn over the saved transcript, answering once it ends.
	 * Ignored while busy; it waits for the saved messages to be listed.
	 */
	retry(): Promise<void>;
	/** Stops following the collection; writes already in flight still land. */
	[Symbol.dispose](): void;
};

/**
 * What a conversation reads and calls on the folder's messages collection
 * (`folder.messages`, of `messagesCollection`): the notes as the folder
 * shows them, its listing state, and `set`. Subscribing starts the
 * folder's listing.
 */
export type ConversationMessages = Pick<
	FolderNotes<MessagesCollection>,
	'items' | 'invalid' | 'loading' | 'subscribe' | 'set'
>;

export type ConversationOptions = {
	/** The folder's messages collection (`folder.messages`, of `messagesCollection`). */
	messages: ConversationMessages;
	/** This conversation's chat: the `{chat}` of each of its message notes. */
	chat: string;
	ai: Pick<Ai, 'chat'>;
	/** The model a turn uses, read when the turn starts; null fails the turn. */
	model: () => ModelChoice | null;
	/** The system prompt, from the saved transcript when the turn starts. */
	system?: string | ((transcript: readonly AgentMessage[]) => string);
	/** The tools the model may call. A tool left out is denied. */
	tools?: readonly AgentTool[];
	/** Asked before a tool that `mutates` runs; without it, such a tool is refused. */
	approve?: Approve;
	/** Change a step's messages before they go out, after the system prompt is set aside. */
	prepare?: (messages: ChatMessage[]) => ChatMessage[];
	generateId?: () => string;
};

const MAX_STEPS = 50;

/** Create one UI-free conversation over a messages collection, a model, and tools. */
export function createConversation({
	messages,
	chat,
	ai,
	model,
	system,
	tools = [],
	approve,
	prepare = (prompt) => prompt,
	generateId = () => crypto.randomUUID(),
}: ConversationOptions): ConversationHandle {
	const listeners = new Set<() => void>();
	const notify = () => {
		for (const listener of [...listeners]) {
			try {
				listener();
			} catch (cause) {
				log.error(new Error('A conversation subscriber failed.', { cause }));
			}
		}
	};

	let isDisposed = false;
	/** Whether the chat's saved messages were ever listed. */
	let listed = false;
	let lastCreatedAt = 0;
	let shownItems: readonly MessageNote[] | null = null;
	let transcript: AgentMessage[] = [];
	let shownInvalid: ReturnType<ConversationMessages['invalid']> | null = null;
	let unreadable: UnreadableMessage[] = [];

	/** The saved transcript as the folder shows it, oldest first; read again only when the folder's items change. */
	function persisted(): AgentMessage[] {
		const items = messages.items();
		if (items === shownItems) return transcript;
		shownItems = items;
		transcript = items
			.filter((note) => note.chat === chat)
			.map(readMessage)
			.sort((a, b) => a.createdAt - b.createdAt);
		return transcript;
	}

	/**
	 * The saved transcript, then the messages handed to the folder and not
	 * yet listed: the folder shows a saved message before its write answers,
	 * so the saved copy wins.
	 */
	function shown(): AgentMessage[] {
		const saved = persisted();
		const stored = new Set(saved.map((message) => message.id));
		const waiting = writing.filter((message) => !stored.has(message.id));
		return waiting.length > 0 ? [...saved, ...waiting] : saved;
	}

	/** This chat's notes that do not read, as the folder shows them. */
	function unreadableNow(): UnreadableMessage[] {
		const invalid = messages.invalid();
		if (invalid === shownInvalid) return unreadable;
		shownInvalid = invalid;
		unreadable = invalid
			.filter((note) => note.chat === chat)
			.map(({ path, issues }) => ({
				path,
				reason: issues.map(({ message }) => message).join(' '),
			}));
		return unreadable;
	}

	const { promise: ready, resolve: settleReady } =
		Promise.withResolvers<void>();

	/** Note the folder's listing: `listed` and `ready` once the first landed. */
	function observe() {
		if (messages.loading()) return;
		listed = true;
		settleReady();
	}

	/** A time after every saved message and every one this conversation stamped. */
	const nextCreatedAt = () => {
		const latest = persisted().at(-1)?.createdAt ?? 0;
		lastCreatedAt = Math.max(Date.now(), lastCreatedAt + 1, latest + 1);
		return lastCreatedAt;
	};

	/** Messages handed to the folder and not yet shown in its listing, oldest first. */
	let writing: AgentMessage[] = [];

	/**
	 * Save `saving` in order, each as its own note, answering once all have
	 * landed: the folder keeps them, in order, while the store is out of
	 * reach. Each shows in `snapshot().messages` from the moment it is handed
	 * over.
	 */
	async function save(saving: AgentMessage[]): Promise<void> {
		if (saving.length === 0) return;
		writing = [...writing, ...saving];
		notify();
		await Promise.all(
			saving.map((message) => {
				// SAFETY: JSON serialization removes unsupported values from the typed message.
				const value = JSON.parse(JSON.stringify(message)) as AgentMessage;
				return messages.set(
					{ chat, id: message.id },
					{
						role: value.role,
						createdAt: value.createdAt,
						// SAFETY: the agent's parts are the collection's parts, as JSON.
						parts: value.parts as MessageNote['parts'],
						body: '',
					},
				);
			}),
		);
		const landed = new Set(saving.map(({ id }) => id));
		writing = writing.filter(({ id }) => !landed.has(id));
		notify();
	}

	const unsubscribe = messages.subscribe(() => {
		if (isDisposed) return;
		observe();
		notify();
	});
	observe();

	let turn: AgentMessage[] | null = null;
	let error: ConversationError | null = null;
	let controller: AbortController | null = null;
	/** The model turn running now, or the last one; settled once it ended. */
	let running: Promise<void> = Promise.resolve();
	let streamingId: string | null = null;
	// One send or retry at a time, reserved before its first await and held
	// through every write and model step it owns.
	let isBusy = false;

	function snapshot(): ConversationSnapshot {
		const saved = shown();
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
			messages: completed.length > 0 ? [...saved, ...completed] : saved,
			streaming,
			isThinking: turn !== null && streaming === null && completed.length === 0,
			isGenerating: turn !== null,
			error,
			unreadable: [...unreadableNow()],
			listed,
		};
	}

	function refusal() {
		if (isDisposed) return 'disposed';
		if (isBusy) return 'busy';
		return null;
	}

	async function runStep(
		chosen: ModelChoice,
		prompt: ChatMessage[],
		assistant: AgentMessage,
		signal: AbortSignal,
	): Promise<Result<AgentToolCall[], ConversationError>> {
		const calls: AgentToolCall[] = [];
		let failure: ConversationError | undefined;
		try {
			for await (const chunk of streamStep(
				{ ai, model: chosen, messages: prompt, tools: toChatTools(tools) },
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
			const outcome = await runTool({ tools, approve, call, signal });
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
			// Wait for the saved messages, which the folder lists again while
			// the store is out of reach; a stop ends the wait.
			await Promise.race([
				ready,
				new Promise((resolve) =>
					signal.addEventListener('abort', resolve, { once: true }),
				),
			]);
			const chosen = model();
			// Until the saved messages were listed, a turn would answer a
			// transcript that may be missing them.
			if (!listed)
				failure = {
					message:
						'The saved messages have not been read yet, so the model was not asked.',
					code: 'Unlisted',
				};
			else if (chosen === null)
				failure = {
					message: 'Choose a model before asking.',
					code: 'NoModel',
				};
			const prompt =
				failure !== undefined
					? undefined
					: typeof system === 'function'
						? system(shown())
						: system;
			while (
				failure === undefined &&
				chosen !== null &&
				listed &&
				!signal.aborted
			) {
				if (count++ >= MAX_STEPS) {
					failure = {
						message: `Stopped after ${MAX_STEPS} steps without a final answer.`,
						code: 'MaxStepsExceeded',
					};
					break;
				}
				const history = [...shown(), ...steps];
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
					chosen,
					[
						...(prompt ? [{ role: 'system' as const, content: prompt }] : []),
						...prepare(toChatMessages(history)),
					],
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
			// A tool or an approval that rejects ends the turn like a failed
			// stream: nothing is saved and the conversation stays usable.
			if (!signal.aborted) failure = { message: extractErrorMessage(cause) };
		}

		turn = null;
		streamingId = null;
		controller = null;
		error = failure ?? null;
		// A fully received answer is handed to the folder, which keeps it, in
		// order after the learner's message, until it lands; one stopped or
		// failed is not saved.
		if (!signal.aborted && failure === undefined)
			void save(steps.filter(isPersistableMessage));
		isBusy = false;
		notify();
	}

	return {
		snapshot,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		ready,
		async send(content) {
			const text = content.trim();
			const reason = text ? refusal() : 'empty';
			if (reason !== null) {
				return ConversationAdmissionError.NotAdmitted({ reason });
			}
			isBusy = true;
			const admitted = new AbortController();
			controller = admitted;
			// Handed to the folder, which keeps it until it lands; the turn
			// reads it from there or from what is handed over.
			void save([
				{
					id: generateId(),
					role: 'user',
					createdAt: nextCreatedAt(),
					parts: [{ type: 'text', text }],
				},
			]);
			running = runTurn(admitted);
			return Ok(undefined);
		},
		async stop() {
			controller?.abort();
			await running;
		},
		async retry() {
			if (refusal() !== null) return;
			isBusy = true;
			controller = new AbortController();
			running = runTurn(controller);
			await running;
		},
		[Symbol.dispose]() {
			if (isDisposed) return;
			isDisposed = true;
			controller?.abort();
			unsubscribe();
			settleReady();
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
