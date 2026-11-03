<script lang="ts">
	import { defineContract } from '@epicenter/definition/contract';
	import DesktopStartup from '../desktop-startup.svelte';

	const contract = defineContract({
		collections: {
			notes: { path: 'notes/{id}.md', fields: { title: { type: 'string' } } },
		},
	});
</script>

<DesktopStartup app="Capture" {contract} site="https://capture.epicenter.so">
	{#snippet children(_settings, _device)}
		<p>Opened</p>
	{/snippet}
</DesktopStartup>
