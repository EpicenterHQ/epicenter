import { connectionLabel } from '@epicenter/app-shell/inference-picker';
import { createSubscriber } from 'svelte/reactivity';
import { getApp, getSelections } from '../application.js';
import { resolveCompletionState as resolveProductCompletion } from '../operations/completion.js';

// Subscriptions start only when a mounted reactive consumer reads the state.
const observe = createSubscriber((update) => {
	const stopSettings = getApp().kv.subscribe(update);
	const stopSelections = getSelections().onChange(update);
	const stopConnections = getApp().ai.connections?.subscribe(() => update());
	return () => {
		stopSettings();
		stopSelections();
		stopConnections?.();
	};
});

/** Svelte tracks changes; the product resolver decides whether execution can run. */
export function resolveCompletionState() {
	observe();
	const state = resolveProductCompletion();
	return {
		...state,
		destination: state.transport
			? state.transport === getApp().ai.account?.client
				? new URL(state.transport.baseURL).host
				: connectionLabel(state.transport.baseURL)
			: undefined,
	};
}
