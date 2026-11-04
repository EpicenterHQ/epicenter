import type { ModelChoice, ModelChoices } from '@epicenter/ai';
import {
	type ChatTurn,
	createChatEngine,
	createConversation,
} from '@epicenter/ai/agent';
import type { ReactiveAi } from '@epicenter/ai/svelte';
import { bindAgentConversation } from '@epicenter/svelte';
import { createTracker } from '@epicenter/svelte/tracked';
import { tutorPrompt, VOCAB_SYSTEM_PROMPT } from '../data.js';
import { createChatMessageStore, type MessageList } from './messages.svelte.js';
import { withTutorOpening } from './opening.js';

/** One active tutor conversation for the lifetime of its keyed view. */
export function createVocabChat({
	messages,
	chatId,
	focus,
	ai,
	choices,
}: {
	/** Every chat's finished messages; this chat's are its own. */
	messages: MessageList;
	chatId: string;
	focus: readonly { text: string }[];
	/** Every model Vocab can reach (`$lib/ai.js`). */
	ai: Pick<ReactiveAi, 'models' | 'custom' | 'chat'>;
	/** The model this device's learner chose for the tutor (`'chat'`), or its default. */
	choices: ModelChoices<'chat'>;
}) {
	const observeChoices = createTracker(choices.subscribe);
	let runTurn: ChatTurn | null = null;
	let draft = $state('');
	// The submitted text stays in the draft until its message is saved.
	let submittedDraft: string | null = null;
	let dismissedError = $state<string | null>(null);
	let disposed = false;
	// A tutor request being prepared: reserved when asked, before any await, so
	// a second click finds it. Stop and disposal abort it before the tutor starts.
	let asking = $state<AbortController | null>(null);
	const store = createChatMessageStore(messages, chatId);

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
			ai.models.some(
				(model) =>
					model.endpoint === choice.endpoint &&
					model.id === choice.model &&
					model.can.includes('chat'),
			)
		);
	}

	/** The learner's choice, or Epicenter's tutor model when it is offered. */
	function target(): ModelChoice | null {
		observeChoices();
		return choices.get('chat');
	}

	function captureTarget(): boolean {
		const choice = target();
		if (!canChat(choice)) return false;
		runTurn = {
			ai,
			endpoint: choice.endpoint,
			model: choice.model,
			systemPrompts: [
				focus.length
					? tutorPrompt(focus, loop.messages.length === 0)
					: VOCAB_SYSTEM_PROMPT,
			],
		};
		return true;
	}

	const provider = createChatEngine({
		turn: () => {
			if (!runTurn) throw new Error('Choose a model before running a turn.');
			return runTurn;
		},
	});
	const loop = bindAgentConversation(
		createConversation({
			store,
			engine: withTutorOpening(provider),
			generateId: () => crypto.randomUUID(),
		}),
	);
	// Saving and unsaved messages hold the conversation as a live turn does.
	const isBusy = () =>
		asking !== null ||
		loop.isGenerating ||
		loop.isSaving ||
		loop.unsaved.length > 0;
	/** The tutor is asked only for an opening or for an unanswered learner message. */
	const hasNothingToAsk = () =>
		loop.messages.length === 0
			? focus.length === 0
			: loop.messages.at(-1)?.role !== 'user';

	return {
		get messages() {
			return loop.messages;
		},
		get streaming() {
			return loop.streaming;
		},
		/** True from the moment the tutor is asked, including model preparation. */
		get isGenerating() {
			return asking !== null || loop.isGenerating;
		},
		get isThinking() {
			return asking !== null || loop.isThinking;
		},
		get error() {
			return loop.error;
		},
		get visibleError() {
			return loop.error && loop.error.message !== dismissedError
				? loop.error
				: null;
		},
		/** Whole messages not yet confirmed as notes. */
		get unsaved() {
			return loop.unsaved;
		},
		get isSaving() {
			return loop.isSaving;
		},
		/**
		 * Why a message in `unsaved` has no file. Set until `saveAgain` succeeds.
		 * Never a tutor failure; those are `error`.
		 */
		get saveError() {
			return loop.saveError;
		},
		/** Message files of this chat that are not shown and not sent to the tutor. */
		get unreadable() {
			return store.unreadable;
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
				loop.messages.length > 0 &&
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
			if (!text || loop.messages.length === 0 || isBusy() || !captureTarget())
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
			if (loop.unsaved.length === 0) return;
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
				// A connection the learner chose answers once the saved ones are read.
				await ai.custom?.ready;
				if (admitted.signal.aborted) return;
				if (hasNothingToAsk() || !captureTarget()) return;
				dismissedError = null;
				// Hand the admission to the loop, which reserves its own at once.
				asking = null;
				loop.retry();
			} finally {
				if (asking === admitted) asking = null;
			}
		},
		stop() {
			asking?.abort();
			asking = null;
			loop.stop();
		},
		dismissError() {
			dismissedError = loop.error?.message ?? null;
		},
		[Symbol.dispose]() {
			if (disposed) return;
			disposed = true;
			asking?.abort();
			loop[Symbol.dispose]();
		},
	};
}
