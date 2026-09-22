<script lang="ts">
	import { getWhisperingApp } from '../whispering/context.js';
	import PersonalProvider from './PersonalProvider.svelte';
	import SaveToPersonalButton from './SaveToPersonalButton.svelte';
	const app = getWhisperingApp();
	let { recordingId }: { recordingId: string } = $props();
</script>

{#await app.personalReady then personal}
	{#if personal}<PersonalProvider {personal}
			><SaveToPersonalButton {recordingId} /></PersonalProvider
		>{/if}
{:catch}
	<!-- Local history remains available when Personal cannot open. -->
{/await}
