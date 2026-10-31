<!--
	The global shortcut (`src-tauri/src/shortcut.rs`): a press starts a
	recording, or stops the one under way, from any app, exactly as the
	record button does.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { onShortcut } from '$lib/platform/shell.tauri.js';
	import { getWhispering } from '$lib/whispering.svelte.js';

	const whispering = getWhispering();

	onMount(() =>
		onShortcut(() => {
			if (whispering.recorder.phase === 'idle') void whispering.startRecording();
			else if (whispering.recorder.phase === 'recording') void whispering.stopRecording();
		}),
	);
</script>
