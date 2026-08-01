/**
 * The one conversation engine. Every surface runs this; none of them extends it.
 *
 * The proof obligation of the whole prototype lives in this file's imports: it
 * imports `SessionSeed` and nothing else from the session layer. There is no
 * `intent` branch below, no per-surface hook, and no place to add one without
 * the omission being obvious. A surface changes what the engine is *given*, not
 * what the engine *does*.
 *
 * Persistence follows ADR-0046/0047: the live turn streams into memory and only
 * finished messages are written, whole, into the store. A stopped or failed turn
 * persists nothing, which is safe because re-asking costs nothing. The store
 * only ever holds clean text, so the derived views in `render.ts` never leak
 * into it.
 */

import type { SessionSeed } from './session.ts';

export type MessageRole = 'user' | 'tutor';

/** One finished message. Clean text only: no pinyin, no highlight markup. */
export type Message = {
	id: string;
	role: MessageRole;
	text: string;
	createdAt: number;
};

/**
 * The durable message store. Deliberately tiny: a real implementation is the
 * conversation's per-id last-write-wins document, but no CRDT type crosses this
 * seam, so the engine is testable with an array.
 */
export type MessageStore = {
	append(message: Message): void;
	all(): Message[];
};

/** The inference port: clean text in, text deltas out. One call, no tools. */
export type TutorModel = (request: {
	systemPrompt: string;
	messages: Message[];
}) => AsyncIterable<string>;

export type SessionSnapshot = {
	intent: SessionSeed['intent'];
	focus: SessionSeed['focus'];
	/** Everything durable, oldest first. */
	messages: Message[];
	/** The turn currently filling, held in memory only. */
	streaming: Message | null;
	isGenerating: boolean;
	error: string | null;
};

export type TutorSession = {
	snapshot(): SessionSnapshot;
	subscribe(listener: () => void): () => void;
	/** Send the seeded opening, if the surface has one. A no-op for chat. */
	start(): Promise<void>;
	send(text: string): Promise<void>;
};

export type TutorSessionOptions = {
	seed: SessionSeed;
	model: TutorModel;
	store: MessageStore;
	generateId: () => string;
	now: () => number;
};

export function createTutorSession({
	seed,
	model,
	store,
	generateId,
	now,
}: TutorSessionOptions): TutorSession {
	const listeners = new Set<() => void>();
	const notify = () => {
		for (const listener of listeners) listener();
	};

	let streaming: Message | null = null;
	let isGenerating = false;
	let error: string | null = null;

	async function send(text: string): Promise<void> {
		if (isGenerating) return;
		const trimmed = text.trim();
		if (trimmed.length === 0) return;

		// The user turn is durable the moment it is sent: it is the thing worth
		// keeping even if the answer never arrives.
		store.append({
			id: generateId(),
			role: 'user',
			text: trimmed,
			createdAt: now(),
		});
		isGenerating = true;
		error = null;
		streaming = null;
		notify();

		let answer = '';
		try {
			// The system prompt is re-sent from the seed every turn and never
			// persisted, which is what keeps the focus phrases out of the
			// transcript for the life of the session.
			for await (const delta of model({
				systemPrompt: seed.systemPrompt,
				messages: store.all(),
			})) {
				answer += delta;
				streaming = {
					id: 'streaming',
					role: 'tutor',
					text: answer,
					createdAt: now(),
				};
				notify();
			}
		} catch (cause) {
			// A failed turn persists nothing. The durable user turn is re-asked.
			error = cause instanceof Error ? cause.message : String(cause);
			streaming = null;
			isGenerating = false;
			notify();
			return;
		}

		if (answer.length > 0) {
			store.append({
				id: generateId(),
				role: 'tutor',
				text: answer,
				createdAt: now(),
			});
		}
		streaming = null;
		isGenerating = false;
		notify();
	}

	return {
		snapshot: () => ({
			intent: seed.intent,
			focus: seed.focus,
			messages: store.all(),
			streaming,
			isGenerating,
			error,
		}),
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		start: async () => {
			if (seed.opening !== null) await send(seed.opening);
		},
		send,
	};
}

/** An in-memory store, sorted oldest first the way a keyed document would be. */
export function createMemoryStore(initial: Message[] = []): MessageStore {
	const messages = [...initial];
	return {
		append(message) {
			messages.push(message);
		},
		all: () => [...messages].sort((a, b) => a.createdAt - b.createdAt),
	};
}
