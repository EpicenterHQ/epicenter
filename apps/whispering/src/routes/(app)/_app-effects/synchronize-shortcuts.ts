import { onMount } from 'svelte';
import { tauri } from '#platform/tauri';
import { createAppShortcuts } from '$lib/shortcuts';
import type { WhisperingApp } from '$lib/whispering/app';

/**
 * Register the current shortcut bindings on every backend this build runs.
 * `shortcuts.sync()` is the reach router's sync, so it pushes both halves: the
 * focused bindings into the in-app keydown matcher (on every platform, which is
 * what makes in-app shortcuts work on desktop) and, on desktop, the global
 * bindings onto the plugin chords, whose own callbacks dispatch into the command
 * layer. On web the router has no system backend, so only the focused matcher is
 * pushed. Each backend reports its own sync failure, so the promise is
 * fire-and-forget here. Unmount unregisters the desktop plugin chords. The
 * in-app keydown listener is owned by `listenForLocalShortcuts`.
 */
export function synchronizeShortcuts(app: WhisperingApp): void {
	onMount(() => {
		void createAppShortcuts(app).sync();
		return () => {
			void tauri?.keyboard.unregisterChords();
		};
	});
}
