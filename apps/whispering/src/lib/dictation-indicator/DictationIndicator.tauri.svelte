<script lang="ts" module>
	import { defineErrors } from 'wellcrafted/error';

	/**
	 * Overlay wiring is decoration around a capture that is already running, so
	 * every failure here is logged and swallowed rather than surfaced.
	 */
	const DictationIndicatorError = defineErrors({
		OverlayWiringFailed: ({ cause }: { cause: unknown }) => ({
			message: 'Failed to wire the dictation overlay',
			cause,
		}),
	});
</script>

<script lang="ts">
	import type { UnlistenFn } from '@tauri-apps/api/event';
	import { createLogger } from 'wellcrafted/logger';
	import { onDestroy, onMount } from 'svelte';
	import {
		recordingOverlayAction,
		revealMainWindow,
	} from '$lib/recording-overlay/events';
	import { synchronizeRecordingOverlayWindow } from '$lib/recording-overlay/window-manager.tauri';
	import { dispatchPillAction } from '$lib/recording-pill/pill-actions';
	import { projectLifecycleToStatus } from '$lib/recording-pill/projection';
	import { dictationLifecycle } from '$lib/state/dictation-lifecycle.svelte';
	import { tauriOnly } from '$lib/tauri.tauri';
	import { getWhisperingApp } from '$lib/whispering/context';

	const app = getWhisperingApp();

	const log = createLogger('whispering/dictation-indicator');
	const status = $derived(projectLifecycleToStatus(dictationLifecycle.current(app.recording)));

	const warn = (cause: unknown) =>
		log.warn(DictationIndicatorError.OverlayWiringFailed({ cause }));

	$effect(() => {
		synchronizeRecordingOverlayWindow(status);
	});

	// The native window outlives this component, so hide it when the session-root
	// owner is destroyed rather than leaving stale status with detached controls.
	onDestroy(() => synchronizeRecordingOverlayWindow(null));

	// The event subscriptions resolve asynchronously, so unmount can land before
	// a listener settles. A late listener is immediately detached instead of leaked.
	onMount(() => {
		const unlisteners: UnlistenFn[] = [];
		let isDestroyed = false;
		const trackUnlistener = (unlisten: UnlistenFn) => {
			if (isDestroyed) unlisten();
			else unlisteners.push(unlisten);
		};

		void recordingOverlayAction
			.listen((event) => dispatchPillAction(app, event.payload))
			.then(trackUnlistener)
			.catch(warn);
		void revealMainWindow
			.listen(() => {
				void tauriOnly.mainWindow.reveal().catch(warn);
			})
			.then(trackUnlistener)
			.catch(warn);

		return () => {
			isDestroyed = true;
			for (const unlisten of unlisteners) unlisten();
		};
	});
</script>
