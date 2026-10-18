import { createConversation } from '@epicenter/agent';
import type { InferenceCatalog, InferenceTarget } from '@epicenter/ai/picker';
import type { InferenceSelections } from '@epicenter/ai/selections';
import {
	createOpenAiAgentEngine,
	type OpenAiTurnContext,
} from '@epicenter/client';
import { bindAgentConversation } from '@epicenter/svelte';
import { createSubscriber } from 'svelte/reactivity';
import {
	tutorPrompt,
	type UnreadableFile,
	VOCAB_MODEL,
	VOCAB_SYSTEM_PROMPT,
	type VocabFolder,
} from '../data.js';
import {
	type ChatHistoryError,
	createChatMessageStore,
	type MessageWrite,
} from './messages.js';
import { withTutorOpening } from './opening.js';

/** One active tutor conversation for the lifetime of its keyed view. */
export function createVocabChat({
	folder,
	write,
	chatId,
	focus,
	catalog,
	selections,
}: {
	/** The folder whose `messages/` holds every chat's finished messages. */
	folder: Pick<VocabFolder, 'tables' | 'files'>;
	/** Runs each message's save: in the app, a mutation scoped to this chat, so closing waits for it. */
	write?: MessageWrite;
	chatId: string;
	focus: readonly { text: string }[];
	catalog: InferenceCatalog;
	selections: InferenceSelections;
}) {
	const observeSelections = createSubscriber((update) =>
		selections.onChange(update),
	);
	let runTarget: OpenAiTurnContext | null = null;
	let draft = $state('');
	// The submitted text stays in the draft until its message is saved.
	let submittedDraft: string | null = null;
	let dismissedError = $state<string | null>(null);
	let disposed = false;
	// A tutor request being prepared: reserved when asked, before any await, so
	// a second click finds it. Stop and disposal abort it, and an aborted
	// request never reaches the tutor however late its folder read settles.
	let asking = $state<AbortController | null>(null);
	// The folder could not list this chat's messages, so its transcript is
	// unknown and the tutor is not asked over it.
	let readError = $state<ChatHistoryError | null>(null);
	let isReading = $state(false);
	let hasRead = $state(false);
	let unreadable = $state.raw<UnreadableFile[]>([]);

	const store = createChatMessageStore(folder, chatId, write);
	let reading: Promise<ChatHistoryError | null> | undefined;
	/** Read the transcript from the folder; overlapping callers share one read. */
	function read(): Promise<ChatHistoryError | null> {
		reading ??= (async () => {
			isReading = true;
			const { error } = await store.load();
			reading = undefined;
			isReading = false;
			readError = error;
			if (error === null) {
				hasRead = true;
				unreadable = store.unreadable;
			}
			return error;
		})();
		return reading;
	}

	/**
	 * A message's file receipt arrived. Clear the submitted text, unless the
	 * learner has typed since.
	 */
	function releaseSubmittedDraft() {
		if (draft === submittedDraft) draft = '';
		submittedDraft = null;
	}

	function target(): InferenceTarget | null {
		observeSelections();
		return (
			selections.get('tutor') ??
			(catalog.accountId
				? { connectionId: catalog.accountId, model: VOCAB_MODEL }
				: null)
		);
	}

	function captureTarget(): boolean {
		const resolved = catalog.resolve(target());
		if (!resolved || resolved.source === 'runtime') return false;
		runTarget = {
			client: resolved.client,
			model: resolved.model,
			systemPrompts: [
				focus.length
					? tutorPrompt(focus, loop.messages.length === 0)
					: VOCAB_SYSTEM_PROMPT,
			],
		};
		return true;
	}

	const provider = createOpenAiAgentEngine({
		data: () => {
			if (!runTarget)
				throw new Error(
					'Choose an inference connection before running a turn.',
				);
			return runTarget;
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
	// What is on screen is the folder's transcript, not the empty first render.
	const isReadable = () => hasRead && !isReading && readError === null;
	void read();

	return {
		get messages() {
			return loop.messages;
		},
		get streaming() {
			return loop.streaming;
		},
		/** True from the moment the tutor is asked, so Stop covers the folder read too. */
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
		/** Whole messages the folder has not confirmed as files. */
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
		/** The transcript is being read from the folder. */
		get isReading() {
			return isReading;
		},
		/** Why the transcript could not be read. Set until `readAgain` succeeds. */
		get readError() {
			return readError;
		},
		/** Message files of this chat that are not shown and not sent to the tutor. */
		get unreadable() {
			return unreadable;
		},
		get target() {
			return target();
		},
		get canServe() {
			const resolved = catalog.resolve(target());
			return resolved !== null && resolved.source !== 'runtime';
		},
		/** Whether `retry` would ask the tutor now. A failed read is cleared by `readAgain` first. */
		get canAsk() {
			const resolved = catalog.resolve(target());
			return (
				resolved !== null &&
				resolved.source !== 'runtime' &&
				!isBusy() &&
				isReadable() &&
				!hasNothingToAsk()
			);
		},
		get inputValue() {
			return draft;
		},
		set inputValue(value: string) {
			draft = value;
		},
		get canSend() {
			const resolved = catalog.resolve(target());
			return (
				resolved !== null &&
				resolved.source !== 'runtime' &&
				!isBusy() &&
				isReadable() &&
				loop.messages.length > 0 &&
				draft.trim().length > 0
			);
		},
		selectTarget(next: InferenceTarget) {
			selections.set('tutor', next);
		},
		/**
		 * Save the draft as a learner message, then ask the tutor. A failed save
		 * asks nothing: the draft stays and the message waits in `unsaved`.
		 */
		async sendMessage() {
			const submitted = draft;
			const text = submitted.trim();
			if (
				!text ||
				loop.messages.length === 0 ||
				isBusy() ||
				!isReadable() ||
				!captureTarget()
			)
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
		/** Read the transcript again after a failed read. Never asks the tutor. */
		async readAgain() {
			if (readError === null || isBusy() || disposed) return;
			await read();
		},
		/**
		 * Ask the tutor for the opening, or for the answer to the last learner
		 * message. The transcript is read from the folder first, so the tutor is
		 * asked over what is saved now. A closed or unreadable folder asks
		 * nothing and lands in `readError`.
		 */
		async retry() {
			if (disposed || isBusy() || readError !== null) return;
			const admitted = new AbortController();
			asking = admitted;
			try {
				await catalog.ready;
				if (admitted.signal.aborted) return;
				const error = await read();
				if (admitted.signal.aborted || error !== null) return;
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
