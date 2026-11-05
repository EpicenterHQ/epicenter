import type { Ai, ModelChoice, ModelChoices } from '@epicenter/ai';
import {
	type ConversationMessages,
	createConversation,
} from '@epicenter/ai/agent';
import { reactive } from '@epicenter/svelte/reactive';
import { tutorPrompt, VOCAB_SYSTEM_PROMPT } from '../data.js';
import { tutorOpening } from './opening.js';

/** One active tutor conversation for the lifetime of its keyed view. */
export function createVocabChat({
	messages,
	chatId,
	focus,
	ai,
	choices,
}: {
	/** Every chat's finished messages (`folder.messages`); this chat's are its own. */
	messages: ConversationMessages;
	chatId: string;
	focus: readonly { text: string }[];
	/** Every model Vocab can reach (`$lib/app.js`), read through `reactive`. */
	ai: Pick<Ai, 'chat'>;
	/**
	 * The model this computer's learner chose for the tutor (`'chat'`), or its
	 * default (`$lib/app.js`), read through `reactive` once the settings
	 * connected.
	 */
	choices: ModelChoices<'chat'>;
}) {
	/** The model the next turn uses, captured when it is asked for. */
	let chosen: ModelChoice | null = null;
	let draft = $state('');
	let dismissedError = $state<string | null>(null);
	let disposed = false;

	/** Why the tutor was not asked: no model chosen, or `models.md` does not read. */
	let refused = $state<{ message: string; code: string } | null>(null);

	/**
	 * The learner's choice, or Epicenter's tutor model by default. The tutor
	 * is asked at the chosen endpoint, which refuses for itself; what an
	 * endpoint discovered never admits a request (ADR-0778).
	 */
	function target(): ModelChoice | null {
		return choices.get('chat');
	}

	/** Capture the model the next turn uses, or say why there is none. */
	function captureTarget(): boolean {
		const choice = choices.require('chat');
		if (choice.error !== null) {
			refused = { message: choice.error.message, code: choice.error.name };
			return false;
		}
		refused = null;
		chosen = choice.data;
		return true;
	}

	const loop = reactive(
		createConversation({
			messages,
			chat: chatId,
			ai,
			model: () => chosen,
			// Focus is model context, not a transcript message; an empty chat opens.
			system: (transcript) =>
				focus.length
					? tutorPrompt(focus, transcript.length === 0)
					: VOCAB_SYSTEM_PROMPT,
			prepare: tutorOpening,
		}),
	);
	const isBusy = () => loop.snapshot().isGenerating;
	/** The tutor is asked only for an opening or for an unanswered learner message. */
	const hasNothingToAsk = () => {
		const { messages } = loop.snapshot();
		return messages.length === 0
			? focus.length === 0
			: messages.at(-1)?.role !== 'user';
	};

	return {
		get messages() {
			return loop.snapshot().messages;
		},
		get streaming() {
			return loop.snapshot().streaming;
		},
		/** True from the moment the tutor is asked. */
		get isGenerating() {
			return loop.snapshot().isGenerating;
		},
		get isThinking() {
			return loop.snapshot().isThinking;
		},
		get error() {
			return loop.snapshot().error ?? refused;
		},
		get visibleError() {
			const error = loop.snapshot().error ?? refused;
			return error && error.message !== dismissedError ? error : null;
		},
		/** Message files of this chat that are not shown and not sent to the tutor. */
		get unreadable() {
			return loop.snapshot().unreadable;
		},
		get target() {
			return target();
		},
		get canServe() {
			return target() !== null;
		},
		/** Whether `retry` would ask the tutor now. */
		get canAsk() {
			return target() !== null && !isBusy() && !hasNothingToAsk();
		},
		get inputValue() {
			return draft;
		},
		set inputValue(value: string) {
			draft = value;
		},
		get canSend() {
			return (
				target() !== null &&
				!isBusy() &&
				loop.snapshot().messages.length > 0 &&
				draft.trim().length > 0
			);
		},
		selectTarget(next: ModelChoice) {
			return choices.set('chat', next);
		},
		/**
		 * Hand the draft to the folder as a learner message, then ask the
		 * tutor. The draft clears once the conversation takes it, unless the
		 * learner has typed since; one it does not take stays.
		 */
		async sendMessage() {
			const submitted = draft;
			const text = submitted.trim();
			if (!text) return;
			if (loop.snapshot().messages.length === 0 || isBusy() || !captureTarget())
				return;
			const { error } = await loop.send(text);
			if (error !== null) return;
			dismissedError = null;
			if (draft === submitted) draft = '';
		},
		/**
		 * Ask the tutor for the opening, or for the answer to the last learner
		 * message, over the transcript as the folder holds it, asking only
		 * what is unasked.
		 */
		retry() {
			if (disposed || isBusy() || hasNothingToAsk() || !captureTarget())
				return;
			dismissedError = null;
			// The loop reserves its turn at once; the answer streams in the background.
			void loop.retry();
		},
		stop() {
			void loop.stop();
		},
		dismissError() {
			dismissedError = (loop.snapshot().error ?? refused)?.message ?? null;
		},
		[Symbol.dispose]() {
			if (disposed) return;
			disposed = true;
			loop[Symbol.dispose]();
		},
	};
}
