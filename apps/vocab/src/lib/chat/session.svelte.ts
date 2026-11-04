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
	// The submitted text stays in the draft until its message is saved.
	let submittedDraft: string | null = null;
	let dismissedError = $state<string | null>(null);
	let disposed = false;
	// A tutor request being prepared: reserved when asked, before any await, so
	// a second click finds it. Stop and disposal abort it before the tutor starts.
	let asking = $state<AbortController | null>(null);

	/**
	 * A message's file receipt arrived. Clear the submitted text, unless the
	 * learner has typed since.
	 */
	function releaseSubmittedDraft() {
		if (draft === submittedDraft) draft = '';
		submittedDraft = null;
	}

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
	// Saving and unsaved messages hold the conversation as a live turn does.
	const isBusy = () => {
		const { isGenerating, isSaving, unsaved } = loop.snapshot();
		return asking !== null || isGenerating || isSaving || unsaved.length > 0;
	};
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
		/** Whole messages not yet confirmed as notes. */
		get unsaved() {
			return loop.snapshot().unsaved;
		},
		get isSaving() {
			return loop.snapshot().isSaving;
		},
		/**
		 * Why a message in `unsaved` has no file. Set until `saveAgain` succeeds.
		 * Never a tutor failure; those are `error`.
		 */
		get saveError() {
			return loop.snapshot().saveError;
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
		 * Save the draft as a learner message, then ask the tutor. A failed save
		 * asks nothing: the draft stays and the message waits in `unsaved`.
		 */
		async sendMessage() {
			const submitted = draft;
			const text = submitted.trim();
			if (!text) return;
			// A reply needs the chat's saved messages, which list once it opens.
			await loop.ready;
			if (loop.snapshot().messages.length === 0 || isBusy() || !captureTarget())
				return;
			const { error } = await loop.send(text);
			if (error?.name === 'NotAdmitted') return;
			submittedDraft = submitted;
			dismissedError = null;
			if (error === null) releaseSubmittedDraft();
		},
		/**
		 * Save the messages in `unsaved` again, under the same files. Never asks
		 * the tutor; that stays the learner's separate step.
		 */
		async saveAgain() {
			if (loop.snapshot().unsaved.length === 0) return;
			const { error } = await loop.save();
			if (error === null) releaseSubmittedDraft();
		},
		/**
		 * Ask the tutor for the opening, or for the answer to the last learner
		 * message. The loop reads the mirror's current transcript.
		 */
		async retry() {
			if (disposed || isBusy()) return;
			const admitted = new AbortController();
			asking = admitted;
			try {
				// A connection the learner chose answers once the saved ones are
				// read, and what to ask depends on the chat's saved messages.
				await Promise.all([ai.custom()?.ready, loop.ready]);
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
