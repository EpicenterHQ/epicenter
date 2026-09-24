import { createConversation } from '@epicenter/agent';
import type {
	InferenceCatalog,
	InferenceTarget,
} from '@epicenter/app-shell/inference-picker';
import type { InferenceSelections } from '@epicenter/app-shell/inference-selections';
import {
	createOpenAiAgentEngine,
	type OpenAiTurnContext,
} from '@epicenter/client';
import { bindAgentConversation } from '@epicenter/svelte';
import { createSubscriber } from 'svelte/reactivity';
import type { ChatHistoryData } from '$lib/data.js';
import { VOCAB_MODEL, VOCAB_SYSTEM_PROMPT } from '$lib/data.js';
import { createChatMessageStore } from './messages.js';

/** One active tutor conversation for the lifetime of its keyed view. */
export function createVocabChat({
	messages,
	accountKey,
	conversationId,
	catalog,
	selections,
}: {
	messages: ChatHistoryData['tables']['messages'];
	accountKey: string;
	conversationId: string;
	catalog: InferenceCatalog;
	selections: InferenceSelections;
}) {
	const observeSelections = createSubscriber((update) =>
		selections.onChange(update),
	);
	let runTarget: OpenAiTurnContext | null = null;
	let draft = $state('');
	let dismissedError = $state<string | null>(null);
	let disposed = false;

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
			systemPrompts: [VOCAB_SYSTEM_PROMPT],
		};
		return true;
	}

	const loop = bindAgentConversation(
		createConversation({
			store: createChatMessageStore(messages, accountKey, conversationId),
			engine: createOpenAiAgentEngine({
				data: () => {
					if (!runTarget)
						throw new Error(
							'Choose an inference connection before running a turn.',
						);
					return runTarget;
				},
			}),
			generateId: () => crypto.randomUUID(),
		}),
	);

	return {
		get messages() {
			return loop.messages;
		},
		get streaming() {
			return loop.streaming;
		},
		get isGenerating() {
			return loop.isGenerating;
		},
		get isThinking() {
			return loop.isThinking;
		},
		get error() {
			return loop.error;
		},
		get visibleError() {
			return loop.error && loop.error.message !== dismissedError
				? loop.error
				: null;
		},
		get target() {
			return target();
		},
		get canServe() {
			const resolved = catalog.resolve(target());
			return resolved !== null && resolved.source !== 'runtime';
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
				!loop.isGenerating &&
				draft.trim().length > 0
			);
		},
		selectTarget(next: InferenceTarget) {
			selections.set('tutor', next);
		},
		sendMessage() {
			const text = draft.trim();
			if (!text || loop.isGenerating || !captureTarget()) return;
			if (!loop.send(text)) return;
			draft = '';
			dismissedError = null;
		},
		retry() {
			if (
				loop.isGenerating ||
				loop.messages.at(-1)?.role !== 'user' ||
				!captureTarget()
			)
				return;
			dismissedError = null;
			loop.retry();
		},
		stop() {
			loop.stop();
		},
		dismissError() {
			dismissedError = loop.error?.message ?? null;
		},
		[Symbol.dispose]() {
			if (disposed) return;
			disposed = true;
			loop[Symbol.dispose]();
		},
	};
}
