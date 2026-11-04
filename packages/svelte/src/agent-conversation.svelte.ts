/**
 * Bind a client agent loop (ADR-0047) to Svelte reactive state.
 *
 * The loop core (`@epicenter/ai/agent`) is framework-agnostic: it exposes
 * a {@link ConversationSnapshot} plus a change subscription. This mirrors each
 * change into a `$state` version counter so a component re-reads the snapshot.
 * The returned object is the controller a chat view drives.
 */
import type {
	ConversationHandle,
	ConversationSnapshot,
} from '@epicenter/ai/agent';

export type BoundAgentConversation = ReturnType<typeof bindAgentConversation>;

export function bindAgentConversation(handle: ConversationHandle) {
	let version = $state(0);
	const unsubscribe = handle.subscribe(() => {
		version += 1;
	});
	const render = $derived.by((): ConversationSnapshot => {
		void version;
		return handle.snapshot();
	});

	return {
		get messages() {
			return render.messages;
		},
		get streaming() {
			return render.streaming;
		},
		get isThinking() {
			return render.isThinking;
		},
		get isGenerating() {
			return render.isGenerating;
		},
		get error() {
			return render.error;
		},
		get unsaved() {
			return render.unsaved;
		},
		get isSaving() {
			return render.isSaving;
		},
		get saveError() {
			return render.saveError;
		},
		send: (content: string) => handle.send(content),
		stop: () => handle.stop(),
		retry: () => handle.retry(),
		save: () => handle.save(),
		[Symbol.dispose]() {
			unsubscribe();
			handle[Symbol.dispose]();
		},
	};
}
