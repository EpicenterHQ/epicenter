<script lang="ts">
	import { recordingMicLevel } from '$lib/recording-overlay/mic-level.browser.svelte.js';
	import RecordingPill from '$lib/recording-pill/RecordingPill.svelte';
	import { dispatchPillAction } from '$lib/recording-pill/pill-actions.js';
	import { projectLifecycleToStatus } from '$lib/recording-pill/projection.js';
	import { dictationLifecycle } from '$lib/state/dictation-lifecycle.svelte.js';
	import { getWhisperingApp } from '$lib/whispering/context.js';

	const app = getWhisperingApp();
	const status = $derived(projectLifecycleToStatus(dictationLifecycle.current(app.recording)));
</script>

{#if status}
	<div class="fixed bottom-4 left-1/2 z-50 -translate-x-1/2">
		<RecordingPill
			{status}
			level={recordingMicLevel.current}
			onStop={() => dispatchPillAction(app, 'stop')}
			onCancel={() => dispatchPillAction(app, 'cancel')}
			onShipRaw={() => dispatchPillAction(app, 'ship-raw')}
		/>
	</div>
{/if}
