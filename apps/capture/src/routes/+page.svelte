<script lang="ts">
	import { captureTables } from '@epicenter/capture';
	import { openFolder } from '@epicenter/folder';
	import OpenFolder from '@epicenter/svelte/open-folder';
	import CaptureApp from '$lib/components/CaptureApp.svelte';
</script>

<OpenFolder open={() => openFolder({ tables: captureTables })}>
	{#snippet children(folder)}
		<CaptureApp {folder} />
	{/snippet}
</OpenFolder>
