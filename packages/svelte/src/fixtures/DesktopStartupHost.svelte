<script lang="ts">
	import { defineContract } from '@epicenter/definition/contract';
	import DesktopStartup from '../desktop-startup.svelte';

	const contract = defineContract({
		collections: {
			notes: { path: 'notes/{id}.md', fields: { title: { type: 'string' } } },
		},
	});
</script>

<DesktopStartup app="Capture" {contract} contractUrl="https://capture.epicenter.so/contract.json">
	{#snippet children(_settings, _device)}
		<p>Opened</p>
	{/snippet}
</DesktopStartup>
