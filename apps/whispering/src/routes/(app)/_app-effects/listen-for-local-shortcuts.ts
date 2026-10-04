import { onMount } from 'svelte';
import { dispatchCommandTrigger } from '$lib/commands';
import { services } from '$lib/services';
import type { WhisperingApplication as WhisperingApp } from '$lib/whispering/application';

/**
 * Subscribe the in-app keydown matcher to the command layer for the app's
 * lifetime. The bindings it matches are pushed by `synchronizeShortcuts`.
 */
export function listenForLocalShortcuts(app: WhisperingApp): void {
	onMount(() => {
		const unlisten = services.localShortcutManager.listen((commandId, state) =>
			dispatchCommandTrigger(app, commandId, state),
		);
		return () => unlisten();
	});
}
