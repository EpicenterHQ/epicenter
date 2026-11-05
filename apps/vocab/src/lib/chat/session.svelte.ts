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
	ai: Pick<Ai, 'models' | 'custom' | 'chat'>;
	/**
	 * The model this device's learner chose for the tutor (`'chat'`), or its
	 * default (`$lib/app.js`), read through `reactive`.
	 */
	choices: ModelChoices<'chat'>;
}) {
	/** The model the next turn uses, captured when it is asked for. */
	let chosen: ModelChoice | null = null;
	let draft = $state('');
	let dismissedError = $state<string | null>(null);
	let disposed = false;
	// A tutor request being prepared: reserved when asked, before any await, so
	// a second click finds it. Stop and disposal abort it before the tutor starts.
	let asking = $state<AbortController | null>(null);

	/** Whether a merged endpoint offers `choice` as a chat model now. */
	function canChat(choice: ModelChoice | null): choice is ModelChoice {
		return (
			choice !== null &&
			ai
				.models()
				.some(
					(model) =>
						model.endpoint === choice.endpoint &&
						model.id === choice.model &&
						model.can.includes('chat'),
				)
		);
	}

	/** The learner's choice, or Epicenter's tutor model when it is offered. */
	function target(): ModelChoice | null {
		return choices.get('chat');
	}

	function captureTarget(): boolean {
		const choice = target();
		if (!canChat(choice)) return false;
		chosen = choice;
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
	const isBusy = () => asking !== null || loop.snapshot().isGenerating;
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
		/** True from the moment the tutor is asked, including model preparation. */
		get isGenerating() {
			return asking !== null || loop.snapshot().isGenerating;
		},
		get isThinking() {
			return asking !== null || loop.snapshot().isThinking;
		},
		get error() {
			return loop.snapshot().error;
		},
		get visibleError() {
			const { error } = loop.snapshot();
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
			return canChat(target());
		},
		/** Whether `retry` would ask the tutor now. */
		get canAsk() {
			return canChat(target()) && !isBusy() && !hasNothingToAsk();
		},
		get inputValue() {
			return draft;
		},
		set inputValue(value: string) {
			draft = value;
		},
		get canSend() {
			return (
				canChat(target()) &&
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
			// The learner's saved model answers its default until read.
			await choices.ready;
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
		async retry() {
			if (disposed || isBusy()) return;
			const admitted = new AbortController();
			asking = admitted;
			try {
				// A connection the learner chose answers once the saved ones are
				// read, and the learner's saved model answers its default until it is read.
				await Promise.all([ai.custom()?.ready, choices.ready]);
				if (admitted.signal.aborted) return;
				if (hasNothingToAsk() || !captureTarget()) return;
				dismissedError = null;
				// Hand the admission to the loop, which reserves its own at once
				// and answers once its turn ends.
				asking = null;
				void loop.retry();
			} finally {
				if (asking === admitted) asking = null;
			}
		},
		stop() {
			asking?.abort();
			asking = null;
			void loop.stop();
		},
		dismissError() {
			dismissedError = loop.snapshot().error?.message ?? null;
		},
		[Symbol.dispose]() {
			if (disposed) return;
			disposed = true;
			asking?.abort();
			loop[Symbol.dispose]();
		},
	};
}
