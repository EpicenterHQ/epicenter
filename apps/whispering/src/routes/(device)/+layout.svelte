<!--
	"On this device": Whispering over this browser's files, signed in or not,
	online or not (decision 76). Signed in, the uploader moves each recording
	and note to the repository, where the "Synced" pages show it.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import WhisperingView from '../components/WhisperingView.svelte';

	let { children }: { children: Snippet } = $props();
</script>

<WhisperingView view="device">{@render children()}</WhisperingView>
