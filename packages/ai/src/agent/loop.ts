/**
 * One conversation with a model over a contract's messages collection
 * (ADR-0047): it reads the chat's finished messages from the folder's
 * collection, streams each turn from the chosen model through `ai.chat`,
 * runs the tools the host offers, and saves each finished message as its
 * own note. The folder lists and follows the collection while the
 * conversation listens; the conversation keeps no copy of its own.
 */
import { sameValue } from '@epicenter/definition/note';
import type { FolderNotes } from '@epicenter/folder/core';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { JsonValue } from 'wellcrafted/json';
import { createLogger } from 'wellcrafted/logger';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
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

/** Why a message is still unsaved after the collection was asked to write it. */
export const MessageSaveError = defineErrors({
	/** The collection answered: the message is not saved. */
	WriteFailed: ({ cause }: { cause: unknown }) => ({
		message: `The message was not saved: ${extractErrorMessage(cause)}`,
		cause,
	}),
	/** The collection threw instead of answering, so whether the write landed is unknown. */
	Threw: ({ cause }: { cause: unknown }) => ({
		message: `The message collection threw instead of answering: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type MessageSaveError = InferErrors<typeof MessageSaveError>;

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

/** A message note of this chat that does not read: not shown, and not sent to the model. */
export type UnreadableMessage = { path: string; reason: string };

export type ConversationSnapshot = {
	/** The saved transcript, then `unsaved`, then the live turn's finished steps. */
	messages: AgentMessage[];
	streaming: AgentMessage | null;
	isThinking: boolean;
	isGenerating: boolean;
	/** Why the last model turn ended without an answer. Never a save failure. */
	error: ConversationError | null;
	/**
	 * Whole messages the collection has not confirmed, oldest first: a sent
	 * learner message, or a fully received answer. Each also appears once in
	 * `messages`.
	 */
	unsaved: AgentMessage[];
	/** A write for `unsaved` is in flight. */
	isSaving: boolean;
	/**
	 * Why the last write left `unsaved` unconfirmed. Stays while `save()` tries
	 * again and clears when everything is saved.
	 */
	saveError: MessageSaveError | null;
	/** This chat's message notes that do not read. */
	unreadable: UnreadableMessage[];
	/**
	 * Whether the chat's saved messages were ever listed. Until then the
	 * transcript may be missing what is saved, so no model turn runs: it
	 * ends with the error code `Unlisted`. A listing that fails after one
	 * succeeded keeps this true.
	 */
	listed: boolean;
};

export type ConversationHandle = {
	snapshot(): ConversationSnapshot;
	subscribe(listener: () => void): () => void;
	/**
	 * Settles once the first listing of the chat's saved messages answered,
	 * listed or failed (`listed` says which), or once the conversation is
	 * disposed.
	 */
	readonly ready: Promise<void>;
	/**
	 * Save one learner message, then start the model turn in the background.
	 *
	 * Resolves when the collection has answered. `Ok` means the message is
	 * saved; the turn has started unless `stop` or disposal arrived first. On
	 * `Err` no model ran. A failed write keeps the message in `unsaved` under
	 * its id.
	 */
	send(
		content: string,
	): Promise<Result<void, ConversationAdmissionError | MessageSaveError>>;
	/** Abort the model turn, or cancel the one a pending `send` would start; answers once no turn runs. */
	stop(): Promise<void>;
	/**
	 * Run a model turn over the saved transcript, answering once it ends.
	 * Ignored while busy or unsaved; ends as `Unlisted` until the saved
	 * messages were listed.
	 */
	retry(): Promise<void>;
	/**
	 * Write `unsaved` again under the same ids. Never runs the model or a tool,
	 * and never writes a message the collection already confirmed.
	 */
	save(): Promise<Result<void, ConversationAdmissionError | MessageSaveError>>;
	/** Stops following the collection; writes already in flight still land. */
	[Symbol.dispose](): void;
};

/**
 * What a conversation reads and calls on the folder's messages collection
 * (`folder.messages`, of `messagesCollection`): the notes as the folder
 * shows them, its listing state, and `create`. Subscribing starts the
 * folder's listing; a create the folder refuses as `Occupied` answers once
 * `get` shows what is there.
 */
export type ConversationMessages = Pick<
	FolderNotes<MessagesCollection>,
	'items' | 'invalid' | 'get' | 'loading' | 'error' | 'subscribe' | 'create'
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

/** Whether `note` holds `message`, whole. */
const holds = (note: MessageNote, message: AgentMessage) =>
	note.role === message.role &&
	note.createdAt === message.createdAt &&
	sameValue(note.parts, message.parts);

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

	/** Note the folder's listing: `ready` once the first answered, `listed` once one succeeded. */
	function observe() {
		if (messages.loading()) return;
		settleReady();
		if (messages.error() === null) listed = true;
	}

	/** A time after every saved message and every one this conversation stamped. */
	const nextCreatedAt = () => {
		const latest = persisted().at(-1)?.createdAt ?? 0;
		lastCreatedAt = Math.max(Date.now(), lastCreatedAt + 1, latest + 1);
		return lastCreatedAt;
	};

	/** Save `message` as its own note; a note already there holding it counts as saved. */
	async function write(
		message: AgentMessage,
	): Promise<Result<void, MessageSaveError>> {
		// SAFETY: JSON serialization removes unsupported values from the typed message.
		const value = JSON.parse(JSON.stringify(message)) as AgentMessage;
		const created = await messages.create({
			chat,
			id: message.id,
			role: value.role,
			createdAt: value.createdAt,
			// SAFETY: the agent's parts are the collection's parts, as JSON.
			parts: value.parts as MessageNote['parts'],
			body: '',
		});
		if (created.error === null) return Ok(undefined);
		if (created.error.name !== 'Occupied')
			return MessageSaveError.WriteFailed({ cause: created.error });
		// The folder answers `Occupied` once it shows the note that is there.
		const there = messages.get({ chat, id: message.id });
		if (there !== undefined && holds(there, value)) return Ok(undefined);
		return MessageSaveError.WriteFailed({
			cause: `Another message is already saved at '${created.error.path}'.`,
		});
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
	let unsaved: AgentMessage[] = [];
	let saveError: MessageSaveError | null = null;
	let isSaving = false;
	// One send, retry, or save at a time, reserved before its first await and
	// held through every write and model step it owns.
	let isBusy = false;

	function snapshot(): ConversationSnapshot {
		const saved = persisted();
		const turnMessages = turn ?? [];
		const filling = turnMessages.find((message) => message.id === streamingId);
		const streaming =
			filling && isPersistableMessage(filling)
				? { ...filling, parts: [...filling.parts] }
				: null;
		const completed = turnMessages.filter(
			(message) => message.id !== streamingId && isPersistableMessage(message),
		);
		// The folder shows a saved message before its create answers, so a
		// message is in both lists for a moment; the saved copy is rendered.
		const stored = new Set(saved.map((message) => message.id));
		const retained = unsaved.filter((message) => !stored.has(message.id));
		return {
			messages:
				retained.length > 0 || completed.length > 0
					? [...saved, ...retained, ...completed]
					: saved,
			streaming,
			isThinking: turn !== null && streaming === null && completed.length === 0,
			isGenerating: turn !== null,
			error,
			unsaved: [...unsaved],
			isSaving,
			saveError,
			unreadable: [...unreadableNow()],
			listed,
		};
	}

	/**
	 * Write `unsaved` in order and stop at the first message the collection
	 * does not confirm, so a later message is never saved ahead of an earlier
	 * one. One attempt per message: a failed or thrown write may still have
	 * landed, and only an explicit `save()` asks again.
	 */
	async function saveUnsaved(): Promise<Result<void, MessageSaveError>> {
		isSaving = true;
		notify();
		let failure: MessageSaveError | null = null;
		for (const message of [...unsaved]) {
			const { data: saved, error: writeError } = await tryAsync({
				try: () => write(message),
				catch: (cause) => MessageSaveError.Threw({ cause }),
			});
			failure = writeError !== null ? writeError : saved.error;
			if (failure !== null) break;
			// The folder shows a saved message before its create answers.
			unsaved = unsaved.filter((pending) => pending.id !== message.id);
			notify();
		}
		isSaving = false;
		saveError = failure;
		return failure === null ? Ok(undefined) : Err(failure);
	}

	function refusal() {
		if (isDisposed) return 'disposed';
		if (isBusy) return 'busy';
		if (unsaved.length > 0) return 'unsaved';
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
			await ready;
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
						? system(persisted())
						: system;
			while (failure === undefined && chosen !== null && !signal.aborted) {
				if (count++ >= MAX_STEPS) {
					failure = {
						message: `Stopped after ${MAX_STEPS} steps without a final answer.`,
						code: 'MaxStepsExceeded',
					};
					break;
				}
				const history = [...persisted(), ...steps];
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
			// A learner message comes after every message already saved.
			await ready;
			unsaved = [
				{
					id: generateId(),
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
			running = runTurn(admitted);
			return saved;
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
