<!--
	`#platform/recovery` in the desktop window: the shared recovery screen
	over the root that did not open. Every fix ends in a reload, which opens
	the roots again as a new page.
-->
<script lang="ts">
	import Recovery from '@epicenter/svelte/recovery';
	import type { StartupFailure } from '../app.tauri.js';

	let { failure }: { failure: StartupFailure } = $props();
</script>

<Recovery app="Todos" error={failure.error} appData={failure.appData} retry={() => location.reload()} />
